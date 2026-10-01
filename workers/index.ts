// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import {
	configuredDomains,
	ensureMailbox,
	getWildcardSettings,
	isWildcardEnabled,
	removeDomain,
	setWildcardSettings,
} from "./lib/domain-settings";
import {
	getCloudflareSettings,
	listAvailableZones,
	MxConflictError,
	saveCloudflareToken,
	setupDomain,
	teardownDomain,
} from "./lib/domain-setup";
import { purgeDomainData, purgeMailbox } from "./lib/purge";
import {
	addToBlacklist,
	getBlacklist,
	isBlacklisted,
	moveSenderToSpam,
	removeFromBlacklist,
	reportEmailAsSpam,
} from "./lib/blacklist";
import {
	discoverTelegramChatId,
	getTelegramSettings,
	notifyNewEmail,
	registerTelegramWebhook,
	sendTelegramTest,
	setTelegramSettings,
	TELEGRAM_WEBHOOK_PATH,
	toPublicTelegramSettings,
	unregisterTelegramWebhook,
} from "./lib/telegram";
import { getPollHeartbeat, handleTelegramUpdate, type TelegramUpdate } from "./lib/telegram-webhook";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for input without letters or digits
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]+/gu, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", async (c) => {
	const domains = await configuredDomains(c.env);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	const wildcard = await getWildcardSettings(c.env);
	return c.json({ domains, emailAddresses, wildcard });
});

app.get("/api/v1/settings/wildcard", async (c) => {
	return c.json(await getWildcardSettings(c.env));
});

app.put("/api/v1/settings/wildcard", async (c) => {
	const body = (await c.req.json()) as Record<string, boolean>;
	return c.json(await setWildcardSettings(c.env, body));
});

app.get("/api/v1/settings/cloudflare", async (c) => {
	return c.json({ ...(await getCloudflareSettings(c.env)), resendConfigured: Boolean(c.env.RESEND_API_KEY) });
});

app.put("/api/v1/settings/cloudflare", async (c) => {
	const body = (await c.req.json()) as { apiToken?: string };
	try {
		const saved = await saveCloudflareToken(c.env, body.apiToken || "");
		return c.json({ ...saved, resendConfigured: Boolean(c.env.RESEND_API_KEY) });
	} catch (e) {
		return c.json({ error: (e as Error).message }, 400);
	}
});

app.get("/api/v1/domains/available", async (c) => {
	try {
		return c.json({ zones: await listAvailableZones(c.env) });
	} catch (e) {
		return c.json({ error: (e as Error).message }, 400);
	}
});

app.post("/api/v1/domains", async (c) => {
	const body = (await c.req.json()) as { zoneId?: string; replaceMx?: boolean; resend?: boolean };
	if (!body.zoneId) return c.json({ error: "缺少 zoneId" }, 400);
	try {
		return c.json(await setupDomain(c.env, {
			zoneId: body.zoneId,
			replaceMx: body.replaceMx === true,
			resend: body.resend === true,
		}));
	} catch (e) {
		if (e instanceof MxConflictError) {
			return c.json({ error: e.message, mxConflicts: e.records }, 409);
		}
		return c.json({ error: (e as Error).message }, 400);
	}
});

// Step 1 of removal: stop accepting the domain's mail and, if asked, undo
// the Cloudflare / Resend setup. The UI then calls /purge until done.
app.post("/api/v1/domains/:domain/remove", async (c) => {
	const domain = c.req.param("domain").toLowerCase();
	const body = (await c.req.json().catch(() => ({}))) as { cloudflare?: boolean; resend?: boolean };
	if (!(await configuredDomains(c.env)).includes(domain)) return c.json({ error: "域名列表里没有这个域名" }, 404);
	await removeDomain(c.env, domain);
	const steps = [
		{ step: "移出域名列表", ok: true, message: "不再接收这个域名的邮件" },
		...(await teardownDomain(c.env, domain, { cloudflare: body.cloudflare === true, resend: body.resend === true })),
	];
	return c.json({ domain, steps });
});

// Step 2 of removal, in batches: mailboxes (emails, attachments, AI chat) and Telegram refs.
app.post("/api/v1/domains/:domain/purge", async (c) => {
	const domain = c.req.param("domain").toLowerCase();
	const body = (await c.req.json().catch(() => ({}))) as { cursor?: string | null };
	if ((await configuredDomains(c.env)).includes(domain)) {
		return c.json({ error: "请先移除域名，再清理数据" }, 409);
	}
	try {
		return c.json(await purgeDomainData(c.env, domain, body.cursor ?? null));
	} catch (e) {
		return c.json({ error: (e as Error).message }, 500);
	}
});

app.get("/api/v1/settings/telegram", async (c) => {
	const [settings, heartbeat] = await Promise.all([
		getTelegramSettings(c.env.BUCKET),
		getPollHeartbeat(c.env.BUCKET),
	]);
	// Until an Inbox URL is saved, show the origin serving this UI as the default.
	const inboxBaseUrl = settings.inboxBaseUrl || new URL(c.req.url).origin;
	return c.json(toPublicTelegramSettings({ ...settings, inboxBaseUrl }, heartbeat));
});

app.put("/api/v1/settings/telegram", async (c) => {
	const body = (await c.req.json()) as {
		enabled?: boolean;
		botToken?: string;
		chatId?: string;
		inboxBaseUrl?: string;
		polling?: boolean;
	};
	const current = await getTelegramSettings(c.env.BUCKET);
	// Whitelist fields: webhookSecret is only ever set by webhook registration.
	const saved = await setTelegramSettings(c.env.BUCKET, {
		enabled: body.enabled,
		botToken: body.botToken,
		chatId: body.chatId,
		// Alert links and the webhook need an absolute URL; default to the origin serving this UI.
		inboxBaseUrl: body.inboxBaseUrl || (current.inboxBaseUrl ? undefined : new URL(c.req.url).origin),
		polling: body.polling,
	});
	return c.json(toPublicTelegramSettings(saved));
});

app.post("/api/v1/settings/telegram/discover", async (c) => {
	const settings = await getTelegramSettings(c.env.BUCKET);
	if (!settings.botToken) return c.json({ error: "请先保存 Bot Token" }, 400);
	if (settings.webhookSecret || settings.polling) {
		return c.json({ error: "机器人已经在接收消息（Webhook 或轮询）。直接给机器人发送 /start，Chat ID 会自动保存。" }, 400);
	}
	try {
		const chatId = await discoverTelegramChatId(settings.botToken);
		if (!chatId) {
			return c.json({ error: "还没有对话。请在 Telegram 里打开机器人并发送 /start，然后重试。" }, 404);
		}
		const saved = await setTelegramSettings(c.env.BUCKET, { chatId });
		return c.json(toPublicTelegramSettings(saved));
	} catch (e) {
		return c.json({ error: (e as Error).message }, 400);
	}
});

app.post("/api/v1/settings/telegram/test", async (c) => {
	const settings = await getTelegramSettings(c.env.BUCKET);
	try {
		await sendTelegramTest(settings);
		return c.json({ ok: true });
	} catch (e) {
		return c.json({ error: (e as Error).message }, 400);
	}
});

app.post("/api/v1/settings/telegram/webhook", async (c) => {
	try {
		const saved = await registerTelegramWebhook(c.env.BUCKET);
		return c.json(toPublicTelegramSettings(saved));
	} catch (e) {
		return c.json({ error: (e as Error).message }, 400);
	}
});

app.delete("/api/v1/settings/telegram/webhook", async (c) => {
	try {
		const saved = await unregisterTelegramWebhook(c.env.BUCKET);
		return c.json(toPublicTelegramSettings(saved));
	} catch (e) {
		return c.json({ error: (e as Error).message }, 400);
	}
});

// Telegram calls this directly (no Access session). Authenticated by the
// secret token Telegram echoes back from setWebhook; app.ts exempts the
// path from the Access JWT check for that reason.
app.post(TELEGRAM_WEBHOOK_PATH, async (c) => {
	const settings = await getTelegramSettings(c.env.BUCKET);
	const presented = c.req.header("x-telegram-bot-api-secret-token") || "";
	if (!settings.webhookSecret || presented !== settings.webhookSecret) {
		return c.text("Forbidden", 403);
	}
	let update: TelegramUpdate;
	try {
		update = (await c.req.json()) as TelegramUpdate;
	} catch {
		return c.text("Bad Request", 400);
	}
	await handleTelegramUpdate(c.env, update);
	return c.json({ ok: true });
});

app.get("/api/v1/settings/blacklist", async (c) => {
	return c.json({ entries: await getBlacklist(c.env.BUCKET) });
});

app.post("/api/v1/settings/blacklist", async (c) => {
	const body = (await c.req.json()) as { address?: string };
	try {
		const entries = await addToBlacklist(c.env.BUCKET, { address: body.address || "" });
		c.executionCtx.waitUntil(
			moveSenderToSpam(c.env, body.address || "").catch((e) =>
				console.error("Failed to move blacklisted sender to spam:", (e as Error).message),
			),
		);
		return c.json({ entries });
	} catch (e) {
		return c.json({ error: (e as Error).message }, 400);
	}
});

app.delete("/api/v1/settings/blacklist", async (c) => {
	const body = (await c.req.json()) as { address?: string };
	if (!body.address) return c.json({ error: "缺少邮箱地址" }, 400);
	const entries = await removeFromBlacklist(c.env.BUCKET, body.address);
	return c.json({ entries });
});

app.get("/api/v1/unified/folders", async (c) => {
	const mailboxes = await listMailboxes(c.env.BUCKET);
	const totals: Record<string, number> = {};
	await Promise.all(
		mailboxes.map(async (m) => {
			const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(m.id));
			const folders = await stub.getFolders();
			for (const folder of folders as { id: string; unreadCount: number }[]) {
				totals[folder.id] = (totals[folder.id] || 0) + (folder.unreadCount || 0);
			}
		}),
	);
	return c.json({ unread: totals, mailboxCount: mailboxes.length });
});

app.get("/api/v1/unified/emails", async (c) => {
	const folder = c.req.query("folder") || "inbox";
	const page = intQuery(c, "page") || 1;
	const limit = Math.min(intQuery(c, "limit") || 25, 100);
	const mailboxes = await listMailboxes(c.env.BUCKET);
	const perBox = Math.min(Math.max(limit * page, limit), 100);

	const batches = await Promise.all(
		mailboxes.map(async (m) => {
			const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(m.id));
			const emails = await (stub as any).getThreadedEmails({ folder, page: 1, limit: perBox });
			const totalCount = await (stub as any).countThreadedEmails(folder);
			return {
				totalCount: Number(totalCount) || 0,
				emails: (Array.isArray(emails) ? emails : []).map((email: Record<string, unknown>): Record<string, unknown> => ({
					...email,
					mailbox_id: m.id,
				})),
			};
		}),
	);

	const totalCount = batches.reduce((sum, b) => sum + b.totalCount, 0);
	const merged = batches
		.flatMap((b) => b.emails)
		.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
	const start = (page - 1) * limit;
	return c.json({ emails: merged.slice(start, start + limit), totalCount });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "只能创建 EMAIL_ADDRESSES 中配置的邮箱" }, 403);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "邮箱已存在" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "未找到" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "未找到" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "未找到" }, 404);
	await purgeMailbox(c.env, mailboxId);
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "邮件不存在" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "邮件不存在" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "未找到" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "文件夹不存在" }, 400);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/spam", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const emailId = c.req.param("id")!;
	const result = await reportEmailAsSpam(c.env, mailboxId, emailId);
	if ("error" in result) {
		return c.json({ error: result.error }, result.status as 400 | 404);
	}
	return c.json(result);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "文件夹名称需要包含文字或数字" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "已有同名文件夹" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "文件夹不存在" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "文件夹不存在或不能删除" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "附件不存在" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "附件文件不存在" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allowedAddresses = ((env.EMAIL_ADDRESSES ?? []) as string[]).map((a) => a.toLowerCase());
	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	const domains = await configuredDomains(env);
	const domainRecipients = allRecipients.filter((addr) => {
		const domain = addr.split("@")[1];
		return domain && domains.includes(domain);
	});
	const candidates = domainRecipients.length > 0 ? domainRecipients : allRecipients;

	let mailboxId: string | undefined;
	if (allowedAddresses.length > 0) {
		mailboxId = candidates.find((addr) => allowedAddresses.includes(addr));
		if (!mailboxId) { console.log(`Ignoring email: no recipient matches EMAIL_ADDRESSES.`); return; }
	} else {
		for (const addr of candidates) {
			if (await env.BUCKET.head(`mailboxes/${addr}.json`)) {
				mailboxId = addr;
				break;
			}
		}
		if (!mailboxId) {
			for (const addr of candidates) {
				const domain = addr.split("@")[1];
				if (domain && (await isWildcardEnabled(env, domain))) {
					mailboxId = addr;
					await ensureMailbox(env, addr);
					break;
				}
			}
		}
	}
	if (!mailboxId) {
		console.log("Ignoring email: no matching mailbox and catch-all is off for the recipient domain.");
		return;
	}

	const messageId = crypto.randomUUID();
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	const senderAddress = (parsedEmail.from?.address || "").toLowerCase();
	const blockedSender = senderAddress ? await isBlacklisted(env.BUCKET, senderAddress) : false;
	const inboundFolder = blockedSender ? Folders.SPAM : Folders.INBOX;

	await stub.createEmail(inboundFolder, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: senderAddress, recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);

	if (blockedSender) {
		console.log(`Blacklisted sender ${senderAddress} delivered to spam for ${mailboxId}`);
		return;
	}

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, emailId: messageId, sender: senderAddress, subject: parsedEmail.subject || "", threadId }),
	})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));

	ctx.waitUntil(notifyNewEmail(env.BUCKET, {
		mailboxId,
		emailId: messageId,
		sender: parsedEmail.from?.address || "",
		subject: parsedEmail.subject || "",
		body: parsedEmail.text || parsedEmail.html || "",
		attachmentCount: attachmentData.length,
	}).catch((e) => console.error("Telegram notify failed:", (e as Error).message)));
}

export { app, receiveEmail };
