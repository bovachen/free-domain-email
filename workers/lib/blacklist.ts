// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Folders } from "../../shared/folders";
import { isValidEmailAddress, normalizeSenderAddress } from "../../shared/sender";
import { listMailboxes } from "./email-helpers";
import type { Env } from "../types";

const SETTINGS_KEY = "settings/blacklist.json";

export interface BlacklistEntry {
	address: string;
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

export async function isBlacklisted(bucket: R2Bucket, sender: string): Promise<boolean> {
	const address = normalizeSenderAddress(sender);
	if (!address) return false;
	const entries = await getBlacklist(bucket);
	return entries.some((entry) => entry.address === address);
}

export async function addToBlacklist(
	bucket: R2Bucket,
	entry: { address: string; reason?: string; mailboxId?: string },
): Promise<BlacklistEntry[]> {
	const address = normalizeSenderAddress(entry.address);
	if (!isValidEmailAddress(address)) {
		throw new Error("Invalid email address");
	}
	const entries = await getBlacklist(bucket);
	const next = entries.filter((item) => item.address !== address);
	next.unshift({
		address,
		createdAt: new Date().toISOString(),
		reason: entry.reason,
		mailboxId: entry.mailboxId,
	});
	await bucket.put(SETTINGS_KEY, JSON.stringify({ entries: next } satisfies BlacklistStore));
	return next;
}

export async function removeFromBlacklist(
	bucket: R2Bucket,
	address: string,
): Promise<BlacklistEntry[]> {
	const normalized = normalizeSenderAddress(address);
	const entries = await getBlacklist(bucket);
	const next = entries.filter((item) => item.address !== normalized);
	await bucket.put(SETTINGS_KEY, JSON.stringify({ entries: next } satisfies BlacklistStore));
	return next;
}

export async function moveSenderToSpam(env: Env, address: string): Promise<void> {
	const sender = normalizeSenderAddress(address);
	if (!sender) return;
	const mailboxes = await listMailboxes(env.BUCKET);
	await Promise.all(
		mailboxes.map(async (mailbox) => {
			const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox.id));
			await stub.moveEmailsFromSender(sender, Folders.SPAM);
		}),
	);
}

export async function reportEmailAsSpam(
	env: Env,
	mailboxId: string,
	emailId: string,
): Promise<
	| { status: "reported"; sender: string | null; blocked: boolean }
	| { error: string; status: number }
> {
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await env.BUCKET.head(key))) {
		return { error: "Mailbox not found", status: 404 };
	}

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	const email = (await stub.getEmail(emailId)) as { sender?: string } | null;
	if (!email) return { error: "Email not found", status: 404 };

	const sender = normalizeSenderAddress(email.sender || "");
	const blocked = Boolean(sender && sender !== mailboxId.toLowerCase() && isValidEmailAddress(sender));

	if (blocked) {
		await addToBlacklist(env.BUCKET, {
			address: sender,
			reason: "spam",
			mailboxId,
		});
		await moveSenderToSpam(env, sender);
	}

	await stub.moveEmail(emailId, Folders.SPAM);
	return { status: "reported", sender: blocked ? sender : null, blocked };
}
