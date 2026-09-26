// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Consolidated date formatting utilities.
 *
 * Previously spread across `app/lib/utils.ts` (4 functions) and
 * `workers/lib/html.ts` (`formatEmailDate`). Now one canonical set
 * imported by both the frontend and backend.
 */

/** The UI is Chinese; format dates the same way in the browser, SSR and Workers. */
const LOCALE = "zh-CN";

/** Parse safely — returns null on invalid dates instead of NaN-date. */
function safeParse(dateStr: string | undefined | null): Date | null {
	if (!dateStr) return null;
	try {
		const d = new Date(dateStr);
		return isNaN(d.getTime()) ? null : d;
	} catch {
		return null;
	}
}

/**
 * Email list rows.
 * - Today: "15:42"
 * - This year: "4月15日"
 * - Older: "2024年4月15日"
 */
export function formatListDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	const now = new Date();
	if (date.toDateString() === now.toDateString()) {
		return date.toLocaleTimeString(LOCALE, {
			hour: "numeric",
			minute: "2-digit",
		});
	}
	if (date.getFullYear() === now.getFullYear()) {
		return date.toLocaleDateString(LOCALE, {
			month: "short",
			day: "numeric",
		});
	}
	return date.toLocaleDateString(LOCALE, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/**
 * Email detail header.
 * "4月15日周三 15:42"
 */
export function formatDetailDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleDateString(LOCALE, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * Thread message headers — time only.
 * "15:42"
 */
export function formatShortDate(dateStr: string): string {
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleTimeString(LOCALE, {
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * Compose quoted replies & backend quoted blocks.
 * "2026年4月15日周三 15:42"
 *
 * Uses an explicit locale for deterministic output on both browser
 * and Cloudflare Workers (which support `toLocaleString`).
 */
export function formatQuotedDate(dateStr: string | undefined): string {
	if (!dateStr) return "";
	const date = safeParse(dateStr);
	if (!date) return dateStr;

	return date.toLocaleString(LOCALE, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: false,
	});
}
