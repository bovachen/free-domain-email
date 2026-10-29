import assert from "node:assert/strict";
import test from "node:test";
import {
	burnNotice,
	classifyRetention,
	DEFAULT_BURN_TIMES,
	formatTimeLeft,
	isAutomatedMail,
	isBulkMail,
	type RetentionInput,
} from "../shared/burn.ts";

const mail = (overrides: Partial<RetentionInput>): RetentionInput => ({
	sender: "alice@example.com",
	subject: "周五的会",
	headers: [],
	hasCode: false,
	hasAttachments: false,
	trustedSender: false,
	...overrides,
});

const newsletter = [{ key: "list-unsubscribe", value: "<https://news.example.com/u?id=1>" }];

// -- What burns ---------------------------------------------------------------

test("newsletters and mailing-list mail burn after reading", () => {
	assert.equal(classifyRetention(mail({ sender: "news@shop.example", headers: newsletter })), "burn");
	assert.equal(classifyRetention(mail({ headers: [{ key: "List-Id", value: "<dev.lists.example.org>" }] })), "burn");
	assert.equal(classifyRetention(mail({ headers: [{ key: "Precedence", value: "bulk" }] })), "burn");
});

test("automated notices and noreply senders burn after reading", () => {
	assert.equal(classifyRetention(mail({ headers: [{ key: "Auto-Submitted", value: "auto-generated" }] })), "burn");
	for (const sender of ["noreply@github.com", "no-reply@accounts.google.com", "notifications-noreply@linkedin.com", "do-not-reply@bank.example"]) {
		assert.equal(classifyRetention(mail({ sender })), "burn", sender);
	}
	assert.equal(isAutomatedMail([{ key: "Auto-Submitted", value: "no" }], "bob@example.com"), false);
	assert.equal(isAutomatedMail([], "replyall@example.com"), false);
});

test("verification codes burn on a timer, from a noreply sender or with a code subject", () => {
	assert.equal(classifyRetention(mail({ sender: "no-reply@accounts.example", subject: "Security alert", hasCode: true })), "code");
	assert.equal(classifyRetention(mail({ sender: "account@service.example", subject: "您的验证码", hasCode: true })), "code");
	assert.equal(classifyRetention(mail({ sender: "team@app.example", subject: "Your sign-in code", hasCode: true })), "code");
});

// -- What stays ---------------------------------------------------------------

test("a person mentioning a code number is not a verification email", () => {
	assert.equal(classifyRetention(mail({ subject: "线上报错", hasCode: true })), "keep");
});

test("ordinary mail from people is kept", () => {
	assert.equal(classifyRetention(mail({})), "keep");
	assert.equal(isBulkMail([{ key: "Precedence", value: "first-class" }]), false);
});

test("trusted senders keep even their newsletters and codes", () => {
	assert.equal(classifyRetention(mail({ trustedSender: true, headers: newsletter })), "keep");
	assert.equal(classifyRetention(mail({ trustedSender: true, sender: "noreply@x.example", hasCode: true })), "keep");
});

test("attachments keep automated mail (invoices from noreply@), but not newsletters", () => {
	assert.equal(classifyRetention(mail({ sender: "noreply@billing.example", subject: "Invoice", hasAttachments: true })), "keep");
	assert.equal(classifyRetention(mail({ headers: newsletter, hasAttachments: true })), "burn");
});

// -- Wording ------------------------------------------------------------------

test("notices and countdowns read naturally", () => {
	assert.equal(burnNotice("code", DEFAULT_BURN_TIMES), "收到 1 小时后焚毁");
	assert.equal(burnNotice("burn", DEFAULT_BURN_TIMES), "读后 24 小时焚毁");
	assert.equal(burnNotice("code", { ...DEFAULT_BURN_TIMES, codeMinutes: 90 }), "收到 90 分钟后焚毁");
	assert.equal(burnNotice("burn", { ...DEFAULT_BURN_TIMES, readHours: 48 }), "读后 2 天焚毁");
	assert.equal(formatTimeLeft(45), "45 分钟");
	assert.equal(formatTimeLeft(60 * 23 + 5), "23 小时 5 分钟");
	assert.equal(formatTimeLeft(120), "2 小时");
});
