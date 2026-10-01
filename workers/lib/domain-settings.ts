// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";

const WILDCARD_KEY = "settings/wildcard.json";
const DOMAINS_KEY = "settings/domains.json";

export type WildcardSettings = Record<string, boolean>;

/**
 * Domain changes made in the web UI. `added` extends the DOMAINS var;
 * `removed` hides DOMAINS entries without a redeploy.
 */
interface DomainOverrides {
	added: string[];
	removed: string[];
}

function envDomains(env: Env): string[] {
	return (env.DOMAINS || "")
		.split(",")
		.map((d) => d.trim().toLowerCase())
		.filter(Boolean);
}

async function getOverrides(env: Env): Promise<DomainOverrides> {
	const obj = await env.BUCKET.get(DOMAINS_KEY);
	const stored = obj ? ((await obj.json()) as Partial<DomainOverrides>) : {};
	return { added: stored.added ?? [], removed: stored.removed ?? [] };
}

export async function addDomain(env: Env, domain: string): Promise<void> {
	const d = domain.trim().toLowerCase();
	const { added, removed } = await getOverrides(env);
	const next: DomainOverrides = {
		added: envDomains(env).includes(d) || added.includes(d) ? added : [...added, d],
		removed: removed.filter((r) => r !== d),
	};
	await env.BUCKET.put(DOMAINS_KEY, JSON.stringify(next));
}

/** Stops accepting mail for the domain and drops its wildcard setting. */
export async function removeDomain(env: Env, domain: string): Promise<void> {
	const d = domain.trim().toLowerCase();
	const { added, removed } = await getOverrides(env);
	const next: DomainOverrides = {
		added: added.filter((a) => a !== d),
		removed: envDomains(env).includes(d) && !removed.includes(d) ? [...removed, d] : removed,
	};
	await env.BUCKET.put(DOMAINS_KEY, JSON.stringify(next));

	const obj = await env.BUCKET.get(WILDCARD_KEY);
	if (obj) {
		const stored = (await obj.json()) as WildcardSettings;
		delete stored[d];
		await env.BUCKET.put(WILDCARD_KEY, JSON.stringify(stored));
	}
}

/** DOMAINS var plus domains added from the web UI, minus those removed there. */
export async function configuredDomains(env: Env): Promise<string[]> {
	const { added, removed } = await getOverrides(env);
	const fromEnv = envDomains(env).filter((d) => !removed.includes(d));
	return [...fromEnv, ...added.filter((d) => !fromEnv.includes(d))];
}

export async function getWildcardSettings(env: Env): Promise<WildcardSettings> {
	const domains = await configuredDomains(env);
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
	const domains = new Set(await configuredDomains(env));
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
	const settings = await getWildcardSettings(env);
	return d in settings && settings[d] !== false;
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
