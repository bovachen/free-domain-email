// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";

const WILDCARD_KEY = "settings/wildcard.json";

export type WildcardSettings = Record<string, boolean>;

export function configuredDomains(env: Env): string[] {
	return (env.DOMAINS || "")
		.split(",")
		.map((d) => d.trim().toLowerCase())
		.filter(Boolean);
}

export async function getWildcardSettings(env: Env): Promise<WildcardSettings> {
	const domains = configuredDomains(env);
	const obj = await env.BUCKET.get(WILDCARD_KEY);
	const stored = obj ? ((await obj.json()) as WildcardSettings) : {};
	const result: WildcardSettings = {};
	for (const domain of domains) {
		result[domain] = stored[domain] !== false;
	}
	return result;
}

export async function setWildcardSettings(
	env: Env,
	patch: WildcardSettings,
): Promise<WildcardSettings> {
	const current = await getWildcardSettings(env);
	const domains = new Set(configuredDomains(env));
	for (const [domain, enabled] of Object.entries(patch)) {
		const key = domain.trim().toLowerCase();
		if (!domains.has(key)) continue;
		current[key] = Boolean(enabled);
	}
	await env.BUCKET.put(WILDCARD_KEY, JSON.stringify(current));
	return current;
}

export async function isWildcardEnabled(env: Env, domain: string): Promise<boolean> {
	const d = domain.toLowerCase();
	if (!configuredDomains(env).includes(d)) return false;
	const settings = await getWildcardSettings(env);
	return settings[d] !== false;
}

export async function ensureMailbox(env: Env, email: string): Promise<void> {
	const mailboxId = email.toLowerCase();
	const key = `mailboxes/${mailboxId}.json`;
	if (await env.BUCKET.head(key)) return;
	const local = mailboxId.split("@")[0] || mailboxId;
	const defaultSettings = {
		fromName: local,
		forwarding: { enabled: false, email: "" },
		signature: { enabled: false, text: "" },
		autoReply: { enabled: false, subject: "", message: "" },
	};
	await env.BUCKET.put(key, JSON.stringify(defaultSettings));
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await stub.getFolders();
}
