// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Inbound spam filter, run on mail from senders that are neither blocked nor
 * trusted. Two layers:
 *
 * 1. Authentication. Cloudflare Email Routing records SPF/DKIM/DMARC in an
 *    `ARC-Authentication-Results` header. It already refuses mail that passes
 *    neither SPF nor DKIM, so what reaches us is authenticated *for some
 *    domain*; a DMARC fail means that domain is not the one in From, i.e. the
 *    From address is forged.
 * 2. Content. A spammer who registers their own domain passes every
 *    authentication check, so the subject, body and link targets go to a
 *    Workers AI model that tells phishing and scams from ordinary mail.
 *
 * Failures of the AI layer let the mail through: losing a real email to the
 * spam folder costs more than one spam reaching the inbox.
 */

export interface AuthResults {
	spf?: string;
	dkim?: string;
	dmarc?: string;
	/** "pass" when a forwarder's ARC chain verified (Gmail auto-forwarding, mailing lists). */
	arc?: string;
	/** The From domain's published DMARC policy (none / quarantine / reject). */
	dmarcPolicy?: string;
}

export interface SpamVerdict {
	spam: boolean;
	/** Which layer decided. */
	source: "auth" | "ai" | "none";
	/** Short Chinese explanation, shown in the stored headers. */
	reason?: string;
}

type Header = { key: string; value: string };

/** Header name the filter stamps on mail it moved to spam. */
export const SPAM_HEADER = "x-inbox-spam";

/**
 * Parse the authentication verdicts Cloudflare recorded. Cloudflare prepends
 * its headers, so the first one carrying its authserv-id is the real one and
 * any copies a sender planted further down are ignored.
 */
export function parseAuthResults(headers: Header[] | undefined): AuthResults | null {
	for (const header of headers ?? []) {
		const key = header.key.toLowerCase();
		if (key !== "arc-authentication-results" && key !== "authentication-results") continue;
		const value = header.value.replace(/\s+/g, " ").trim();
		// ARC adds an `i=N;` instance tag before the authserv-id.
		const body = value.replace(/^i=\d+\s*;\s*/i, "");
		const [servId, ...parts] = body.split(";");
		if (!/cloudflare/i.test(servId)) continue;

		const results: AuthResults = {};
		for (const part of parts) {
			const m = part.trim().match(/^(spf|dkim|dmarc|arc)=([a-z]+)/i);
			if (!m) continue;
			const method = m[1].toLowerCase() as "spf" | "dkim" | "dmarc" | "arc";
			const result = m[2].toLowerCase();
			// Several DKIM signatures or SPF checks (HELO and MAIL FROM) can
			// appear; one pass is enough for the mechanism to count as passed.
			if (results[method] !== "pass") results[method] = result;
			if (method === "dmarc") {
				const policy = part.match(/policy\.dmarc=([a-z]+)/i);
				if (policy) results.dmarcPolicy = policy[1].toLowerCase();
			}
		}
		return results;
	}
	return null;
}

/**
 * Spoofing verdict from authentication alone, or null when it is inconclusive.
 * Forwarding breaks DMARC for senders that rely on SPF alone; a verified ARC
 * chain marks such mail, which then goes to the content check instead.
 */
export function authVerdict(auth: AuthResults | null): SpamVerdict | null {
	if (auth?.dmarc === "fail" && auth.arc !== "pass") {
		return { spam: true, source: "auth", reason: "DMARC 校验失败，发件人地址疑似伪造" };
	}
	return null;
}

/** Hosts the email links to, most frequent first; phishing hides behind "点击此处". */
export function extractLinkHosts(html: string, text: string, limit = 8): string[] {
	const counts = new Map<string, number>();
	const re = /https?:\/\/([a-z0-9.-]+)/gi;
	for (const source of [html, text]) {
		for (const m of source.matchAll(re)) {
			const host = m[1].toLowerCase().replace(/\.$/, "");
			counts.set(host, (counts.get(host) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([host]) => host);
}

export interface ClassifyInput {
	fromName?: string;
	fromAddress: string;
	replyTo?: string;
	recipient: string;
	subject: string;
	/** Plain-text body. */
	text: string;
	linkHosts: string[];
	auth: AuthResults | null;
}

const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const MAX_BODY_CHARS = 4000;
const TIMEOUT_MS = 10_000;

const CLASSIFIER_PROMPT = `你是邮箱的垃圾邮件过滤器。判断一封收到的邮件属于哪一类：

PHISHING：钓鱼或诈骗。冒充邮箱管理员、IT 部门、银行、快递、平台客服、领导或同事，以"账号异常/密码过期/异地登录/即将冻结或锁定/身份二次认证/邮箱扩容/工资补贴/退税/中奖"等理由，催促收件人点击链接、登录、填写账号密码或付款。冒充的机构与真实发件域名不符是强信号。
SPAM：主动群发的垃圾广告。发票代开、贷款、博彩、色情、SEO 外链、刷单兼职、来路不明的推销等。
OK：其他所有邮件。包括正常的个人或工作往来，以及收件人注册过的正规服务发来的通知、验证码、账单、订单、安全提醒和订阅资讯——即使带有营销性质也算 OK。

只有在明显属于 PHISHING 或 SPAM 时才这样判断；拿不准时判 OK。

严格按两行输出，不要输出别的内容：
第一行：PHISHING、SPAM 或 OK
第二行：不超过 30 字的中文理由`;

function buildUserMessage(input: ClassifyInput): string {
	const auth = input.auth
		? `SPF=${input.auth.spf ?? "无"} DKIM=${input.auth.dkim ?? "无"} DMARC=${input.auth.dmarc ?? "无"}`
		: "未知";
	const from = input.fromName ? `${input.fromName} <${input.fromAddress}>` : input.fromAddress;
	const meta = [
		`发件人：${from}`,
		input.replyTo && input.replyTo !== input.fromAddress ? `回复地址：${input.replyTo}` : null,
		`收件人：${input.recipient}`,
		`认证结果：${auth}`,
		`主题：${input.subject || "(无主题)"}`,
		`正文中的链接域名：${input.linkHosts.length > 0 ? input.linkHosts.join(", ") : "无"}`,
	].filter((line) => line !== null);
	const body = input.text.slice(0, MAX_BODY_CHARS) || "(空)";
	// Qwen3 thinks before answering unless told not to; a one-line label
	// does not need it and the inbound handler should not wait for it.
	return `${meta.join("\n")}\n\n正文：\n${body}\n\n/no_think`;
}

/** Pull the label and reason out of the model's reply. */
export function parseClassifierReply(reply: string): { label: "PHISHING" | "SPAM" | "OK"; reason: string } | null {
	const cleaned = reply.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
	const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const first = (lines[0] ?? "").toUpperCase();
	const label = first.startsWith("PHISHING") ? "PHISHING" : first.startsWith("SPAM") ? "SPAM" : first.startsWith("OK") ? "OK" : null;
	if (!label) return null;
	const reason = (lines[1] ?? "").replace(/^(第二行|理由)[:：]\s*/, "").slice(0, 60);
	return { label, reason };
}

function replyText(response: unknown): string {
	if (typeof response === "string") return response;
	const r = response as {
		response?: string;
		choices?: { message?: { content?: string } }[];
	};
	return r?.choices?.[0]?.message?.content ?? r?.response ?? "";
}

export async function classifyWithAi(ai: Ai, input: ClassifyInput): Promise<SpamVerdict> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const run = ai.run(MODEL, {
			messages: [
				{ role: "system", content: CLASSIFIER_PROMPT },
				{ role: "user", content: buildUserMessage(input) },
			],
			max_tokens: 80,
			temperature: 0,
		});
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
		});
		const parsed = parseClassifierReply(replyText(await Promise.race([run, timeout])));
		if (!parsed) {
			console.warn("Spam classifier gave no usable label; delivering to inbox");
			return { spam: false, source: "none" };
		}
		if (parsed.label === "OK") return { spam: false, source: "ai", reason: parsed.reason };
		const kind = parsed.label === "PHISHING" ? "疑似钓鱼" : "垃圾广告";
		return { spam: true, source: "ai", reason: parsed.reason ? `${kind}：${parsed.reason}` : kind };
	} catch (e) {
		console.error("Spam classifier failed; delivering to inbox:", (e as Error).message);
		return { spam: false, source: "none" };
	} finally {
		clearTimeout(timer);
	}
}

/** Authentication first (free and certain), then the model. */
export async function checkInboundSpam(
	ai: Ai,
	input: Omit<ClassifyInput, "auth"> & { headers: Header[] | undefined; skipAi?: boolean },
): Promise<SpamVerdict> {
	const auth = parseAuthResults(input.headers);
	const byAuth = authVerdict(auth);
	if (byAuth) return byAuth;
	if (input.skipAi) return { spam: false, source: "none" };
	const { headers: _headers, skipAi: _skipAi, ...rest } = input;
	return classifyWithAi(ai, { ...rest, auth });
}
