// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Pull a bare address out of `Name <addr@host>` or a raw address. */
export function normalizeSenderAddress(sender: string): string {
	const trimmed = sender.trim();
	if (!trimmed) return "";
	const angle = trimmed.match(/<([^>]+)>/);
	return (angle ? angle[1] : trimmed).trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailAddress(value: string): boolean {
	return EMAIL_RE.test(normalizeSenderAddress(value));
}
