// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

const SETTINGS_KEY = "settings/telegram.json";

export interface TelegramSettings {
	enabled: boolean;
	botToken: string;
	chatId: string;
	inboxBaseUrl: string;
	/** Secret sent by Telegram in X-Telegram-Bot-Api-Secret-Token once a webhook is registered. */
	webhookSecret: string;
	/**
	 * Pull updates with getUpdates from the cron trigger when no webhook is
	 * registered. Needs no inbound route, so it works behind Cloudflare Access
	 * without any bypass rule.
	 */
	polling: boolean;
}

export interface TelegramPublicSettings {
	enabled: boolean;
	botTokenConfigured: boolean;
	chatId: string;
	inboxBaseUrl: string;
	webhookConfigured: boolean;
	webhookUrl: string;
	polling: boolean;
	/** How button taps and replies reach the Worker. */
	mode: "webhook" | "polling" | "link";
	/** Last cron poll (ISO time) and its error, if any. */
	lastPollAt?: string;
	lastPollError?: string;
}

export const TELEGRAM_WEBHOOK_PATH = "/api/telegram/webhook";

const DEFAULTS: TelegramSettings = {
	enabled: false,
	botToken: "",
	chatId: "",
	// Filled from the request origin on first save (see workers/index.ts).
	inboxBaseUrl: "",
	webhookSecret: "",
	polling: true,
};

/** True when taps and replies can reach the Worker (webhook or cron polling). */
export function isTelegramInteractive(
	settings: Pick<TelegramSettings, "webhookSecret" | "polling">,
): boolean {
	return Boolean(settings.webhookSecret) || settings.polling;
}

export function telegramMode(settings: TelegramSettings): TelegramPublicSettings["mode"] {
	if (settings.webhookSecret) return "webhook";
	return settings.polling ? "polling" : "link";
}

/** Where Telegram is told to deliver updates for the current inbox URL. */
export function telegramWebhookUrl(settings: Pick<TelegramSettings, "inboxBaseUrl">): string {
	return `${settings.inboxBaseUrl.replace(/\/$/, "")}${TELEGRAM_WEBHOOK_PATH}`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function previewText(htmlOrText: string, max = 280): string {
	const plain = htmlOrText
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/\s+/g, " ")
		.trim();
	if (plain.length <= max) return plain;
	return `${plain.slice(0, max).trim()}…`;
}

export async function getTelegramSettings(bucket: R2Bucket): Promise<TelegramSettings> {
	const obj = await bucket.get(SETTINGS_KEY);
	if (!obj) return { ...DEFAULTS };
	const stored = (await obj.json()) as Partial<TelegramSettings>;
	return { ...DEFAULTS, ...stored };
}

export function toPublicTelegramSettings(
	settings: TelegramSettings,
	heartbeat?: { lastRunAt: string; error?: string } | null,
): TelegramPublicSettings {
	return {
		enabled: settings.enabled,
		botTokenConfigured: Boolean(settings.botToken),
		chatId: settings.chatId,
		inboxBaseUrl: settings.inboxBaseUrl,
		webhookConfigured: Boolean(settings.webhookSecret),
		webhookUrl: telegramWebhookUrl(settings),
		polling: settings.polling,
		mode: telegramMode(settings),
		...(heartbeat ? { lastPollAt: heartbeat.lastRunAt, lastPollError: heartbeat.error } : {}),
	};
}

export async function setTelegramSettings(
	bucket: R2Bucket,
	patch: Partial<TelegramSettings>,
): Promise<TelegramSettings> {
	const current = await getTelegramSettings(bucket);
	const next: TelegramSettings = {
		enabled: patch.enabled ?? current.enabled,
		botToken: patch.botToken !== undefined && patch.botToken !== "" ? patch.botToken.trim() : current.botToken,
		chatId: patch.chatId !== undefined ? String(patch.chatId).trim() : current.chatId,
		inboxBaseUrl: patch.inboxBaseUrl !== undefined && patch.inboxBaseUrl !== ""
			? patch.inboxBaseUrl.replace(/\/$/, "")
			: current.inboxBaseUrl,
		webhookSecret: patch.webhookSecret !== undefined ? patch.webhookSecret : current.webhookSecret,
		polling: patch.polling ?? current.polling,
	};
	await bucket.put(SETTINGS_KEY, JSON.stringify(next));
	return next;
}

export async function telegramApi(token: string, method: string, body: unknown) {
	const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
	if (!json.ok) {
		throw new Error(json.description || `Telegram ${method} failed`);
	}
	return json.result;
}

export async function discoverTelegramChatId(token: string): Promise<string | null> {
	// getUpdates is rejected (409) while a webhook is registered; the webhook
	// handler saves the chat ID itself when it sees /start.
	const result = (await telegramApi(token, "getUpdates", { timeout: 0, limit: 20 })) as {
		message?: { chat?: { id?: number | string } };
		edited_message?: { chat?: { id?: number | string } };
		my_chat_member?: { chat?: { id?: number | string } };
		channel_post?: { chat?: { id?: number | string } };
	}[];
	for (let i = result.length - 1; i >= 0; i--) {
		const update = result[i];
		const id =
			update?.message?.chat?.id ??
			update?.edited_message?.chat?.id ??
			update?.my_chat_member?.chat?.id ??
			update?.channel_post?.chat?.id;
		if (id != null) return String(id);
	}
	return null;
}

export async function sendTelegramTest(settings: TelegramSettings): Promise<void> {
	if (!settings.botToken || !settings.chatId) {
		throw new Error("需要先填写 Bot Token 和 Chat ID");
	}
	await telegramApi(settings.botToken, "sendMessage", {
		chat_id: settings.chatId,
		text: "Agentic Inbox 通知已接通。之后有新邮件会发到这里。",
	});
}

// -- Webhook registration -------------------------------------------

function randomSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Point the bot's webhook at this deployment so button taps and replies
 * reach the Worker without opening a browser. Generates the shared secret
 * on first use; Telegram echoes it back on every update.
 */
export async function registerTelegramWebhook(bucket: R2Bucket): Promise<TelegramSettings> {
	const settings = await getTelegramSettings(bucket);
	if (!settings.botToken) throw new Error("请先保存 Bot Token");
	const secret = settings.webhookSecret || randomSecret();
	await telegramApi(settings.botToken, "setWebhook", {
		url: telegramWebhookUrl(settings),
		secret_token: secret,
		allowed_updates: ["message", "callback_query"],
		drop_pending_updates: true,
	});
	return setTelegramSettings(bucket, { webhookSecret: secret });
}

export async function unregisterTelegramWebhook(bucket: R2Bucket): Promise<TelegramSettings> {
	const settings = await getTelegramSettings(bucket);
	if (settings.botToken) {
		await telegramApi(settings.botToken, "deleteWebhook", { drop_pending_updates: false });
	}
	return setTelegramSettings(bucket, { webhookSecret: "" });
}

// -- Notification messages ------------------------------------------

/** What a Telegram notification message refers to; keyed by message_id for button taps and replies. */
export interface TelegramMessageRef {
	mailboxId: string;
	emailId: string;
	sender: string;
	subject: string;
}

function messageRefKey(chatId: string, messageId: number | string): string {
	return `telegram/messages/${chatId}/${messageId}.json`;
}

export async function getTelegramMessageRef(
	bucket: R2Bucket,
	chatId: string,
	messageId: number | string,
): Promise<TelegramMessageRef | null> {
	const obj = await bucket.get(messageRefKey(chatId, messageId));
	if (!obj) return null;
	return (await obj.json()) as TelegramMessageRef;
}

/** Live state of the email a notification refers to; drives which buttons are shown. */
export interface EmailStatus {
	folder: string;
	read: boolean;
	starred: boolean;
	/** Sender is on the blacklist. */
	blocked: boolean;
}

export const NEW_EMAIL_STATUS: EmailStatus = { folder: "inbox", read: false, starred: false, blocked: false };

/**
 * Inline keyboard for a new-mail notification, derived from the email's
 * current state so every button is either an action or its undo. Callback
 * buttons round-trip through the webhook/poller; only "open" leaves Telegram.
 */
export function buildNotificationKeyboard(
	settings: Pick<TelegramSettings, "inboxBaseUrl" | "webhookSecret" | "polling">,
	ref: Pick<TelegramMessageRef, "mailboxId" | "emailId" | "sender">,
	status: EmailStatus,
) {
	const openUrl = `${settings.inboxBaseUrl}/mail/mailbox/${encodeURIComponent(ref.mailboxId)}/emails/${encodeURIComponent(status.folder)}?email=${encodeURIComponent(ref.emailId)}`;
	const rows: { text: string; url?: string; callback_data?: string }[][] = [
		[{ text: "打开 Inbox 回复", url: openUrl }],
	];

	if (!isTelegramInteractive(settings)) {
		// Neither webhook nor polling: fall back to the browser-based report page.
		const reportUrl = `${settings.inboxBaseUrl}/report-spam?mailbox=${encodeURIComponent(ref.mailboxId)}&email=${encodeURIComponent(ref.emailId)}`;
		rows.push([{ text: "举报垃圾邮件并拉黑", url: reportUrl }]);
		return { inline_keyboard: rows };
	}

	const id = ref.emailId;

	// Row: read / star toggles.
	rows.push([
		status.read
			? { text: "✉️ 标为未读", callback_data: `unread:${id}` }
			: { text: "✓ 标为已读", callback_data: `read:${id}` },
		status.starred
			? { text: "★ 取消星标", callback_data: `unstar:${id}` }
			: { text: "☆ 加星标", callback_data: `star:${id}` },
	]);

	// Row: folder actions.
	if (status.folder === "spam") {
		rows.push([
			{ text: "✅ 已标为垃圾邮件", callback_data: "noop" },
			{ text: "↩️ 移回收件箱", callback_data: `inbox:${id}` },
		]);
	} else if (status.folder === "trash") {
		rows.push([
			{ text: "✅ 已删除（在废纸篓）", callback_data: "noop" },
			{ text: "↩️ 移回收件箱", callback_data: `inbox:${id}` },
		]);
	} else {
		rows.push([
			{ text: "⚠️ 标为垃圾邮件", callback_data: `spam:${id}` },
			{ text: "🗑 删除", callback_data: `trash:${id}` },
		]);
	}

	// Row: sender.
	if (status.blocked) {
		rows.push([
			{ text: `✅ 已拉黑 ${ref.sender}`, callback_data: "noop" },
			{ text: "↩️ 撤销拉黑", callback_data: `unblock:${id}` },
		]);
	} else {
		rows.push([{ text: "🚫 拉黑发件人", callback_data: `block:${id}` }]);
	}
	return { inline_keyboard: rows };
}

export async function notifyNewEmail(
	bucket: R2Bucket,
	params: {
		mailboxId: string;
		emailId: string;
		sender: string;
		subject: string;
		body: string;
		attachmentCount: number;
	},
): Promise<void> {
	const settings = await getTelegramSettings(bucket);
	if (!settings.enabled || !settings.botToken || !settings.chatId) return;

	const snippet = previewText(params.body);
	const lines = [
		"<b>📬 新邮件</b>",
		"",
		`<b>收件</b> ${escapeHtml(params.mailboxId)}`,
		`<b>发件</b> ${escapeHtml(params.sender || "（未知）")}`,
		`<b>主题</b> ${escapeHtml(params.subject || "（无主题）")}`,
	];
	if (params.attachmentCount > 0) {
		lines.push(`<b>附件</b> ${params.attachmentCount} 个`);
	}
	if (snippet) {
		lines.push("", escapeHtml(snippet));
	}
	if (isTelegramInteractive(settings)) {
		lines.push("", "<i>直接回复这条消息即可发送邮件回复。</i>");
	}

	const ref: TelegramMessageRef = {
		mailboxId: params.mailboxId,
		emailId: params.emailId,
		sender: params.sender,
		subject: params.subject,
	};

	const sent = (await telegramApi(settings.botToken, "sendMessage", {
		chat_id: settings.chatId,
		text: lines.join("\n"),
		parse_mode: "HTML",
		disable_web_page_preview: true,
		reply_markup: buildNotificationKeyboard(settings, ref, NEW_EMAIL_STATUS),
	})) as { message_id?: number };

	if (sent?.message_id != null) {
		await bucket.put(messageRefKey(settings.chatId, sent.message_id), JSON.stringify(ref));
	}
}
