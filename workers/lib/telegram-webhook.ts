// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Telegram webhook handler: turns button taps and chat replies on new-mail
 * notifications into inbox actions without opening the web UI.
 *
 * Security model: the Worker only trusts updates that carry the shared
 * secret header (checked by the route) AND originate from the configured
 * chat ID. Anything else is acknowledged and ignored.
 */

import { Folders } from "../../shared/folders";
import { isValidEmailAddress, normalizeSenderAddress } from "../../shared/sender";
import { sendEmail } from "../email-sender";
import {
	addToBlacklist,
	isBlacklisted,
	moveSenderToSpam,
	removeFromBlacklist,
	reportEmailAsSpam,
} from "./blacklist";
import {
	buildQuotedReplyBlock,
	buildReferencesChain,
	buildThreadingHeaders,
	generateMessageId,
	listMailboxes,
	textToHtml,
} from "./email-helpers";
import type { EmailFull } from "./schemas";
import {
	buildNotificationKeyboard,
	getTelegramMessageRef,
	getTelegramSettings,
	setTelegramSettings,
	telegramApi,
	type EmailStatus,
	type TelegramMessageRef,
	type TelegramSettings,
} from "./telegram";
import type { Env } from "../types";

// -- Telegram update shapes (only the fields we read) -----------------

interface TgChat {
	id: number | string;
}

interface TgMessage {
	message_id: number;
	chat: TgChat;
	text?: string;
	reply_to_message?: TgMessage;
}

interface TgCallbackQuery {
	id: string;
	message?: TgMessage;
	data?: string;
}

export interface TelegramUpdate {
	update_id?: number;
	message?: TgMessage;
	callback_query?: TgCallbackQuery;
}

const ACTIONS = ["spam", "trash", "inbox", "block", "unblock", "read", "unread", "star", "unstar"] as const;
type Action = (typeof ACTIONS)[number] | "noop";

function parseCallback(data: string | undefined): { action: Action; emailId: string } | null {
	if (!data) return null;
	if (data === "noop") return { action: "noop", emailId: "" };
	const idx = data.indexOf(":");
	if (idx === -1) return null;
	const action = data.slice(0, idx) as Action;
	const emailId = data.slice(idx + 1);
	if (!(ACTIONS as readonly string[]).includes(action) || !emailId) return null;
	return { action, emailId };
}

/** Current folder/flags of the referenced email plus the sender's blacklist state. */
async function getEmailStatus(env: Env, ref: TelegramMessageRef): Promise<EmailStatus | null> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(ref.mailboxId));
	const email = (await stub.getEmail(ref.emailId)) as
		| { folder_id?: string; read?: boolean; starred?: boolean; sender?: string }
		| null;
	if (!email) return null;
	const sender = email.sender || ref.sender;
	return {
		folder: email.folder_id || "inbox",
		read: Boolean(email.read),
		starred: Boolean(email.starred),
		blocked: sender ? await isBlacklisted(env.BUCKET, sender) : false,
	};
}

/** Older notifications predate the message-ref store; locate the email by scanning mailboxes. */
async function findRefByEmailId(env: Env, emailId: string): Promise<TelegramMessageRef | null> {
	const mailboxes = await listMailboxes(env.BUCKET);
	for (const mailbox of mailboxes) {
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailbox.id));
		const email = (await stub.getEmail(emailId)) as { sender?: string; subject?: string } | null;
		if (email) {
			return { mailboxId: mailbox.id, emailId, sender: email.sender || "", subject: email.subject || "" };
		}
	}
	return null;
}

async function resolveRef(
	env: Env,
	chatId: string,
	message: TgMessage | undefined,
	emailId: string,
): Promise<TelegramMessageRef | null> {
	if (message) {
		const stored = await getTelegramMessageRef(env.BUCKET, chatId, message.message_id);
		// Guard against a stale ref pointing at a different email than the button.
		if (stored && (!emailId || stored.emailId === emailId)) return stored;
	}
	return emailId ? findRefByEmailId(env, emailId) : null;
}

/** Re-render the buttons from the email's live state after an action. */
async function updateKeyboard(
	env: Env,
	settings: TelegramSettings,
	message: TgMessage | undefined,
	ref: TelegramMessageRef,
) {
	if (!message) return;
	const status = await getEmailStatus(env, ref);
	if (!status) return;
	try {
		await telegramApi(settings.botToken, "editMessageReplyMarkup", {
			chat_id: message.chat.id,
			message_id: message.message_id,
			reply_markup: buildNotificationKeyboard(settings, ref, status),
		});
	} catch (e) {
		// "message is not modified" is harmless when the same button is tapped twice.
		console.warn("editMessageReplyMarkup failed:", (e as Error).message);
	}
}

async function answer(settings: TelegramSettings, queryId: string, text: string, alert = false) {
	try {
		await telegramApi(settings.botToken, "answerCallbackQuery", {
			callback_query_id: queryId,
			text,
			show_alert: alert,
		});
	} catch (e) {
		console.warn("answerCallbackQuery failed:", (e as Error).message);
	}
}

async function say(settings: TelegramSettings, chatId: number | string, text: string, replyTo?: number) {
	await telegramApi(settings.botToken, "sendMessage", {
		chat_id: chatId,
		text,
		...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
	});
}

// -- Button taps ------------------------------------------------------

async function handleCallback(env: Env, settings: TelegramSettings, query: TgCallbackQuery) {
	const parsed = parseCallback(query.data);
	if (!parsed) return answer(settings, query.id, "无法识别的操作");
	if (parsed.action === "noop") return answer(settings, query.id, "已处理");

	const ref = await resolveRef(env, settings.chatId, query.message, parsed.emailId);
	if (!ref) return answer(settings, query.id, "找不到这封邮件，可能已被删除", true);

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(ref.mailboxId));
	const refresh = () => updateKeyboard(env, settings, query.message, ref);
	const move = async (folder: string, okText: string) => {
		const ok = await stub.moveEmail(ref.emailId, folder);
		if (!ok) return answer(settings, query.id, "移动失败", true);
		await refresh();
		return answer(settings, query.id, okText);
	};
	const flag = async (patch: { read?: boolean; starred?: boolean }, okText: string) => {
		const updated = await stub.updateEmail(ref.emailId, patch);
		if (!updated) return answer(settings, query.id, "邮件不存在", true);
		await refresh();
		return answer(settings, query.id, okText);
	};

	switch (parsed.action) {
		case "spam":
			return move(Folders.SPAM, "已标为垃圾邮件");
		case "trash":
			return move(Folders.TRASH, "已移入废纸篓");
		case "inbox":
			return move(Folders.INBOX, "已移回收件箱");
		case "read":
			return flag({ read: true }, "已标为已读");
		case "unread":
			return flag({ read: false }, "已标为未读");
		case "star":
			return flag({ starred: true }, "已加星标");
		case "unstar":
			return flag({ starred: false }, "已取消星标");
		case "block": {
			const result = await reportEmailAsSpam(env, ref.mailboxId, ref.emailId);
			if ("error" in result) return answer(settings, query.id, result.error, true);
			await refresh();
			if (!result.blocked) {
				// Sender unusable (own address or unparsable): only the email moved.
				return answer(settings, query.id, "发件人地址无法拉黑，邮件已标为垃圾邮件", true);
			}
			return answer(settings, query.id, `已拉黑 ${result.sender}，该发件人的邮件今后直接进垃圾邮件`);
		}
		case "unblock": {
			const address = normalizeSenderAddress(ref.sender);
			if (address) await removeFromBlacklist(env.BUCKET, address);
			await stub.moveEmail(ref.emailId, Folders.INBOX);
			await refresh();
			return answer(settings, query.id, address ? `已解除拉黑 ${address}，邮件已移回收件箱` : "已移回收件箱");
		}
	}
}

// -- Chat replies -> email replies -------------------------------------

async function sendReplyFromTelegram(
	env: Env,
	ref: TelegramMessageRef,
	text: string,
): Promise<{ ok: true; to: string } | { ok: false; error: string }> {
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(ref.mailboxId));
	const original = (await stub.getEmail(ref.emailId)) as EmailFull | null;
	if (!original) return { ok: false, error: "原邮件不存在，可能已被删除" };

	const to = normalizeSenderAddress(original.sender || ref.sender);
	if (!isValidEmailAddress(to)) return { ok: false, error: `发件人地址无效：${to || "(空)"}` };

	const rateLimitError = await (stub as unknown as { checkSendRateLimit: () => Promise<string | null> })
		.checkSendRateLimit();
	if (rateLimitError) return { ok: false, error: rateLimitError };

	const fromDomain = ref.mailboxId.split("@")[1];
	if (!fromDomain) return { ok: false, error: "邮箱地址无效" };

	const { originalMsgId, references, threadId } = buildReferencesChain(original);
	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const subjectBase = original.subject || ref.subject || "";
	const subject = /^re:/i.test(subjectBase) ? subjectBase : `Re: ${subjectBase}`.trim();
	const html =
		textToHtml(text) +
		buildQuotedReplyBlock({ date: original.date, sender: original.sender || to, body: original.body ?? undefined });

	try {
		await sendEmail(env.EMAIL, {
			to,
			from: ref.mailboxId,
			subject,
			html,
			headers: buildThreadingHeaders(originalMsgId, references),
		});
	} catch (e) {
		return { ok: false, error: `发送失败：${(e as Error).message}` };
	}

	await stub.createEmail(
		Folders.SENT,
		{
			id: messageId,
			subject,
			sender: ref.mailboxId.toLowerCase(),
			recipient: to,
			date: new Date().toISOString(),
			body: html,
			in_reply_to: originalMsgId,
			email_references: references.length > 0 ? JSON.stringify(references) : null,
			thread_id: threadId,
			message_id: outgoingMessageId,
		},
		[],
	);
	await stub.markThreadRead(threadId);
	return { ok: true, to };
}

// -- Plain messages and commands ---------------------------------------

async function handleMessage(env: Env, settings: TelegramSettings, message: TgMessage) {
	const chatId = message.chat.id;
	const text = (message.text || "").trim();

	// First contact: bind the chat when none is configured yet.
	if (!settings.chatId) {
		if (text.startsWith("/start")) {
			settings = await setTelegramSettings(env.BUCKET, { chatId: String(chatId) });
			await say(settings, chatId, `已绑定这个对话（chat ID ${chatId}）。新邮件通知会发到这里。`);
		}
		return;
	}
	if (String(chatId) !== settings.chatId) return;

	if (text.startsWith("/start")) {
		return say(settings, chatId, "Agentic Inbox 已连接。新邮件会推送到这里；按钮可标记已读、加星标、删除、标为垃圾邮件或拉黑发件人，直接回复通知消息即可发送邮件回复。\n\n命令：/block 地址　/unblock 地址");
	}

	const cmd = text.match(/^\/(block|unblock)(?:@\w+)?\s+(.+)$/i);
	if (cmd) {
		const address = normalizeSenderAddress(cmd[2]);
		if (!isValidEmailAddress(address)) return say(settings, chatId, `地址无效：${cmd[2]}`);
		if (cmd[1].toLowerCase() === "block") {
			await addToBlacklist(env.BUCKET, { address, reason: "telegram" });
			await moveSenderToSpam(env, address);
			return say(settings, chatId, `已拉黑 ${address}，其现有邮件已移到垃圾邮件。`);
		}
		await removeFromBlacklist(env.BUCKET, address);
		return say(settings, chatId, `已解除拉黑 ${address}。`);
	}

	// A reply to one of our notifications becomes an email reply.
	if (message.reply_to_message) {
		const ref = await getTelegramMessageRef(env.BUCKET, settings.chatId, message.reply_to_message.message_id);
		if (!ref) return say(settings, chatId, "这条消息不是邮件通知，无法回复。", message.message_id);
		if (!text) return say(settings, chatId, "回复内容为空，只支持文字回复。", message.message_id);
		const result = await sendReplyFromTelegram(env, ref, text);
		return say(
			settings,
			chatId,
			result.ok ? `✅ 已从 ${ref.mailboxId} 回复 ${result.to}` : `❌ 回复未发送：${result.error}`,
			message.message_id,
		);
	}
}

// -- Cron polling ------------------------------------------------------

const POLL_OFFSET_KEY = "telegram/poll-offset.json";
export const POLL_HEARTBEAT_KEY = "telegram/poll-heartbeat.json";

export interface PollHeartbeat {
	lastRunAt: string;
	processed: number;
	error?: string;
}
/** Keep each cron run well under a minute so consecutive runs never overlap. */
const POLL_BUDGET_MS = 35_000;
const POLL_LONG_TIMEOUT_S = 20;

/**
 * Long-poll getUpdates from the scheduled handler. Runs for ~35 s per cron
 * tick (each call blocks up to 20 s waiting for an update), so a tap usually
 * lands within a few seconds. Skipped when a webhook is registered, since
 * Telegram refuses getUpdates in that case.
 */
export async function pollTelegramUpdates(env: Env): Promise<number> {
	const settings = await getTelegramSettings(env.BUCKET);
	if (!settings.enabled || !settings.botToken || settings.webhookSecret || !settings.polling) return 0;

	const offsetObj = await env.BUCKET.get(POLL_OFFSET_KEY);
	let offset = offsetObj ? Number(((await offsetObj.json()) as { offset?: number }).offset) || 0 : 0;
	const started = Date.now();
	let processed = 0;
	let lastError: string | undefined;

	while (Date.now() - started < POLL_BUDGET_MS) {
		let updates: (TelegramUpdate & { update_id: number })[];
		try {
			updates = (await telegramApi(settings.botToken, "getUpdates", {
				offset: offset || undefined,
				timeout: POLL_LONG_TIMEOUT_S,
				allowed_updates: ["message", "callback_query"],
			})) as (TelegramUpdate & { update_id: number })[];
		} catch (e) {
			lastError = (e as Error).message;
			console.error("Telegram getUpdates failed:", lastError);
			break;
		}
		if (updates.length === 0) continue;

		for (const update of updates) {
			await handleTelegramUpdate(env, update);
			offset = update.update_id + 1;
			processed++;
		}
		// Persist after each batch so a crash never replays handled updates.
		await env.BUCKET.put(POLL_OFFSET_KEY, JSON.stringify({ offset }));
	}

	const heartbeat: PollHeartbeat = { lastRunAt: new Date().toISOString(), processed };
	if (lastError) heartbeat.error = lastError;
	await env.BUCKET.put(POLL_HEARTBEAT_KEY, JSON.stringify(heartbeat));
	return processed;
}

export async function getPollHeartbeat(bucket: R2Bucket): Promise<PollHeartbeat | null> {
	const obj = await bucket.get(POLL_HEARTBEAT_KEY);
	return obj ? ((await obj.json()) as PollHeartbeat) : null;
}

// -- Entry point -------------------------------------------------------

/**
 * Process one Telegram update. Never throws: Telegram retries on non-2xx,
 * and a retry loop over a bad update is worse than a logged failure.
 */
export async function handleTelegramUpdate(env: Env, update: TelegramUpdate): Promise<void> {
	const settings = await getTelegramSettings(env.BUCKET);
	if (!settings.botToken) return;

	try {
		if (update.callback_query) {
			const query = update.callback_query;
			const fromChat = query.message?.chat?.id;
			if (fromChat == null || String(fromChat) !== settings.chatId) {
				return answer(settings, query.id, "未授权的对话");
			}
			await handleCallback(env, settings, query);
		} else if (update.message) {
			await handleMessage(env, settings, update.message);
		}
	} catch (e) {
		console.error("Telegram update failed:", (e as Error).message, (e as Error).stack);
	}
}
