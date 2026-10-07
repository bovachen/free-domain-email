// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";

const AUTO_DRAFT_KEY = "settings/auto-draft.json";

/** Account-wide switch for AI auto-drafts of new mail. */
export interface AutoDraftSettings {
	enabled: boolean;
}

/** On unless switched off in the web UI. */
export async function getAutoDraftSettings(env: Env): Promise<AutoDraftSettings> {
	const obj = await env.BUCKET.get(AUTO_DRAFT_KEY);
	const stored = obj ? ((await obj.json()) as Partial<AutoDraftSettings>) : {};
	return { enabled: stored.enabled !== false };
}

export async function setAutoDraftSettings(
	env: Env,
	patch: Partial<AutoDraftSettings>,
): Promise<AutoDraftSettings> {
	const next = await getAutoDraftSettings(env);
	if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
	await env.BUCKET.put(AUTO_DRAFT_KEY, JSON.stringify(next));
	return next;
}

/** A mailbox drafts unless its own settings switch it off. */
export function mailboxAllowsAutoDraft(settings: unknown): boolean {
	const autoDraft = (settings as { autoDraft?: { enabled?: unknown } } | null | undefined)?.autoDraft;
	return autoDraft?.enabled !== false;
}

/** New mail gets a draft only when both the account-wide and the mailbox switch are on. */
export async function autoDraftEnabled(env: Env, mailboxId: string): Promise<boolean> {
	if (!(await getAutoDraftSettings(env)).enabled) return false;
	const obj = await env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	return mailboxAllowsAutoDraft(obj ? await obj.json() : null);
}
