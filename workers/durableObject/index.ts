// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import { type BlockTarget, normalizeSenderAddress } from "../../shared/sender";
import { type BurnSettings, getBurnSettings } from "../lib/burn-settings";
import { getTelegramSettings, retireNotification } from "../lib/telegram";
import type { Env } from "../types";
import { applyMigrations, dropBurnAtIndex, mailboxMigrations } from "./migrations";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

interface GetEmailsOptions {
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	/** Burn-after-reading class of inbound mail (shared/burn.ts). */
	retention?: string | null;
}

/** Every row of a mailbox, as rebuildStorage backs it up to R2. */
interface MailboxBackup {
	folders: Record<string, SqlStorageValue>[];
	emails: Record<string, SqlStorageValue>[];
	attachments: Record<string, SqlStorageValue>[];
}

export interface MailboxRebuildResult {
	backupKey: string;
	folders: number;
	emails: number;
	attachments: number;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
		dropBurnAtIndex(this.ctx.storage.sql);
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						GROUP_CONCAT(DISTINCT sender) as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: full threading logic
		const result = this.ctx.storage.sql.exec(
			`WITH
			folder_emails AS (
				SELECT *,
					COALESCE(thread_id, id) as raw_thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
				FROM emails
				WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
			),
			thread_to_conversation AS (
				SELECT
					raw_thread_id,
					normalized_subject,
					CASE
						WHEN thread_id IS NOT NULL THEN raw_thread_id
						ELSE MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
					END as conversation_id
				FROM folder_emails
				GROUP BY raw_thread_id, normalized_subject, thread_id
			),
			all_emails_with_conversation AS (
				SELECT
					e.*,
					COALESCE(tc.conversation_id, COALESCE(e.thread_id, e.id)) as conversation_id
				FROM emails e
				LEFT JOIN thread_to_conversation tc
					ON COALESCE(e.thread_id, e.id) = tc.raw_thread_id
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					GROUP_CONCAT(DISTINCT sender) as participants,
					SUM(CASE WHEN folder_id = (SELECT id FROM folders WHERE name = 'draft' LIMIT 1) THEN 1 ELSE 0 END) as has_draft
				FROM all_emails_with_conversation
				WHERE conversation_id IN (
					SELECT DISTINCT conversation_id FROM all_emails_with_conversation
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM all_emails_with_conversation
			),
			latest_in_folder AS (
				SELECT
					fe.*,
					COALESCE(tc.conversation_id, fe.raw_thread_id) as conversation_id,
					ROW_NUMBER() OVER (
						PARTITION BY COALESCE(tc.conversation_id, fe.raw_thread_id)
						ORDER BY fe.date DESC
					) as rn
				FROM folder_emails fe
				LEFT JOIN thread_to_conversation tc
					ON fe.raw_thread_id = tc.raw_thread_id
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.recipient, lif.date,
				lif.read, lif.starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != (SELECT id FROM folders WHERE name = 'sent' LIMIT 1)
					AND lmc.folder_id != (SELECT id FROM folders WHERE name = 'draft' LIMIT 1)
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT
						COALESCE(thread_id, id) as raw_thread_id,
						thread_id,
					${NORMALIZED_SUBJECT_SQL} as normalized_subject
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				thread_to_conversation AS (
					SELECT
						raw_thread_id,
						CASE
							WHEN thread_id IS NOT NULL THEN raw_thread_id
							WHEN normalized_subject != '' THEN MIN(raw_thread_id) OVER (PARTITION BY normalized_subject)
							ELSE raw_thread_id
						END as conversation_id
					FROM folder_emails
					GROUP BY raw_thread_id, normalized_subject, thread_id
				)
				SELECT COUNT(DISTINCT conversation_id) as total
				FROM thread_to_conversation`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/**
	 * Fetch all emails in a thread with full bodies and attachments in
	 * two queries (one for emails, one for attachments) instead of
	 * N+1 individual getEmail calls.
	 */
	async getThreadEmails(threadId: string) {
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE thread_id = ?1 ORDER BY date ASC`,
				threadId,
			),
		] as any[];

		if (emailRows.length === 0) return [];

		const emailIds = emailRows.map((e) => e.id as string);

		// Batch-fetch all attachments for the thread in a single query
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		// Group attachments by email_id
		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();
		await this.syncBurns();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		await this.syncBurns();
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();

		return emailAttachments;
	}

	/**
	 * Deletes every email, folder and attachment of this mailbox: the R2
	 * attachment blobs first, then all Durable Object storage. The instance
	 * is reset afterwards so a later call starts from an empty, migrated DB.
	 */
	async purge(): Promise<{ attachments: number }> {
		const rows = this.db
			.select({
				id: schema.attachments.id,
				email_id: schema.attachments.email_id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.all();
		const keys = rows.map((r) => `attachments/${r.email_id}/${r.id}/${r.filename}`);
		for (let i = 0; i < keys.length; i += 1000) {
			await this.env.BUCKET.delete(keys.slice(i, i + 1000));
		}
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		setTimeout(() => this.ctx.abort("purged"), 0);
		return { attachments: keys.length };
	}

	/**
	 * Rebuild this mailbox's database from its own rows, for a mailbox whose
	 * queries fail with SQLITE_NOMEM although its rows still read fine with a
	 * plain table scan. Every row is read (emails NOT INDEXED, so no index is
	 * involved), the backup is written to R2 and checked, and only then is
	 * the storage wiped, the schema re-created by the migrations and the rows
	 * written back in one transaction. Attachment blobs in R2 are untouched.
	 * Everything is held in memory, so this is for small mailboxes.
	 */
	async rebuildStorage(backupKey: string): Promise<MailboxRebuildResult> {
		const sql = this.ctx.storage.sql;
		const backup: MailboxBackup = {
			folders: sql.exec(`SELECT * FROM folders`).toArray(),
			emails: sql.exec(`SELECT * FROM emails NOT INDEXED`).toArray(),
			attachments: sql.exec(`SELECT * FROM attachments NOT INDEXED`).toArray(),
		};
		const body = JSON.stringify(backup);
		await this.env.BUCKET.put(backupKey, body);
		const stored = await this.env.BUCKET.head(backupKey);
		if (!stored || stored.size !== new TextEncoder().encode(body).byteLength) {
			throw new Error(`Backup ${backupKey} did not land in R2; nothing was deleted`);
		}

		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		const result = await this.writeBackup(backup, backupKey);
		// Start the next call from a fresh instance on the rebuilt database.
		setTimeout(() => this.ctx.abort("rebuilt"), 0);
		return result;
	}

	/** Write a backup from rebuildStorage back, e.g. when a rebuild failed after the wipe. */
	async restoreFromBackup(backupKey: string): Promise<MailboxRebuildResult> {
		const obj = await this.env.BUCKET.get(backupKey);
		if (!obj) throw new Error(`Backup ${backupKey} not found`);
		const backup = (await obj.json()) as MailboxBackup;
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		const result = await this.writeBackup(backup, backupKey);
		setTimeout(() => this.ctx.abort("restored"), 0);
		return result;
	}

	/** Re-create the schema on an empty database and insert the backed-up rows. */
	private async writeBackup(backup: MailboxBackup, backupKey: string): Promise<MailboxRebuildResult> {
		const sql = this.ctx.storage.sql;
		applyMigrations(sql, mailboxMigrations, this.ctx.storage);
		const insert = (table: string, row: Record<string, SqlStorageValue>, verb = "INSERT") => {
			const columns = Object.keys(row);
			sql.exec(
				`${verb} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
				...columns.map((column) => row[column]),
			);
		};
		this.ctx.storage.transactionSync(() => {
			// The migrations already created the system folders.
			for (const row of backup.folders) insert("folders", row, "INSERT OR IGNORE");
			for (const row of backup.emails) insert("emails", row);
			for (const row of backup.attachments) insert("attachments", row);
		});
		const count = (table: string) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
		const result = {
			backupKey,
			folders: count("folders"),
			emails: count("emails"),
			attachments: count("attachments"),
		};
		if (result.emails !== backup.emails.length || result.attachments !== backup.attachments.length) {
			throw new Error(
				`Rebuilt ${result.emails}/${backup.emails.length} emails and ${result.attachments}/${backup.attachments.length} attachments; the backup is in R2 at ${backupKey}`,
			);
		}
		await this.syncBurns();
		return result;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();
		await this.syncBurns();

		return true;
	}

	/**
	 * Apply one action to many emails of a folder, for the list's bulk
	 * toolbar. `ids` are the rows the list showed (one per conversation), so
	 * each expands to every email of its conversation in the folder (drafts
	 * group by the email they reply to, as the list does); `all` takes every
	 * email in the folder instead. Marking read also covers the
	 * conversation's copies in other folders, since the unread dot counts
	 * them. Returns how many emails changed.
	 */
	async bulkAction(options: {
		folder: string;
		action: "read" | "unread" | "move" | "delete";
		ids?: string[];
		all?: boolean;
		targetFolder?: string;
	}): Promise<number> {
		const sql = this.ctx.storage.sql;
		const folderRow = [...sql.exec(`SELECT id FROM folders WHERE id = ?1 OR name = ?1 LIMIT 1`, options.folder)][0] as
			| { id: string }
			| undefined;
		if (!folderRow) return 0;
		const folderId = folderRow.id;

		let targets: string[];
		if (options.all) {
			targets = [...sql.exec(`SELECT id FROM emails WHERE folder_id = ?`, folderId)].map((r) => r.id as string);
		} else {
			const ids = JSON.stringify(options.ids ?? []);
			const groupColumn = folderId === Folders.DRAFT ? "in_reply_to" : "thread_id";
			targets = [
				...sql.exec(
					`SELECT id FROM emails
					 WHERE folder_id = ?1
					   AND (id IN (SELECT value FROM json_each(?2))
					     OR ${groupColumn} IN (
					       SELECT ${groupColumn} FROM emails
					       WHERE id IN (SELECT value FROM json_each(?2)) AND ${groupColumn} IS NOT NULL))`,
					folderId,
					ids,
				),
			].map((r) => r.id as string);
		}
		if (targets.length === 0) return 0;
		const targetJson = JSON.stringify(targets);

		switch (options.action) {
			case "read":
				sql.exec(
					`UPDATE emails SET read = 1
					 WHERE read = 0
					   AND (id IN (SELECT value FROM json_each(?1))
					     OR thread_id IN (
					       SELECT thread_id FROM emails
					       WHERE id IN (SELECT value FROM json_each(?1)) AND thread_id IS NOT NULL))`,
					targetJson,
				);
				break;
			case "unread":
				sql.exec(`UPDATE emails SET read = 0 WHERE id IN (SELECT value FROM json_each(?1))`, targetJson);
				break;
			case "move": {
				const target = options.targetFolder;
				if (!target || target === folderId) return 0;
				if ([...sql.exec(`SELECT id FROM folders WHERE id = ?`, target)].length === 0) return 0;
				sql.exec(`UPDATE emails SET folder_id = ?1 WHERE id IN (SELECT value FROM json_each(?2))`, target, targetJson);
				break;
			}
			case "delete":
				await this.deleteEmails(targets);
				break;
		}
		await this.syncBurns();
		return targets.length;
	}

	/** Delete emails for good, with their attachment blobs in R2. */
	private async deleteEmails(ids: string[]) {
		const sql = this.ctx.storage.sql;
		const idsJson = JSON.stringify(ids);
		const keys = [
			...sql.exec(
				`SELECT id, email_id, filename FROM attachments WHERE email_id IN (SELECT value FROM json_each(?1))`,
				idsJson,
			),
		].map((r) => `attachments/${r.email_id}/${r.id}/${r.filename}`);
		for (let i = 0; i < keys.length; i += 1000) {
			await this.env.BUCKET.delete(keys.slice(i, i + 1000));
		}
		sql.exec(`DELETE FROM attachments WHERE email_id IN (SELECT value FROM json_each(?1))`, idsJson);
		sql.exec(`DELETE FROM emails WHERE id IN (SELECT value FROM json_each(?1))`, idsJson);
	}

	/**
	 * Move every message from a sender into a folder, skipping sent/draft/trash
	 * so outbound copies stay put. Used by "report spam and block sender".
	 */
	async moveEmailsFromSender(sender: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return 0;

		const normalized = sender.trim().toLowerCase();
		if (!normalized) return 0;

		const cursor = this.ctx.storage.sql.exec(
			`UPDATE emails
			 SET folder_id = ?1
			 WHERE LOWER(sender) = ?2
			   AND folder_id NOT IN ('sent', 'draft', 'trash')`,
			folderId,
			normalized,
		);
		cursor.toArray();
		await this.syncBurns();
		return cursor.rowsWritten ?? 0;
	}

	/** Like moveEmailsFromSender, for every sender at `domain` or its subdomains. */
	async moveEmailsFromDomain(domain: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return 0;

		// Callers validate the domain, so it holds only [a-z0-9.-] and no LIKE wildcards.
		const normalized = domain.trim().toLowerCase();
		if (!/^[a-z0-9.-]+$/.test(normalized)) return 0;

		const cursor = this.ctx.storage.sql.exec(
			`UPDATE emails
			 SET folder_id = ?1
			 WHERE (LOWER(sender) LIKE ?2 OR LOWER(sender) LIKE ?3)
			   AND folder_id NOT IN ('sent', 'draft', 'trash')`,
			folderId,
			`%@${normalized}`,
			`%@%.${normalized}`,
		);
		cursor.toArray();
		await this.syncBurns();
		return cursor.rowsWritten ?? 0;
	}

	/** Whether this mailbox has ever sent mail to `address`: a known correspondent. */
	async hasSentTo(address: string) {
		const normalized = address.trim().toLowerCase();
		if (!normalized) return false;
		// instr narrows the scan; the exact check below stops "bob@x.com"
		// from matching a message sent to "jimbob@x.com".
		const rows = this.ctx.storage.sql
			.exec<{ recipient: string | null; cc: string | null }>(
				`SELECT recipient, cc FROM emails
				 WHERE folder_id = 'sent'
				   AND (instr(LOWER(recipient), ?1) > 0 OR instr(LOWER(COALESCE(cc, '')), ?1) > 0)
				 LIMIT 50`,
				normalized,
			)
			.toArray();
		const addresses = (list: string | null) => (list || "").split(/[,;]/).map(normalizeSenderAddress);
		return rows.some((row) => [...addresses(row.recipient), ...addresses(row.cc)].includes(normalized));
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
				retention: email.retention ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}

		// Replying to a conversation keeps all of it.
		if (isSent && email.thread_id) {
			this.ctx.storage.sql.exec(
				`UPDATE emails SET retention = 'keep', burn_at = NULL
				 WHERE thread_id = ?1 AND retention IN ('code', 'burn') AND burned_at IS NULL`,
				email.thread_id,
			);
		}
		await this.syncBurns();
	}

	// ── Burn after reading ─────────────────────────────────────────
	// Each email's deadline follows its state (rules in shared/burn.ts);
	// one alarm fires at the earliest deadline and when burned mail is due
	// to leave the trash for good.

	/** Bring burn deadlines in line with the emails' current state and re-arm the alarm. */
	async syncBurns(): Promise<void> {
		const sql = this.ctx.storage.sql;
		const involved = sql.exec(
			`SELECT 1 FROM emails
			 WHERE retention IN ('code', 'burn') OR burn_at IS NOT NULL OR burned_at IS NOT NULL LIMIT 1`,
		).toArray();
		if (involved.length === 0) return;
		const settings = await getBurnSettings(this.env.BUCKET);
		const now = Date.now();
		// Taken back out of the trash after burning: the user wants it after all.
		sql.exec(`UPDATE emails SET burned_at = NULL, retention = 'keep' WHERE burned_at IS NOT NULL AND folder_id != 'trash'`);
		// Starred, moved out of the inbox, kept, or a read-burn marked unread again.
		sql.exec(
			`UPDATE emails SET burn_at = NULL
			 WHERE burn_at IS NOT NULL
			   AND (starred = 1 OR folder_id != 'inbox' OR retention NOT IN ('code', 'burn')
			     OR (retention = 'burn' AND read = 0))`,
		);
		sql.exec(
			`UPDATE emails SET burn_at = ?1
			 WHERE burn_at IS NULL AND starred = 0 AND folder_id = 'inbox' AND retention = 'burn' AND read = 1`,
			new Date(now + settings.readHours * 3_600_000).toISOString(),
		);
		sql.exec(
			`UPDATE emails SET burn_at = ?1
			 WHERE burn_at IS NULL AND starred = 0 AND folder_id = 'inbox' AND retention = 'code'`,
			new Date(now + settings.codeMinutes * 60_000).toISOString(),
		);
		await this.armBurnAlarm(settings);
	}

	private async armBurnAlarm(settings: BurnSettings) {
		// Switched off: whatever alarm is set finds nothing to do; resyncBurns re-arms on switching back on.
		if (!settings.enabled) return;
		const sql = this.ctx.storage.sql;
		const nextBurn = sql.exec<{ at: string | null }>(`SELECT MIN(burn_at) AS at FROM emails`).one().at;
		const oldestBurned = sql.exec<{ at: string | null }>(
			`SELECT MIN(burned_at) AS at FROM emails WHERE folder_id = 'trash'`,
		).one().at;
		const times = [
			nextBurn ? Date.parse(nextBurn) : null,
			oldestBurned ? Date.parse(oldestBurned) + settings.purgeDays * 86_400_000 : null,
		].filter((t): t is number => t !== null);
		if (times.length === 0) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(Math.min(...times));
	}

	/** Burn what is due (to the trash, notification removed) and purge burned mail past its grace period. */
	async alarm(): Promise<void> {
		const settings = await getBurnSettings(this.env.BUCKET);
		if (!settings.enabled) return;
		const sql = this.ctx.storage.sql;
		const now = new Date();
		const due = sql.exec<{ id: string; telegram_message: string | null }>(
			`SELECT id, telegram_message FROM emails
			 WHERE burn_at IS NOT NULL AND burn_at <= ?1
			   AND folder_id = 'inbox' AND starred = 0 AND retention IN ('code', 'burn')`,
			now.toISOString(),
		).toArray();
		if (due.length > 0) {
			sql.exec(
				`UPDATE emails SET folder_id = 'trash', burn_at = NULL, burned_at = ?1
				 WHERE id IN (SELECT value FROM json_each(?2))`,
				now.toISOString(),
				JSON.stringify(due.map((row) => row.id)),
			);
			const telegram = await getTelegramSettings(this.env.BUCKET);
			for (const row of due) {
				if (row.telegram_message) await retireNotification(this.env.BUCKET, telegram, row.telegram_message);
			}
		}
		const expired = sql.exec<{ id: string }>(
			`SELECT id FROM emails WHERE folder_id = 'trash' AND burned_at IS NOT NULL AND burned_at <= ?1`,
			new Date(now.getTime() - settings.purgeDays * 86_400_000).toISOString(),
		).toArray();
		if (expired.length > 0) await this.deleteEmails(expired.map((row) => row.id));
		await this.armBurnAlarm(settings);
	}

	/** The sender or domain joined the keep list: none of their mail here burns any more. */
	async keepFrom(target: BlockTarget) {
		const sql = this.ctx.storage.sql;
		const pending = `retention IN ('code', 'burn') AND burned_at IS NULL`;
		if (target.type === "domain") {
			// parseBlockTarget only yields [a-z0-9.-] domains, so no LIKE wildcards.
			sql.exec(
				`UPDATE emails SET retention = 'keep', burn_at = NULL
				 WHERE ${pending} AND (LOWER(sender) LIKE ?1 OR LOWER(sender) LIKE ?2)`,
				`%@${target.value}`,
				`%@%.${target.value}`,
			);
		} else {
			sql.exec(
				`UPDATE emails SET retention = 'keep', burn_at = NULL WHERE ${pending} AND LOWER(sender) = ?1`,
				target.value,
			);
		}
		await this.syncBurns();
	}

	/** Remember the email's Telegram notification ("chatId:messageId") so burning can remove it. */
	async setTelegramMessage(id: string, telegramMessage: string) {
		this.ctx.storage.sql.exec(`UPDATE emails SET telegram_message = ?1 WHERE id = ?2`, telegramMessage, id);
	}
}
