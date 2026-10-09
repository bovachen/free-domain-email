import assert from "node:assert/strict";
import test from "node:test";
import { isFreemailDomain, matchBlockRule, parseBlockTarget } from "../shared/sender.ts";
import {
	authVerdict,
	checkInboundSpam,
	classifyWithAi,
	extractLinkHosts,
	parseAuthResults,
	parseClassifierReply,
} from "../workers/lib/spam-filter.ts";

// -- Block targets -----------------------------------------------------------

test("a full address blocks one sender, a bare or @-prefixed domain blocks the domain", () => {
	assert.deepEqual(parseBlockTarget("post@gtwj88.com"), { type: "address", value: "post@gtwj88.com" });
	assert.deepEqual(parseBlockTarget("Spam Co <Post@GTWJ88.com>"), { type: "address", value: "post@gtwj88.com" });
	assert.deepEqual(parseBlockTarget("gtwj88.com"), { type: "domain", value: "gtwj88.com" });
	assert.deepEqual(parseBlockTarget(" @GTWJ88.com "), { type: "domain", value: "gtwj88.com" });
	assert.deepEqual(parseBlockTarget("*@gtwj88.com"), { type: "domain", value: "gtwj88.com" });
	assert.deepEqual(parseBlockTarget("*.gtwj88.com"), { type: "domain", value: "gtwj88.com" });
	assert.equal(parseBlockTarget("not a domain"), null);
	assert.equal(parseBlockTarget("localhost"), null);
	assert.equal(parseBlockTarget(""), null);
});

test("a domain rule covers its subdomains but not lookalike domains", () => {
	const rules = [{ address: "gtwj88.com", type: "domain" as const }];
	assert.ok(matchBlockRule(rules, "post@gtwj88.com"));
	assert.ok(matchBlockRule(rules, "IT 通知 <it@mail.gtwj88.com>"));
	assert.equal(matchBlockRule(rules, "post@evilgtwj88.com"), null);
	assert.equal(matchBlockRule(rules, "post@gtwj88.com.cn"), null);
	assert.equal(matchBlockRule(rules, ""), null);
});

test("an address rule, including one saved before rules had a type, matches only that address", () => {
	const rules = [{ address: "spammer@gmail.com" }, { address: "other@example.com", type: "address" as const }];
	assert.ok(matchBlockRule(rules, "Spammer <SPAMMER@gmail.com>"));
	assert.ok(matchBlockRule(rules, "other@example.com"));
	assert.equal(matchBlockRule(rules, "friend@gmail.com"), null);
});

test("public mailbox providers cannot be blocked as a whole", () => {
	for (const d of ["gmail.com", "outlook.com", "hotmail.com", "qq.com", "vip.qq.com", "163.com", "@icloud.com"]) {
		assert.equal(isFreemailDomain(d), true, d);
	}
	for (const d of ["gtwj88.com", "example.com", "notgmail.com"]) {
		assert.equal(isFreemailDomain(d), false, d);
	}
});

// -- Authentication results ---------------------------------------------------

const cfHeader = (value: string) => ({ key: "arc-authentication-results", value });

test("reads the verdicts Cloudflare recorded", () => {
	const auth = parseAuthResults([
		{ key: "received", value: "from mx.example" },
		cfHeader(
			"i=1; mx.cloudflare.net;\r\n dkim=pass header.d=gtwj88.com header.s=s1 header.b=abc;\r\n dmarc=pass header.from=gtwj88.com policy.dmarc=none;\r\n spf=none (mx.cloudflare.net: no SPF record) smtp.helo=mx.gtwj88.com;\r\n spf=pass (mx.cloudflare.net: domain designates 195.21.155.215 as permitted sender) smtp.mailfrom=post@gtwj88.com;\r\n arc=none smtp.remote-ip=195.21.155.215",
		),
	]);
	assert.deepEqual(auth, { dkim: "pass", dmarc: "pass", dmarcPolicy: "none", spf: "pass", arc: "none" });
	assert.equal(authVerdict(auth), null);
});

test("a DMARC failure means a forged From address", () => {
	const auth = parseAuthResults([
		cfHeader("i=1; mx.cloudflare.net; dkim=none; dmarc=fail reason=\"SPF not aligned\" header.from=iosclone.com policy.dmarc=none; spf=pass smtp.mailfrom=bounce@bulk.example"),
	]);
	assert.equal(auth?.dmarc, "fail");
	assert.equal(authVerdict(auth)?.spam, true);
	assert.equal(authVerdict(auth)?.source, "auth");
});

test("forwarded mail with a verified ARC chain is not condemned for failing DMARC", () => {
	const auth = parseAuthResults([
		cfHeader("i=2; mx.cloudflare.net; dkim=none; dmarc=fail header.from=shop.example policy.dmarc=quarantine; spf=pass smtp.mailfrom=bounces+srs@gmail.com; arc=pass (i=1 spf=pass dkim=pass)"),
	]);
	assert.equal(auth?.arc, "pass");
	assert.equal(authVerdict(auth), null);
});

test("ignores authentication headers a sender planted below Cloudflare's, or from other servers", () => {
	const headers = [
		cfHeader("i=1; mx.cloudflare.net; dkim=pass header.d=x.com; dmarc=fail header.from=x.com; spf=pass"),
		{ key: "authentication-results", value: "mx.cloudflare.net; dkim=pass; dmarc=pass; spf=pass" },
	];
	assert.equal(parseAuthResults(headers)?.dmarc, "fail");
	assert.equal(parseAuthResults([{ key: "authentication-results", value: "mx.google.com; dmarc=fail" }]), null);
	assert.equal(parseAuthResults(undefined), null);
});

test("one passing DKIM signature counts even when another failed", () => {
	const auth = parseAuthResults([cfHeader("i=1; mx.cloudflare.net; dkim=fail header.d=a.com; dkim=pass header.d=b.com; dmarc=pass")]);
	assert.equal(auth?.dkim, "pass");
});

// -- Content ---------------------------------------------------------------------

test("collects link hosts, most frequent first", () => {
	const html = '<a href="https://verify.gtwj88-secure.top/login">点击此处</a> <a href="http://verify.gtwj88-secure.top/x">x</a> <img src="https://cdn.example.com/a.png">';
	assert.deepEqual(extractLinkHosts(html, ""), ["verify.gtwj88-secure.top", "cdn.example.com"]);
	assert.deepEqual(extractLinkHosts("", "no links here"), []);
});

test("parses the classifier's label and reason", () => {
	assert.deepEqual(parseClassifierReply("PHISHING\n冒充邮箱管理员催促二次认证"), {
		label: "PHISHING",
		reason: "冒充邮箱管理员催促二次认证",
	});
	assert.deepEqual(parseClassifierReply("<think>\n\n</think>\n\nSPAM\n理由：发票代开广告"), {
		label: "SPAM",
		reason: "发票代开广告",
	});
	assert.equal(parseClassifierReply("OK")?.label, "OK");
	assert.equal(parseClassifierReply("I am not sure"), null);
});

const phishing = {
	fromName: "邮箱信息安全管理委员会",
	fromAddress: "post@gtwj88.com",
	recipient: "admin@iosclone.com",
	subject: "【IT通知】邮箱安全状态提醒",
	text: "企业邮箱安全中心监测到您的账号于异地登录有多次密码输入错误的记录……请您立即在 12 小时内完成身份二次认证，否则账号将被系统强制锁定！点击此处完成身份二次认证",
	linkHosts: ["verify.gtwj88-secure.top"],
};

function fakeAi(reply: unknown) {
	const calls: unknown[] = [];
	const ai = {
		async run(_model: string, input: unknown) {
			calls.push(input);
			if (reply instanceof Error) throw reply;
			return reply;
		},
	} as unknown as Ai;
	return { ai, calls };
}

test("an AI phishing verdict sends the mail to spam with the reason", async () => {
	const { ai, calls } = fakeAi({ choices: [{ message: { content: "PHISHING\n冒充管理员，催促点击链接认证" } }] });
	const verdict = await classifyWithAi(ai, { ...phishing, auth: null });
	assert.deepEqual(verdict, { spam: true, source: "ai", reason: "疑似钓鱼：冒充管理员，催促点击链接认证" });
	// The model sees the sender, the link hosts and the body.
	const prompt = JSON.stringify(calls[0]);
	assert.match(prompt, /post@gtwj88\.com/);
	assert.match(prompt, /verify\.gtwj88-secure\.top/);
	assert.match(prompt, /二次认证/);
});

test("ordinary mail stays in the inbox, and so does mail the model fails on", async () => {
	assert.equal((await classifyWithAi(fakeAi({ response: "OK\n正常通知" }).ai, { ...phishing, auth: null })).spam, false);
	assert.equal((await classifyWithAi(fakeAi("gibberish").ai, { ...phishing, auth: null })).spam, false);
	assert.equal((await classifyWithAi(fakeAi(new Error("capacity")).ai, { ...phishing, auth: null })).spam, false);
});

test("a DMARC failure is decided without asking the model; known contacts skip the model", async () => {
	const failing = [cfHeader("i=1; mx.cloudflare.net; dmarc=fail header.from=iosclone.com; spf=pass")];
	const passing = [cfHeader("i=1; mx.cloudflare.net; dkim=pass; dmarc=pass; spf=pass")];

	const spoof = fakeAi({ response: "OK" });
	assert.equal((await checkInboundSpam(spoof.ai, { ...phishing, headers: failing })).source, "auth");
	assert.equal(spoof.calls.length, 0);

	const contact = fakeAi({ response: "PHISHING\nx" });
	assert.deepEqual(await checkInboundSpam(contact.ai, { ...phishing, headers: passing, skipAi: true }), {
		spam: false,
		source: "none",
	});
	assert.equal(contact.calls.length, 0);

	const stranger = fakeAi({ response: "PHISHING\nx" });
	assert.equal((await checkInboundSpam(stranger.ai, { ...phishing, headers: passing })).spam, true);
	assert.equal(stranger.calls.length, 1);
});
