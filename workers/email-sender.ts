// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound email delivery.
 *
 * Sends through Resend when the `RESEND_API_KEY` secret is set, otherwise
 * through the Cloudflare Email Service `send_email` binding (`env.EMAIL.send()`).
 *
 * See: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 *      https://resend.com/docs/api-reference/emails/send-email
 */

import type { Env } from "./types";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

type Address = NonNullable<SendEmailParams["replyTo"]>;

/** RFC 5322 mailbox: the bare address, or `"Name" <address>` when a name is set. */
function formatAddress(address: Address): string {
	if (typeof address === "string") return address;
	if (!address.name) return address.email;
	return `"${address.name.replace(/["\\]/g, "\\$&")}" <${address.email}>`;
}

async function sendWithResend(
	apiKey: string,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const body: Record<string, unknown> = {
		from: formatAddress(params.from),
		to: params.to,
		subject: params.subject,
	};

	if (params.html) body.html = params.html;
	if (params.text) body.text = params.text;
	if (params.cc) body.cc = params.cc;
	if (params.bcc) body.bcc = params.bcc;
	if (params.replyTo) body.reply_to = formatAddress(params.replyTo);

	if (params.headers && Object.keys(params.headers).length > 0) {
		body.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		body.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			content_type: att.type,
			...(att.contentId ? { content_id: att.contentId } : {}),
		}));
	}

	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
	if (!res.ok || !data.id) {
		throw new Error(`Resend 发信失败（${res.status}）：${data.message || res.statusText}`);
	}
	return { messageId: data.id };
}

/**
 * Send an email through Resend (when `RESEND_API_KEY` is set) or the
 * Cloudflare Email Service binding.
 *
 * @param env      - Worker env; uses `RESEND_API_KEY` if present, else the `EMAIL` binding
 * @param params   - Email parameters (to, from, subject, body, etc.)
 * @returns The send result with messageId
 * @throws On validation or delivery errors
 */
export async function sendEmail(
	env: Pick<Env, "EMAIL" | "RESEND_API_KEY">,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	if (env.RESEND_API_KEY) return sendWithResend(env.RESEND_API_KEY, params);

	const message: Record<string, unknown> = {
		to: params.to,
		from: params.from,
		subject: params.subject,
	};

	if (params.html) message.html = params.html;
	if (params.text) message.text = params.text;
	if (params.cc) message.cc = params.cc;
	if (params.bcc) message.bcc = params.bcc;
	if (params.replyTo) message.replyTo = params.replyTo;

	if (params.headers && Object.keys(params.headers).length > 0) {
		message.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		message.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			type: att.type,
			disposition: att.disposition,
			...(att.contentId ? { contentId: att.contentId } : {}),
		}));
	}

	const result = await env.EMAIL.send(message as any);
	return { messageId: result.messageId };
}
