// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Burn after reading: mail that is only worth a glance (verification codes,
// newsletters, automated notices) moves itself to the trash once it has
// served its purpose, and leaves the trash for good a few days later.
// Anything the rules are unsure about is kept.
//
// Each inbound email gets a retention class when it arrives:
// - "code": a one-time code; burns a while after arrival, read or not.
// - "burn": bulk or automated mail; burns a while after it is read.
// - "keep": everything else; never burns.
// A star keeps any email, and so does moving it out of the inbox. The
// schedule itself lives in the mailbox Durable Object (syncBurns).

export type Retention = "code" | "burn" | "keep";

export interface BurnTimes {
	/** Code mail burns this long after it arrives. */
	codeMinutes: number;
	/** Other burnable mail burns this long after it is read. */
	readHours: number;
	/** Burned mail stays recoverable in the trash this long. */
	purgeDays: number;
}

export const DEFAULT_BURN_TIMES: BurnTimes = { codeMinutes: 60, readHours: 24, purgeDays: 7 };

export const BURN_TIME_LIMITS: Record<keyof BurnTimes, { min: number; max: number }> = {
	codeMinutes: { min: 1, max: 7 * 24 * 60 },
	readHours: { min: 1, max: 30 * 24 },
	purgeDays: { min: 1, max: 90 },
};

type Header = { key: string; value: string };

/** Mailing-list and bulk-sender headers: newsletters, promotions, digests. */
export function isBulkMail(headers: Header[]): boolean {
	return headers.some(({ key, value }) => {
		const k = key.toLowerCase();
		if (k === "list-unsubscribe" || k === "list-id") return true;
		return k === "precedence" && /^\s*(bulk|list|junk)\s*$/i.test(value);
	});
}

const NOREPLY_RE = /(^|[._+-])(no-?reply|do-?not-?reply)([._+-]|$)/i;

/** Machine-sent mail nobody expects an answer to (RFC 3834 Auto-Submitted, noreply@ senders). */
export function isAutomatedMail(headers: Header[], sender: string): boolean {
	const autoSubmitted = headers.some(
		({ key, value }) => key.toLowerCase() === "auto-submitted" && value.trim().toLowerCase() !== "no",
	);
	return autoSubmitted || NOREPLY_RE.test(sender.split("@")[0] ?? "");
}

// A code alone is not enough: "error code 4021" from a person must not
// vanish an hour after it arrives. The subject or the sender has to say so too.
const CODE_SUBJECT_RE = /验证码|校验码|动态码|确认码|登录码|安全码|驗證碼|認證碼|code|verif|otp|passcode|one[- ]time|2fa|sign[- ]?in|log[- ]?in/i;

export interface RetentionInput {
	sender: string;
	subject: string;
	headers: Header[];
	/** A one-time code was found in the subject or body. */
	hasCode: boolean;
	/** Has attachments other than inline images. */
	hasAttachments: boolean;
	/** On the keep list, written to before, or one of the user's own domains. */
	trustedSender: boolean;
}

export function classifyRetention(input: RetentionInput): Retention {
	if (input.trustedSender) return "keep";
	const bulk = isBulkMail(input.headers);
	// Invoices, receipts and contracts often come from noreply@ senders.
	if (input.hasAttachments && !bulk) return "keep";
	const automated = isAutomatedMail(input.headers, input.sender);
	if (input.hasCode && (automated || bulk || CODE_SUBJECT_RE.test(input.subject))) return "code";
	return bulk || automated ? "burn" : "keep";
}

/** "1 小时", "90 分钟", "24 小时", "2 天": for notices and banners. */
export function formatMinutes(minutes: number): string {
	if (minutes >= 48 * 60 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天`;
	if (minutes % 60 === 0) return `${minutes / 60} 小时`;
	return `${minutes} 分钟`;
}

/** A countdown: "45 分钟", "23 小时 5 分钟". */
export function formatTimeLeft(minutes: number): string {
	if (minutes < 60) return `${minutes} 分钟`;
	const rest = minutes % 60;
	return `${Math.floor(minutes / 60)} 小时${rest ? ` ${rest} 分钟` : ""}`;
}

/** The one-line notice for a burnable email, e.g. "读后 24 小时焚毁". */
export function burnNotice(kind: "code" | "burn", times: BurnTimes): string {
	return kind === "code" ? `收到 ${formatMinutes(times.codeMinutes)}后焚毁` : `读后 ${formatMinutes(times.readHours * 60)}焚毁`;
}
