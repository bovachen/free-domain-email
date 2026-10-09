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

/** Host part of an address, lowercased; "" when there is none. */
export function senderDomain(sender: string): string {
	const address = normalizeSenderAddress(sender);
	const at = address.lastIndexOf("@");
	return at === -1 ? "" : address.slice(at + 1);
}

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Accepts `example.com`, `@example.com`, `*@example.com` or `*.example.com`. */
export function normalizeDomain(value: string): string {
	return value.trim().toLowerCase().replace(/^\*?@/, "").replace(/^\*\./, "").replace(/\.$/, "");
}

export function isValidDomain(value: string): boolean {
	return DOMAIN_RE.test(normalizeDomain(value));
}

/** True when `host` is `domain` itself or one of its subdomains. */
export function domainMatches(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Public mailbox providers. Anyone can sign up there, so blocking one of
 * these domains would block every legitimate sender who uses it too.
 */
const FREEMAIL_DOMAINS = [
	"gmail.com", "googlemail.com",
	"outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.jp", "hotmail.co.uk", "live.cn",
	"yahoo.com", "yahoo.co.jp", "yahoo.com.tw", "yahoo.com.hk", "ymail.com", "rocketmail.com",
	"icloud.com", "me.com", "mac.com",
	"aol.com", "aim.com",
	"proton.me", "protonmail.com", "pm.me",
	"gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com",
	"yandex.com", "yandex.ru", "mail.ru",
	"zoho.com", "fastmail.com", "tutanota.com", "tuta.io",
	"qq.com", "foxmail.com", "163.com", "126.com", "yeah.net",
	"sina.com", "sina.cn", "sohu.com", "aliyun.com", "139.com", "189.cn", "wo.cn",
	"naver.com", "daum.net", "hanmail.net",
];

export function isFreemailDomain(domain: string): boolean {
	const d = normalizeDomain(domain);
	return FREEMAIL_DOMAINS.some((free) => domainMatches(d, free));
}

export type BlockTarget = { type: "address" | "domain"; value: string };

/**
 * Read what the user typed into a block box: a full address blocks that
 * sender only, a bare or `@`-prefixed domain blocks the whole domain.
 */
export function parseBlockTarget(input: string): BlockTarget | null {
	const address = normalizeSenderAddress(input);
	if (EMAIL_RE.test(address) && !address.startsWith("*@") && !address.startsWith("@")) {
		return { type: "address", value: address };
	}
	const domain = normalizeDomain(input);
	return DOMAIN_RE.test(domain) ? { type: "domain", value: domain } : null;
}

/** Entries without a type predate domain blocking and are addresses. */
export interface BlockRule {
	address: string;
	type?: "address" | "domain";
}

/** The first rule that blocks `sender`, or null. */
export function matchBlockRule<T extends BlockRule>(rules: T[], sender: string): T | null {
	const address = normalizeSenderAddress(sender);
	if (!address) return null;
	const host = senderDomain(address);
	return (
		rules.find((rule) =>
			rule.type === "domain" ? Boolean(host) && domainMatches(host, rule.address) : rule.address === address,
		) ?? null
	);
}
