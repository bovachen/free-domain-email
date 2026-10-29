// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// Telegram Mini App: the "📖 查看全文" button on a notification opens the
// whole email inside Telegram. Telegram's in-app webview holds no Cloudflare
// Access session, so the page and its API sit outside Access (see app.ts) and
// authenticate with the init data Telegram signs with the bot token instead.

export const TELEGRAM_APP_PATH = "/api/telegram/app";

/** The Mini App page and its API, which app.ts lets through without an Access JWT. */
export function isTelegramAppPath(path: string): boolean {
	return path === TELEGRAM_APP_PATH || path.startsWith(`${TELEGRAM_APP_PATH}/`);
}

/**
 * Telegram rejects the whole message when a web_app button has a non-https
 * URL or sits outside a private chat with the bot (group chat IDs are
 * negative), so the button is only added where it can work.
 */
export function canUseMiniApp(settings: { inboxBaseUrl: string; chatId: string }): boolean {
	return settings.inboxBaseUrl.startsWith("https://") && /^\d+$/.test(settings.chatId);
}

export function miniAppUrl(inboxBaseUrl: string, mailboxId: string, emailId: string): string {
	const base = inboxBaseUrl.replace(/\/$/, "");
	return `${base}${TELEGRAM_APP_PATH}?mailbox=${encodeURIComponent(mailboxId)}&email=${encodeURIComponent(emailId)}`;
}

/** Init data is minted when the Mini App opens; refuse it a day later. */
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

function toHex(buf: ArrayBuffer): string {
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Check the init data Telegram hands a Mini App (`Telegram.WebApp.initData`)
 * and return the Telegram user ID it was issued to, or null when the
 * signature does not match the bot token or the data is too old.
 *
 * Per Telegram's docs: secret = HMAC-SHA256(key "WebAppData", bot token);
 * hash = hex HMAC-SHA256(key secret, the other fields as sorted
 * `key=value` lines). The docs don't say whether the newer `signature`
 * field belongs in those lines, so both forms are accepted; either one
 * still needs the bot token.
 */
export async function verifyInitData(initData: string, botToken: string, nowMs = Date.now()): Promise<string | null> {
	if (!initData || !botToken) return null;
	const params = new URLSearchParams(initData);
	const hash = params.get("hash");
	if (!hash) return null;

	const fields = [...params.entries()].filter(([key]) => key !== "hash");
	const checkString = (entries: [string, string][]) =>
		[...entries]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, value]) => `${key}=${value}`)
			.join("\n");
	const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
	let valid = sameString(toHex(await hmacSha256(secret, checkString(fields))), hash);
	if (!valid && params.has("signature")) {
		const withoutSignature = fields.filter(([key]) => key !== "signature");
		valid = sameString(toHex(await hmacSha256(secret, checkString(withoutSignature))), hash);
	}
	if (!valid) return null;

	const authDate = Number(params.get("auth_date"));
	if (!Number.isFinite(authDate) || nowMs / 1000 - authDate > MAX_INIT_DATA_AGE_SECONDS) return null;

	try {
		const user = JSON.parse(params.get("user") || "null") as { id?: number | string } | null;
		return user?.id != null ? String(user.id) : null;
	} catch {
		return null;
	}
}
