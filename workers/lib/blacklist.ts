// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Folders } from "../../shared/folders";
import {
	type BlockTarget,
	domainMatches,
	isFreemailDomain,
	isValidEmailAddress,
	matchBlockRule,
	normalizeSenderAddress,
	parseBlockTarget,
	senderDomain,
} from "../../shared/sender";
import { getMailboxStub, listMailboxes } from "./email-helpers";
import type { Env } from "../types";

const SETTINGS_KEY = "settings/blacklist.json";
const TRUSTED_KEY = "settings/trusted-senders.json";
const MAX_TRUSTED = 1000;

export interface BlacklistEntry {
	/** A sender address, or a domain when `type` is "domain". */
	address: string;
	/** Missing on entries saved before domain blocking existed: those are addresses. */
	type?: "address" | "domain";
	createdAt: string;
	reason?: string;
	mailboxId?: string;
}

interface BlacklistStore {
	entries: BlacklistEntry[];
}

export { normalizeSenderAddress, isValidEmailAddress };

export async function getBlacklist(bucket: R2Bucket): Promise<BlacklistEntry[]> {
	const obj = await bucket.get(SETTINGS_KEY);
	if (!obj) return [];
	const stored = (await obj.json()) as Partial<BlacklistStore>;
	return Array.isArray(stored.entries) ? stored.entries : [];
}

async function saveBlacklist(bucket: R2Bucket, entries: BlacklistEntry[]): Promise<void> {
	await bucket.put(SETTINGS_KEY, JSON.stringify({ entries } satisfies BlacklistStore));
}

const sameTarget = (entry: BlacklistEntry, target: BlockTarget) =>
	entry.address === target.value && (entry.type ?? "address") === target.type;

/** The entry that blocks `sender`, by address or by domain. */
export async function findBlacklistMatch(bucket: R2Bucket, sender: string): Promise<BlacklistEntry | null> {
	return matchBlockRule(await getBlacklist(bucket), sender);
}

export async function isBlacklisted(bucket: R2Bucket, sender: string): Promise<boolean> {
	return Boolean(await findBlacklistMatch(bucket, sender));
}

async function ownMailboxHosts(bucket: R2Bucket): Promise<string[]> {
	return (await listMailboxes(bucket)).map((m) => senderDomain(m.id)).filter(Boolean);
}

function domainBlockReason(domain: string, ownHosts: string[]): string | null {
	if (isFreemailDomain(domain)) {
		return `${domain} 是公共邮箱，整域拉黑会挡掉所有用它的人，请只拉黑单个地址`;
	}
	if (ownHosts.some((host) => domainMatches(host, domain))) {
		return `${domain} 是你自己的邮箱域名，不能拉黑`;
	}
	return null;
}

/** Why `domain` must not be blocked as a whole, or null when it may be. */
export async function domainBlockError(bucket: R2Bucket, domain: string): Promise<string | null> {
	return domainBlockReason(domain, await ownMailboxHosts(bucket));
}

/** An input a bulk add could not take, with the reason shown next to it. */
export interface ListInputError {
	input: string;
	error: string;
}

/**
 * Block addresses (`spam@example.com`) or whole domains (`example.com` /
 * `@example.com`) in one write. Inputs that can't be blocked come back in
 * `errors`; the rest are in `added`.
 */
export async function addManyToBlacklist(
	bucket: R2Bucket,
	inputs: string[],
	meta: { reason?: string; mailboxId?: string } = {},
): Promise<{ entries: BlacklistEntry[]; added: BlockTarget[]; errors: ListInputError[] }> {
	const added: BlockTarget[] = [];
	const errors: ListInputError[] = [];
	let ownHosts: string[] | null = null;
	for (const input of inputs) {
		const target = parseBlockTarget(input);
		if (!target) {
			errors.push({ input, error: "请输入有效的邮箱地址或域名" });
			continue;
		}
		if (target.type === "domain") {
			ownHosts ??= await ownMailboxHosts(bucket);
			const error = domainBlockReason(target.value, ownHosts);
			if (error) {
				errors.push({ input, error });
				continue;
			}
		}
		if (!added.some((t) => t.type === target.type && t.value === target.value)) added.push(target);
	}
	const entries = await getBlacklist(bucket);
	if (added.length === 0) return { entries, added, errors };
	const createdAt = new Date().toISOString();
	const next: BlacklistEntry[] = [
		...added.map((target) => ({
			address: target.value,
			type: target.type,
			createdAt,
			reason: meta.reason,
			mailboxId: meta.mailboxId,
		})),
		...entries.filter((item) => !added.some((target) => sameTarget(item, target))),
	];
	await saveBlacklist(bucket, next);
	await untrustSenders(bucket, added);
	return { entries: next, added, errors };
}

/** Block one address or domain; throws with the reason when it can't be blocked. */
export async function addToBlacklist(
	bucket: R2Bucket,
	entry: { address: string; reason?: string; mailboxId?: string },
): Promise<BlacklistEntry[]> {
	const { entries, errors } = await addManyToBlacklist(bucket, [entry.address], entry);
	if (errors.length > 0) throw new Error(errors[0].error);
	return entries;
}

/** Remove entries; each key is an address or domain as stored. */
export async function removeManyFromBlacklist(bucket: R2Bucket, keys: string[]): Promise<BlacklistEntry[]> {
	const targets = keys.map((key) => parseBlockTarget(key));
	const raws = keys.map((key) => key.trim().toLowerCase());
	const entries = await getBlacklist(bucket);
	const next = entries.filter(
		(item) => !targets.some((target, i) => (target ? sameTarget(item, target) : item.address === raws[i])),
	);
	await saveBlacklist(bucket, next);
	return next;
}

/** Remove one entry; `key` is the address or domain as stored. */
export async function removeFromBlacklist(bucket: R2Bucket, key: string): Promise<BlacklistEntry[]> {
	return removeManyFromBlacklist(bucket, [key]);
}

/** Remove every entry that blocks `sender`, whether by address or by domain. */
export async function unblockSender(bucket: R2Bucket, sender: string): Promise<BlacklistEntry[]> {
	const entries = await getBlacklist(bucket);
	const removed = entries.filter((entry) => matchBlockRule([entry], sender));
	if (removed.length > 0) {
		await saveBlacklist(bucket, entries.filter((entry) => !removed.includes(entry)));
	}
	return removed;
}

/** Move mail already received from a newly blocked address or domain to Spam, in every mailbox. */
export async function moveBlockedToSpam(env: Env, target: BlockTarget): Promise<void> {
	const mailboxes = await listMailboxes(env.BUCKET);
	await Promise.all(
		mailboxes.map(async (mailbox) => {
			const stub = getMailboxStub(env, mailbox.id);
			if (target.type === "domain") await stub.moveEmailsFromDomain(target.value, Folders.SPAM);
			else await stub.moveEmailsFromSender(target.value, Folders.SPAM);
		}),
	);
}

// -- Trusted senders ------------------------------------------------------
//
// Marking an email "not spam" trusts its sender, so the spam filter stops
// second-guessing them. The blacklist still wins over trust.

export async function getTrustedSenders(bucket: R2Bucket): Promise<string[]> {
	const obj = await bucket.get(TRUSTED_KEY);
	if (!obj) return [];
	const stored = (await obj.json()) as { senders?: unknown };
	return Array.isArray(stored.senders) ? (stored.senders as string[]) : [];
}

export async function isTrustedSender(bucket: R2Bucket, sender: string): Promise<boolean> {
	const address = normalizeSenderAddress(sender);
	return Boolean(address) && (await getTrustedSenders(bucket)).includes(address);
}

export async function trustSender(bucket: R2Bucket, sender: string): Promise<void> {
	const address = normalizeSenderAddress(sender);
	if (!isValidEmailAddress(address)) return;
	const senders = await getTrustedSenders(bucket);
	const next = [address, ...senders.filter((s) => s !== address)].slice(0, MAX_TRUSTED);
	await bucket.put(TRUSTED_KEY, JSON.stringify({ senders: next }));
}

async function untrustSenders(bucket: R2Bucket, targets: BlockTarget[]): Promise<void> {
	const senders = await getTrustedSenders(bucket);
	const next = senders.filter(
		(s) =>
			!targets.some((target) =>
				target.type === "domain" ? domainMatches(senderDomain(s), target.value) : s === target.value,
			),
	);
	if (next.length !== senders.length) await bucket.put(TRUSTED_KEY, JSON.stringify({ senders: next }));
}

// -- Email actions ----------------------------------------------------------

export type BlockScope = "address" | "domain";

export async function reportEmailAsSpam(
	env: Env,
	mailboxId: string,
	emailId: string,
	scope: BlockScope = "address",
): Promise<
	| { status: "reported"; sender: string | null; blocked: boolean; domain?: string }
	| { error: string; status: number }
> {
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await env.BUCKET.head(key))) {
		return { error: "邮箱不存在", status: 404 };
	}

	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(emailId)) as { sender?: string } | null;
	if (!email) return { error: "邮件不存在", status: 404 };

	const sender = normalizeSenderAddress(email.sender || "");
	const usable = Boolean(sender && sender !== mailboxId.toLowerCase() && isValidEmailAddress(sender));

	if (scope === "domain") {
		const domain = senderDomain(sender);
		if (!usable || !domain) return { error: "发件人地址无效，无法拉黑域名", status: 400 };
		const error = await domainBlockError(env.BUCKET, domain);
		if (error) return { error, status: 400 };
		await addToBlacklist(env.BUCKET, { address: domain, reason: "spam", mailboxId });
		await moveBlockedToSpam(env, { type: "domain", value: domain });
		await stub.moveEmail(emailId, Folders.SPAM);
		return { status: "reported", sender, blocked: true, domain };
	}

	if (usable) {
		await addToBlacklist(env.BUCKET, { address: sender, reason: "spam", mailboxId });
		await moveBlockedToSpam(env, { type: "address", value: sender });
	}

	await stub.moveEmail(emailId, Folders.SPAM);
	return { status: "reported", sender: usable ? sender : null, blocked: usable };
}

/**
 * Move an email back to the inbox and trust its sender so the spam filter
 * leaves their future mail alone. `blockedBy` reports a blacklist entry that
 * will still send their mail to Spam.
 */
export async function markEmailNotSpam(
	env: Env,
	mailboxId: string,
	emailId: string,
): Promise<{ status: "moved"; trusted: string | null; blockedBy: BlacklistEntry | null } | { error: string; status: number }> {
	const stub = getMailboxStub(env, mailboxId);
	const email = (await stub.getEmail(emailId)) as { sender?: string } | null;
	if (!email) return { error: "邮件不存在", status: 404 };
	await stub.moveEmail(emailId, Folders.INBOX);

	const sender = normalizeSenderAddress(email.sender || "");
	const usable = Boolean(sender && sender !== mailboxId.toLowerCase() && isValidEmailAddress(sender));
	if (!usable) return { status: "moved", trusted: null, blockedBy: null };
	await trustSender(env.BUCKET, sender);
	return { status: "moved", trusted: sender, blockedBy: await findBlacklistMatch(env.BUCKET, sender) };
}
