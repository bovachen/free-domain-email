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
	keptSender: false,
	...overrides,
});

const newsletter = [{ key: "list-unsubscribe", value: "<https://news.example.com/u?id=1>" }];

// -- What burns ---------------------------------------------------------------

test("all mail burns after arrival: people, newsletters, notices, own domains", () => {
	assert.equal(classifyRetention(mail({})), "burn");
	assert.equal(classifyRetention(mail({ sender: "news@shop.example", headers: newsletter })), "burn");
	assert.equal(classifyRetention(mail({ headers: [{ key: "Auto-Submitted", value: "auto-generated" }] })), "burn");
	for (const sender of ["noreply@github.com", "notifications-noreply@linkedin.com", "do-not-reply@bank.example", "admin@iosclone.com"]) {
		assert.equal(classifyRetention(mail({ sender })), "burn", sender);
	}
	assert.equal(isBulkMail([{ key: "Precedence", value: "bulk" }]), true);
	assert.equal(isBulkMail([{ key: "Precedence", value: "first-class" }]), false);
	assert.equal(isAutomatedMail([{ key: "Auto-Submitted", value: "no" }], "bob@example.com"), false);
	assert.equal(isAutomatedMail([], "replyall@example.com"), false);
});

test("verification codes burn sooner, from a system sender or with a code subject", () => {
	assert.equal(classifyRetention(mail({ sender: "no-reply@accounts.example", subject: "Security alert", hasCode: true })), "code");
	assert.equal(classifyRetention(mail({ sender: "account@service.example", subject: "您的验证码", hasCode: true })), "code");
	assert.equal(classifyRetention(mail({ sender: "team@app.example", subject: "Your sign-in code", hasCode: true })), "code");
	assert.equal(classifyRetention(mail({ sender: "news@shop.example", subject: "Weekly", headers: newsletter, hasCode: true })), "code");
});

test("a person mentioning a code number gets the full time, not the code timer", () => {
	assert.equal(classifyRetention(mail({ subject: "线上报错", hasCode: true })), "burn");
});

// -- What stays ---------------------------------------------------------------

test("senders on the keep list keep everything, codes included", () => {
	assert.equal(classifyRetention(mail({ keptSender: true })), "keep");
	assert.equal(classifyRetention(mail({ keptSender: true, sender: "noreply@x.example", hasCode: true })), "keep");
});

// -- Wording ------------------------------------------------------------------

test("notices and countdowns read naturally", () => {
	assert.equal(burnNotice("code", DEFAULT_BURN_TIMES), "收到 1 小时后焚毁");
	assert.equal(burnNotice("burn", DEFAULT_BURN_TIMES), "收到 24 小时后焚毁");
	assert.equal(burnNotice("code", { ...DEFAULT_BURN_TIMES, codeMinutes: 90 }), "收到 90 分钟后焚毁");
	assert.equal(burnNotice("burn", { ...DEFAULT_BURN_TIMES, burnHours: 48 }), "收到 2 天后焚毁");
	assert.equal(formatTimeLeft(45), "45 分钟");
	assert.equal(formatTimeLeft(60 * 23 + 5), "23 小时 5 分钟");
	assert.equal(formatTimeLeft(120), "2 小时");
});
