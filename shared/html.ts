// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Escape all five OWASP-recommended HTML special characters in plain text.
 * Safe for use in both text content and attribute contexts.
 */
export function escapeHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const HTML_TAG_RE = /<(?:!doctype|html|head|body|div|p|br|span|table|tr|td|a|img|font|b|i|u|strong|em|h[1-6]|ul|ol|li|blockquote|pre|center|meta|style|hr)(?=[\s>/])/i;

/**
 * Plain-text emails (no HTML part, e.g. Gmail's forwarding confirmation) are
 * stored as-is; rendered as HTML their line breaks collapse and URLs aren't
 * clickable. Convert them to HTML that keeps both; real HTML passes through.
 */
export function plainTextToHtml(body: string): string {
	if (!body || HTML_TAG_RE.test(body)) return body;
	const linked = escapeHtml(body).replace(
		/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g,
		(url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
	);
	return `<div style="white-space: pre-wrap">${linked}</div>`;
}
