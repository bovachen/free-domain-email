// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Burn after reading: inbox mail moves itself to the trash a while after it
// arrives, read or not, and leaves the trash for good a few days later.
// Verification codes go sooner than the rest.
//
// Each inbound email gets a retention class when it arrives:
// - "code": a one-time code; burns codeMinutes after arrival.
// - "burn": everything else; burns burnHours after arrival.
// - "keep": the sender is on the keep list; never burns.
// A star (Telegram's 📌 保留) keeps any email, and so do replying in its
// conversation and moving it out of the inbox. The schedule itself lives in
// the mailbox Durable Object (syncBurns).

export type Retention = "code" | "burn" | "keep";

/** The classes that burn. */
export type BurnKind = Exclude<Retention, "keep">;

export function isBurnable(retention: string | null | undefined): retention is BurnKind {
	return retention === "code" || retention === "burn";
}

export interface BurnTimes {
	/** Code mail burns this long after it arrives. */
	codeMinutes: number;
	/** Other mail burns this long after it arrives. */
	burnHours: number;
	/** Burned mail stays recoverable in the trash this long. */
	purgeDays: number;
}

export const DEFAULT_BURN_TIMES: BurnTimes = { codeMinutes: 60, burnHours: 24, purgeDays: 7 };

export const BURN_TIME_LIMITS: Record<keyof BurnTimes, { min: number; max: number }> = {
	codeMinutes: { min: 1, max: 7 * 24 * 60 },
	burnHours: { min: 1, max: 30 * 24 },
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

// A code alone is not enough: "error code 4021" from a person should get the
// full day, not vanish an hour after it arrives. The subject or the sender has
// to say so too.
const CODE_SUBJECT_RE = /验证码|校验码|动态码|确认码|登录码|安全码|驗證碼|認證碼|code|verif|otp|passcode|one[- ]time|2fa|sign[- ]?in|log[- ]?in/i;

export interface RetentionInput {
	sender: string;
	subject: string;
	headers: Header[];
	/** A one-time code was found in the subject or body. */
	hasCode: boolean;
	/** The sender is on the keep list. */
	keptSender: boolean;
}

export function classifyRetention(input: RetentionInput): Retention {
	if (input.keptSender) return "keep";
	const automated = isAutomatedMail(input.headers, input.sender) || isBulkMail(input.headers);
	if (input.hasCode && (automated || CODE_SUBJECT_RE.test(input.subject))) return "code";
	return "burn";
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

/** The one-line notice for a burnable email, e.g. "收到 24 小时后焚毁". */
export function burnNotice(kind: BurnKind, times: BurnTimes): string {
	const minutes = kind === "code" ? times.codeMinutes : times.burnHours * 60;
	return `收到 ${formatMinutes(minutes)}后焚毁`;
}
