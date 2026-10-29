// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Account-wide settings for burn after reading (see shared/burn.ts): the switch,
// the three durations, and the keep list of senders whose mail never burns.

import { type BlockTarget, matchBlockRule, parseBlockTarget } from "../../shared/sender";
import { BURN_TIME_LIMITS, type BurnTimes, DEFAULT_BURN_TIMES } from "../../shared/burn";
import { listMailboxes } from "./email-helpers";
import type { Env } from "../types";

const SETTINGS_KEY = "settings/burn.json";

export interface KeepEntry {
	/** A sender address, or a domain when `type` is "domain". */
	address: string;
	type: "address" | "domain";
	createdAt: string;
	/** Where it was added from; missing when typed into the list itself. */
	source?: "telegram" | "reader";
}

export interface BurnSettings extends BurnTimes {
	/** Off unless switched on in the web UI. */
	enabled: boolean;
	keep: KeepEntry[];
}

export async function getBurnSettings(bucket: R2Bucket): Promise<BurnSettings> {
	const obj = await bucket.get(SETTINGS_KEY);
	const stored = obj ? ((await obj.json()) as Partial<BurnSettings>) : {};
	return {
		...DEFAULT_BURN_TIMES,
		...stored,
		enabled: stored.enabled === true,
		keep: Array.isArray(stored.keep) ? stored.keep : [],
	};
}

async function saveBurnSettings(bucket: R2Bucket, settings: BurnSettings): Promise<BurnSettings> {
	await bucket.put(SETTINGS_KEY, JSON.stringify(settings));
	return settings;
}

export async function updateBurnSettings(
	bucket: R2Bucket,
	patch: Partial<Pick<BurnSettings, "enabled" | keyof BurnTimes>>,
): Promise<BurnSettings> {
	const next = await getBurnSettings(bucket);
	if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
	for (const key of Object.keys(BURN_TIME_LIMITS) as (keyof BurnTimes)[]) {
		const value = patch[key];
		if (value === undefined) continue;
		const { min, max } = BURN_TIME_LIMITS[key];
		if (!Number.isInteger(value) || value < min || value > max) {
			throw new Error(`时间需要是 ${min} 到 ${max} 之间的整数`);
		}
		next[key] = value;
	}
	return saveBurnSettings(bucket, next);
}

export function isKeptSender(settings: BurnSettings, sender: string): boolean {
	return Boolean(matchBlockRule(settings.keep, sender));
}

const sameEntry = (entry: KeepEntry, target: BlockTarget) => entry.address === target.value && entry.type === target.type;

/** Add addresses or domains in one write; unparsable inputs come back in `errors`. */
export async function addKeepEntries(
	bucket: R2Bucket,
	inputs: string[],
	source?: KeepEntry["source"],
): Promise<{ settings: BurnSettings; added: BlockTarget[]; errors: { input: string; error: string }[] }> {
	const added: BlockTarget[] = [];
	const errors: { input: string; error: string }[] = [];
	for (const input of inputs) {
		const target = parseBlockTarget(input);
		if (!target) errors.push({ input, error: "请输入有效的邮箱地址或域名" });
		else if (!added.some((t) => t.type === target.type && t.value === target.value)) added.push(target);
	}
	const settings = await getBurnSettings(bucket);
	if (added.length === 0) return { settings, added, errors };
	const createdAt = new Date().toISOString();
	settings.keep = [
		...added.map((target) => ({ address: target.value, type: target.type, createdAt, ...(source ? { source } : {}) })),
		...settings.keep.filter((entry) => !added.some((target) => sameEntry(entry, target))),
	];
	return { settings: await saveBurnSettings(bucket, settings), added, errors };
}

/** Add one address or domain; throws when it isn't one. */
export async function addKeepEntry(
	bucket: R2Bucket,
	input: string,
	source?: KeepEntry["source"],
): Promise<{ settings: BurnSettings; target: BlockTarget }> {
	const { settings, added, errors } = await addKeepEntries(bucket, [input], source);
	if (errors.length > 0) throw new Error(errors[0].error);
	return { settings, target: added[0] };
}

/** Remove entries; each key is an address or domain as stored. */
export async function removeKeepEntries(bucket: R2Bucket, keys: string[]): Promise<BurnSettings> {
	const targets = keys.map((key) => parseBlockTarget(key));
	const raws = keys.map((key) => key.trim().toLowerCase());
	const settings = await getBurnSettings(bucket);
	settings.keep = settings.keep.filter(
		(entry) => !targets.some((target, i) => (target ? sameEntry(entry, target) : entry.address === raws[i])),
	);
	return saveBurnSettings(bucket, settings);
}

/** A sender added to the keep list stops burning everywhere, including mail already scheduled. */
export async function keepMatchingMail(env: Env, target: BlockTarget): Promise<void> {
	const mailboxes = await listMailboxes(env.BUCKET);
	await Promise.all(
		mailboxes.map((mailbox) => env.MAILBOX.get(env.MAILBOX.idFromName(mailbox.id)).keepFrom(target)),
	);
}

/** After the switch or a duration changes, every mailbox re-arms its alarm. */
export async function resyncBurns(env: Env): Promise<void> {
	const mailboxes = await listMailboxes(env.BUCKET);
	await Promise.all(
		mailboxes.map((mailbox) => env.MAILBOX.get(env.MAILBOX.idFromName(mailbox.id)).syncBurns()),
	);
}
