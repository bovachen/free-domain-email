import assert from "node:assert/strict";
import test from "node:test";
import { sendEmail, usesResend } from "../workers/email-sender.ts";
import { relayAuthorized } from "../workers/lib/relay.ts";
import relay from "../relay/src/index.js";

// -- Relay endpoint auth -----------------------------------------------------

test("the relay endpoint stays closed while no secret is configured", () => {
	assert.equal(relayAuthorized(undefined, "Bearer anything"), false);
	assert.equal(relayAuthorized("", "Bearer "), false);
	assert.equal(relayAuthorized("", undefined), false);
});

test("only the exact bearer secret is accepted", () => {
	assert.equal(relayAuthorized("s3cret", "Bearer s3cret"), true);
	assert.equal(relayAuthorized("s3cret", "bearer  s3cret "), true);
	assert.equal(relayAuthorized("s3cret", "Bearer s3creT"), false);
	assert.equal(relayAuthorized("s3cret", "Bearer s3cret-and-more"), false);
	assert.equal(relayAuthorized("s3cret", "s3cret"), false);
	assert.equal(relayAuthorized("s3cret", "Basic s3cret"), false);
	assert.equal(relayAuthorized("s3cret", undefined), false);
});

// -- Sending channel per domain ----------------------------------------------

test("without a Resend key nothing goes through Resend", () => {
	assert.equal(usesResend({}, "a@6bee.ai"), false);
	assert.equal(usesResend({ RESEND_DOMAINS: "6bee.ai" }, "a@6bee.ai"), false);
});

test("a Resend key alone sends every domain through Resend", () => {
	assert.equal(usesResend({ RESEND_API_KEY: "re_x" }, "a@iosclone.com"), true);
	assert.equal(usesResend({ RESEND_API_KEY: "re_x", RESEND_DOMAINS: " , " }, "a@iosclone.com"), true);
});

test("RESEND_DOMAINS limits Resend to the listed sender domains", () => {
	const env = { RESEND_API_KEY: "re_x", RESEND_DOMAINS: "6bee.ai, @Example.org" };
	assert.equal(usesResend(env, "hi@6bee.ai"), true);
	assert.equal(usesResend(env, "Hi@6BEE.AI"), true);
	assert.equal(usesResend(env, { email: "hi@example.org", name: "Hi" }), true);
	assert.equal(usesResend(env, '"Hi" <hi@6bee.ai>'), true);
	assert.equal(usesResend(env, "admin@iosclone.com"), false);
	// Not a suffix match: a subdomain or look-alike is a different domain.
	assert.equal(usesResend(env, "hi@mail.6bee.ai"), false);
	assert.equal(usesResend(env, "hi@not6bee.ai"), false);
});

test("sendEmail picks the channel from the sender's domain", async () => {
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		calls.push(`resend:${String(input)}`);
		return new Response(JSON.stringify({ id: "resend-id" }), { status: 200 });
	}) as typeof fetch;
	const env = {
		RESEND_API_KEY: "re_x",
		RESEND_DOMAINS: "6bee.ai",
		EMAIL: {
			send: async (message: { from: string }) => {
				calls.push(`binding:${message.from}`);
				return { messageId: "cf-id" };
			},
		},
	} as never;
	try {
		const viaResend = await sendEmail(env, { to: "x@y.com", from: "hi@6bee.ai", subject: "s", text: "t" });
		const viaBinding = await sendEmail(env, { to: "x@y.com", from: "admin@iosclone.com", subject: "s", text: "t" });
		assert.equal(viaResend.messageId, "resend-id");
		assert.equal(viaBinding.messageId, "cf-id");
		assert.deepEqual(calls, ["resend:https://api.resend.com/emails", "binding:admin@iosclone.com"]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

// -- Relay Worker ------------------------------------------------------------

class PassThroughFixedLength extends TransformStream {
	constructor(_length: number) { super(); }
}

function fakeMessage(body: string) {
	const bytes = new TextEncoder().encode(body);
	return {
		to: "hi@6bee.ai",
		from: "someone@example.com",
		rawSize: bytes.byteLength,
		raw: new Blob([bytes]).stream(),
	};
}

test("the relay Worker posts the raw message with the envelope and the secret", async () => {
	const realFetch = globalThis.fetch;
	(globalThis as Record<string, unknown>).FixedLengthStream = PassThroughFixedLength;
	let seen: { url: string; headers: Headers; body: string } | undefined;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		seen = {
			url: String(input),
			headers: new Headers(init?.headers),
			body: await new Response(init?.body as ReadableStream).text(),
		};
		return new Response('{"ok":true}', { status: 200 });
	}) as typeof fetch;
	try {
		await relay.email(fakeMessage("Subject: hi\r\n\r\nbody"), {
			INBOX_URL: "https://inbox.example.com/",
			RELAY_SECRET: "s3cret",
		});
		assert.equal(seen?.url, "https://inbox.example.com/api/relay/inbound");
		assert.equal(seen?.headers.get("authorization"), "Bearer s3cret");
		assert.equal(seen?.headers.get("x-envelope-to"), "hi@6bee.ai");
		assert.equal(seen?.body, "Subject: hi\r\n\r\nbody");
		assert.equal(relayAuthorized("s3cret", seen?.headers.get("authorization") ?? undefined), true);
	} finally {
		globalThis.fetch = realFetch;
		delete (globalThis as Record<string, unknown>).FixedLengthStream;
	}
});

test("the relay Worker fails the delivery when the inbox refuses or is unconfigured", async () => {
	const realFetch = globalThis.fetch;
	(globalThis as Record<string, unknown>).FixedLengthStream = PassThroughFixedLength;
	globalThis.fetch = (async () => new Response("Forbidden", { status: 403 })) as typeof fetch;
	try {
		await assert.rejects(
			relay.email(fakeMessage("x"), { INBOX_URL: "https://inbox.example.com", RELAY_SECRET: "wrong" }),
			/inbox answered 403 for hi@6bee\.ai/,
		);
		await assert.rejects(relay.email(fakeMessage("x"), { INBOX_URL: "https://inbox.example.com" }), /not configured/);
	} finally {
		globalThis.fetch = realFetch;
		delete (globalThis as Record<string, unknown>).FixedLengthStream;
	}
});
