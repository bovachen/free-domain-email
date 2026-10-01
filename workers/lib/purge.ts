// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Deleting mailboxes and everything stored for them. Domain removal runs in
// batches (the UI calls purgeDomainData until `done`) so a domain with many
// mailboxes or Telegram notifications stays within one request's limits.

import { getAgentByName } from "agents";
import type { Env } from "../types";
import { listMailboxes } from "./email-helpers";
import type { TelegramMessageRef } from "./telegram";

const MAILBOXES_PER_BATCH = 20;
const TELEGRAM_REFS_PER_BATCH = 200;
const TELEGRAM_REFS_PREFIX = "telegram/messages/";

/**
 * Removes a mailbox: its settings file (so it stops receiving mail at once),
 * the mailbox Durable Object (emails, folders, attachment blobs) and the AI
 * agent's Durable Object (chat history, scheduled work).
 */
export async function purgeMailbox(env: Env, mailboxId: string): Promise<void> {
	await env.BUCKET.delete(`mailboxes/${mailboxId}.json`);
	const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
	await mailbox.purge();
	// getAgentByName sets the agent's name; a plain stub would be rejected by the Agents SDK.
	const agent = await getAgentByName(env.EMAIL_AGENT, mailboxId);
	await agent.destroy();
}

export interface PurgeProgress {
	done: boolean;
	/** Pass back on the next call; null once mailboxes are done and Telegram refs start. */
	cursor: string | null;
	mailboxesDeleted: number;
	mailboxesRemaining: number;
	telegramRefsDeleted: number;
}

function belongsTo(domain: string, mailboxId: string): boolean {
	return mailboxId.toLowerCase().endsWith(`@${domain}`);
}

/** One batch of deleting a domain's mailboxes, then its Telegram notification refs. */
export async function purgeDomainData(env: Env, domain: string, cursor: string | null): Promise<PurgeProgress> {
	const d = domain.toLowerCase();
	const progress: PurgeProgress = {
		done: false,
		cursor,
		mailboxesDeleted: 0,
		mailboxesRemaining: 0,
		telegramRefsDeleted: 0,
	};

	// Phase 1: mailboxes. No cursor needed: each batch deletes what it lists.
	if (!cursor) {
		const boxes = (await listMailboxes(env.BUCKET)).filter((m) => belongsTo(d, m.id));
		const batch = boxes.slice(0, MAILBOXES_PER_BATCH);
		for (const box of batch) await purgeMailbox(env, box.id);
		progress.mailboxesDeleted = batch.length;
		progress.mailboxesRemaining = boxes.length - batch.length;
		if (progress.mailboxesRemaining > 0) return progress;
	}

	// Phase 2: Telegram notification refs pointing at the domain's mailboxes.
	const list = await env.BUCKET.list({
		prefix: TELEGRAM_REFS_PREFIX,
		limit: TELEGRAM_REFS_PER_BATCH,
		cursor: cursor ?? undefined,
	});
	const stale: string[] = [];
	for (const obj of list.objects) {
		const ref = await env.BUCKET.get(obj.key);
		if (!ref) continue;
		const { mailboxId } = (await ref.json()) as TelegramMessageRef;
		if (mailboxId && belongsTo(d, mailboxId)) stale.push(obj.key);
	}
	if (stale.length > 0) await env.BUCKET.delete(stale);
	progress.telegramRefsDeleted = stale.length;
	progress.done = !list.truncated;
	progress.cursor = list.truncated ? list.cursor : null;
	return progress;
}
