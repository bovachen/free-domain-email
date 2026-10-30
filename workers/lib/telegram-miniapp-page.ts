// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// The Telegram Mini App page and the email HTML it shows. The page is one
// self-contained document so it needs nothing from behind Cloudflare Access.
//
// Security model, same idea as the web reader (app/components/EmailIframe.tsx):
// - The email renders in an iframe sandboxed without `allow-same-origin`, so
//   it cannot reach the page, which holds the Telegram init data.
// - The page's CSP allows only scripts carrying a per-response nonce; the
//   iframe inherits that policy and repeats it, so scripts and event handlers
//   in the email never run. Only the frame's own sizing/link script does.
// - The Worker strips what CSP and the sandbox can't stop (a meta refresh
//   navigating the frame, <base>), plus scripts and handlers as a second layer.

import { plainTextToHtml } from "../../shared/html";
import { TELEGRAM_APP_PATH } from "./telegram-miniapp";

interface EmailAttachment {
	id: string;
	filename: string;
	mimetype: string;
	content_id: string | null;
}

/** Larger inline images stay in the attachment list rather than bloating the response. */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

const DROPPED_TAGS = ["script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "meta", "base", "link"];
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "background", "poster", "xlink:href"]);

function isUnsafeUrl(value: string): boolean {
	const v = value.trim().toLowerCase();
	return v.startsWith("javascript:") || v.startsWith("vbscript:") || (v.startsWith("data:") && !v.startsWith("data:image/"));
}

async function sanitizeEmailHtml(html: string): Promise<string> {
	let rewriter = new HTMLRewriter();
	for (const tag of DROPPED_TAGS) rewriter = rewriter.on(tag, { element: (el) => el.remove() });
	rewriter = rewriter
		.on("form", { element: (el) => el.removeAndKeepContent() })
		.on("*", {
			element(el) {
				for (const [name, value] of [...el.attributes]) {
					if (name.startsWith("on") || (URL_ATTRIBUTES.has(name) && isUnsafeUrl(value))) el.removeAttribute(name);
				}
			},
		});
	return rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

/**
 * The email body as HTML for the Mini App: plain text gets line breaks and
 * links, cid: images become data: URIs (the web reader loads them from an
 * attachment URL behind Access, which the Mini App cannot reach), and
 * active content is stripped. `embedded` holds the IDs of the attachments
 * the body now shows; everything else belongs in the attachment list.
 */
export async function prepareEmailHtml(
	bucket: R2Bucket,
	emailId: string,
	body: string,
	attachments: EmailAttachment[],
): Promise<{ html: string; embedded: Set<string> }> {
	let html = plainTextToHtml(body);
	const embedded = new Set<string>();
	for (const att of attachments) {
		const cid = att.content_id?.replace(/^<|>$/g, "");
		if (!cid || !att.mimetype.startsWith("image/")) continue;
		if (!html.toLowerCase().includes(`cid:${cid.toLowerCase()}`)) continue;
		const obj = await bucket.get(`attachments/${emailId}/${att.id}/${att.filename}`);
		if (!obj || obj.size > MAX_INLINE_IMAGE_BYTES) continue;
		const dataUri = `data:${att.mimetype};base64,${toBase64(new Uint8Array(await obj.arrayBuffer()))}`;
		html = html.replace(new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"), dataUri);
		embedded.add(att.id);
	}
	return { html: await sanitizeEmailHtml(html), embedded };
}

export function newNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return toBase64(bytes);
}

/** Sent as a header on the page; the email iframe (srcdoc) inherits it. */
export function miniAppCsp(nonce: string): string {
	return [
		"default-src 'none'",
		`script-src 'nonce-${nonce}'`,
		"style-src 'unsafe-inline'",
		"img-src data: https:",
		"connect-src 'self'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");
}

/** A JS string literal that is safe inside an inline <script>. */
function jsString(value: string): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

const FRAME_CSS = `
* { box-sizing: border-box; }
html { background: #ffffff; color-scheme: light; overflow-y: hidden; }
body {
	margin: 0;
	padding: 12px 14px;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
	font-size: 15px;
	line-height: 1.6;
	color: #1a1a1a;
	background: #ffffff;
	word-wrap: break-word;
	overflow-wrap: break-word;
}
[style*="position: fixed"], [style*="position:fixed"], [style*="position: absolute"], [style*="position:absolute"] {
	position: relative !important;
}
a { color: #2563eb; }
img { max-width: 100%; height: auto; }
blockquote { border-left: 3px solid #d1d5db; padding-left: 1em; margin-left: 0; color: #6b7280; }
pre { background: #f3f4f6; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; white-space: pre-wrap; }
`;

// Runs inside the sandboxed frame. Newsletters are often laid out 600px+
// wide; zooming the body to the frame's width shows them whole on a phone.
// The height comes from a ResizeObserver rather than requestAnimationFrame,
// which browsers throttle in cross-origin frames. Link taps go to the page,
// which opens them with Telegram's openLink.
const FRAME_SCRIPT = `
(function () {
	var lastWidth = -1;
	function report() {
		parent.postMessage({ mailFrame: "height", height: document.documentElement.getBoundingClientRect().height }, "*");
	}
	function fit() {
		var root = document.documentElement, body = document.body;
		if (!body) return;
		lastWidth = root.clientWidth;
		body.style.zoom = "";
		var scale = root.clientWidth / root.scrollWidth;
		if (scale < 0.99) body.style.zoom = String(scale);
		report();
	}
	document.addEventListener("DOMContentLoaded", function () {
		fit();
		if (window.ResizeObserver) new ResizeObserver(report).observe(document.documentElement);
	});
	window.addEventListener("load", fit);
	document.addEventListener("load", fit, true);
	document.addEventListener("error", fit, true);
	window.addEventListener("resize", function () {
		if (document.documentElement.clientWidth !== lastWidth) fit();
	});
	document.addEventListener("click", function (event) {
		var link = event.target instanceof Element ? event.target.closest("a[href]") : null;
		if (!link) return;
		event.preventDefault();
		parent.postMessage({ mailFrame: "link", href: link.href }, "*");
	});
})();
`;

function frameHead(nonce: string): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>${FRAME_CSS}</style>
<script nonce="${nonce}">${FRAME_SCRIPT}</script>
</head><body>`;
}

const PAGE_CSS = `
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
	margin: 0;
	padding-bottom: env(safe-area-inset-bottom);
	font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
	background: var(--tg-theme-secondary-bg-color, #f2f2f7);
	color: var(--tg-theme-text-color, #111111);
}
.card { background: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, #ffffff)); padding: 14px 16px; }
h1 { margin: 0 0 10px; font-size: 19px; line-height: 1.35; overflow-wrap: anywhere; }
.row { display: flex; gap: 10px; font-size: 13px; }
.label { flex: none; color: var(--tg-theme-hint-color, #8e8e93); }
.value { min-width: 0; overflow-wrap: anywhere; }
#attachments { margin-top: 8px; padding-top: 8px; padding-bottom: 8px; }
#attachments h2 { margin: 0 0 4px; font-size: 13px; font-weight: 500; color: var(--tg-theme-section-header-text-color, var(--tg-theme-hint-color, #8e8e93)); }
#attachments ul { list-style: none; margin: 0; padding: 0; }
#attachments li { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid var(--tg-theme-section-separator-color, rgba(0, 0, 0, 0.08)); }
#attachments li:first-child { border-top: 0; }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.size { flex: none; font-size: 12px; color: var(--tg-theme-hint-color, #8e8e93); }
button {
	flex: none;
	border: 0;
	border-radius: 8px;
	padding: 6px 12px;
	font: inherit;
	font-size: 13px;
	background: var(--tg-theme-button-color, #2481cc);
	color: var(--tg-theme-button-text-color, #ffffff);
}
button:disabled { opacity: 0.6; }
button.secondary { background: var(--tg-theme-secondary-bg-color, #eef2f7); color: var(--tg-theme-link-color, #2481cc); }
#burn { margin-top: 8px; }
#burn-text { margin: 0 0 10px; font-size: 14px; }
.burn-actions { display: flex; flex-wrap: wrap; gap: 8px; }
#frame { display: block; width: 100%; height: 160px; margin-top: 8px; border: 0; background: #ffffff; }
#status { padding: 48px 24px; text-align: center; color: var(--tg-theme-hint-color, #8e8e93); }
#status.error { color: var(--tg-theme-destructive-text-color, #e53935); }
`;

function pageScript(nonce: string): string {
	return `
(() => {
	const FRAME_HEAD = ${jsString(frameHead(nonce))};
	const API = ${jsString(TELEGRAM_APP_PATH)};
	const tg = window.Telegram && window.Telegram.WebApp;
	const $ = (id) => document.getElementById(id);
	const status = $("status");
	const frame = $("frame");

	const showError = (message) => {
		status.textContent = message;
		status.classList.add("error");
		status.hidden = false;
	};
	const alertUser = (message) => {
		try { tg.showAlert(message); } catch { alert(message); }
	};

	if (tg) {
		tg.ready();
		tg.expand();
	}
	const params = new URLSearchParams(location.search);
	const mailboxId = params.get("mailbox");
	const emailId = params.get("email");
	const initData = tg ? tg.initData : "";

	async function call(path, extra) {
		const res = await fetch(API + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ initData, mailboxId, emailId, ...extra }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || "请求失败（" + res.status + "）");
		return data;
	}

	function openLink(href) {
		let url;
		try { url = new URL(href); } catch { return; }
		if (url.protocol !== "http:" && url.protocol !== "https:") return;
		if (!tg) window.open(url.href, "_blank", "noopener");
		else if (url.hostname === "t.me") tg.openTelegramLink(url.href);
		else tg.openLink(url.href);
	}

	window.addEventListener("message", (event) => {
		if (event.source !== frame.contentWindow || !event.data) return;
		if (event.data.mailFrame === "height") {
			frame.style.height = Math.ceil(Number(event.data.height) || 0) + "px";
		} else if (event.data.mailFrame === "link") {
			openLink(String(event.data.href));
		}
	});

	const formatSize = (bytes) => {
		if (bytes < 1024) return bytes + " B";
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
		return (bytes / 1024 / 1024).toFixed(1) + " MB";
	};
	const formatDate = (iso) => {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return "";
		return d.toLocaleString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
	};

	// Burn banner: a star keeps the email; "以后都保留此发件人" adds the sender to the keep list.
	let burn = null;
	let starred = false;
	let keptSender = "";
	const formatLeft = (iso) => {
		const minutes = Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 60000));
		if (minutes < 60) return minutes + " 分钟";
		const hours = Math.floor(minutes / 60);
		return hours + " 小时" + (minutes % 60 ? " " + (minutes % 60) + " 分钟" : "");
	};
	function renderBurn() {
		const box = $("burn");
		box.hidden = !burn && !keptSender;
		if (box.hidden) return;
		$("burn-actions").hidden = Boolean(keptSender);
		$("keep-sender").hidden = starred;
		if (keptSender) {
			$("burn-text").textContent = "✅ 已把 " + keptSender + " 加入永久保留名单，这封和以后的邮件都不会焚毁。";
		} else if (starred) {
			$("burn-text").textContent = "📌 已保留（加了星标），不会焚毁。";
			$("keep").textContent = "取消保留";
		} else {
			const when = burn.at ? "将在 " + formatLeft(burn.at) + "后焚毁" : burn.notice;
			$("burn-text").textContent = "🔥 " + when + "，之后在废纸篓里保留 " + burn.purgeDays + " 天可恢复。";
			$("keep").textContent = "📌 保留";
		}
	}
	async function keep(action, sender) {
		const buttons = [$("keep"), $("keep-sender")];
		buttons.forEach((b) => { b.disabled = true; });
		try {
			const result = await call("/keep", { action });
			starred = Boolean(result.starred);
			burn = result.burn;
			if (action === "sender") keptSender = sender;
			renderBurn();
		} catch (e) {
			alertUser(e.message);
		} finally {
			buttons.forEach((b) => { b.disabled = false; });
		}
	}

	function renderAttachments(list) {
		if (!list.length) return;
		const ul = $("attachment-list");
		for (const att of list) {
			const li = document.createElement("li");
			const name = document.createElement("span");
			name.className = "name";
			name.textContent = att.filename;
			const size = document.createElement("span");
			size.className = "size";
			size.textContent = formatSize(att.size);
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = "发到聊天";
			button.addEventListener("click", async () => {
				button.disabled = true;
				button.textContent = "发送中…";
				try {
					await call("/attachment", { attachmentId: att.id });
					button.textContent = "已发送";
				} catch (e) {
					button.disabled = false;
					button.textContent = "发到聊天";
					alertUser(e.message);
				}
			});
			li.append(name, size, button);
			ul.append(li);
		}
		$("attachments").hidden = false;
	}

	async function load() {
		if (!initData) return showError("请从 Telegram 新邮件通知里的「📖 查看全文」按钮打开。");
		if (!mailboxId || !emailId) return showError("链接里缺少邮件信息。");
		try {
			const email = await call("/email");
			const subject = email.subject || "（无主题）";
			document.title = subject;
			$("subject").textContent = subject;
			$("from").textContent = email.sender || "（未知）";
			$("to").textContent = email.recipient || "";
			if (email.cc) {
				$("cc").textContent = email.cc;
				$("cc-row").hidden = false;
			}
			$("date").textContent = formatDate(email.date);
			$("header").hidden = false;
			burn = email.burn;
			starred = Boolean(email.starred);
			$("keep").addEventListener("click", () => keep(starred ? "unstar" : "star"));
			$("keep-sender").addEventListener("click", () => keep("sender", email.sender));
			renderBurn();
			renderAttachments(email.attachments || []);
			frame.srcdoc = FRAME_HEAD + (email.html || "") + "</body></html>";
			frame.hidden = false;
			status.hidden = true;
		} catch (e) {
			showError(e.message);
		}
	}
	load();
})();
`;
}

export function renderMiniAppPage(nonce: string): string {
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>邮件全文</title>
<script nonce="${nonce}" src="https://telegram.org/js/telegram-web-app.js"></script>
<style>${PAGE_CSS}</style>
</head>
<body>
<header id="header" class="card" hidden>
	<h1 id="subject"></h1>
	<div class="row"><span class="label">发件</span><span class="value" id="from"></span></div>
	<div class="row"><span class="label">收件</span><span class="value" id="to"></span></div>
	<div class="row" id="cc-row" hidden><span class="label">抄送</span><span class="value" id="cc"></span></div>
	<div class="row"><span class="label">时间</span><span class="value" id="date"></span></div>
</header>
<section id="burn" class="card" hidden>
	<p id="burn-text"></p>
	<div class="burn-actions" id="burn-actions">
		<button type="button" id="keep"></button>
		<button type="button" id="keep-sender" class="secondary">以后都保留此发件人</button>
	</div>
</section>
<section id="attachments" class="card" hidden>
	<h2>附件</h2>
	<ul id="attachment-list"></ul>
</section>
<div id="status">正在加载…</div>
<iframe id="frame" sandbox="allow-scripts" title="邮件正文" hidden></iframe>
<script nonce="${nonce}">${pageScript(nonce)}</script>
</body>
</html>`;
}
