import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { canUseMiniApp, isTelegramAppPath, miniAppUrl, verifyInitData } from "../workers/lib/telegram-miniapp.ts";

const BOT_TOKEN = "123456:TEST-token";
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

/**
 * Init data the way Telegram builds it, written independently of the code
 * under test: sorted key=value lines, HMAC'd with HMAC("WebAppData", token).
 */
function signInitData(fields: Record<string, string>, token = BOT_TOKEN, signOver = Object.keys(fields)): string {
	const secret = createHmac("sha256", "WebAppData").update(token).digest();
	const lines = Object.entries(fields)
		.filter(([key]) => signOver.includes(key))
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join("\n");
	const hash = createHmac("sha256", secret).update(lines).digest("hex");
	return new URLSearchParams({ ...fields, hash }).toString();
}

const user = JSON.stringify({ id: 987654321, first_name: "Test User", username: "tester" });
const fields = { auth_date: String(NOW / 1000 - 60), query_id: "AAHdF6IQAAAAAN0XohDhrOrc", user };

// -- Init data -------------------------------------------------------------

test("init data signed with the bot token yields the Telegram user ID", async () => {
	assert.equal(await verifyInitData(signInitData(fields), BOT_TOKEN, NOW), "987654321");
});

test("init data from another bot, or edited after signing, is refused", async () => {
	assert.equal(await verifyInitData(signInitData(fields, "999:other-bot"), BOT_TOKEN, NOW), null);
	const tampered = signInitData(fields).replace("987654321", "123123123");
	assert.equal(await verifyInitData(tampered, BOT_TOKEN, NOW), null);
});

test("init data older than a day is refused", async () => {
	const stale = { ...fields, auth_date: String(NOW / 1000 - 25 * 60 * 60) };
	assert.equal(await verifyInitData(signInitData(stale), BOT_TOKEN, NOW), null);
});

test("the signature field is accepted whether or not the hash covers it", async () => {
	const withSignature = { ...fields, signature: "ZmFrZS1lZDI1NTE5LXNpZ25hdHVyZQ" };
	assert.equal(await verifyInitData(signInitData(withSignature), BOT_TOKEN, NOW), "987654321");
	const hashedWithout = signInitData(withSignature, BOT_TOKEN, Object.keys(fields));
	assert.equal(await verifyInitData(hashedWithout, BOT_TOKEN, NOW), "987654321");
});

test("missing init data, hash, token or user is refused", async () => {
	assert.equal(await verifyInitData("", BOT_TOKEN, NOW), null);
	assert.equal(await verifyInitData(new URLSearchParams(fields).toString(), BOT_TOKEN, NOW), null);
	assert.equal(await verifyInitData(signInitData(fields), "", NOW), null);
	const { user: _user, ...noUser } = fields;
	assert.equal(await verifyInitData(signInitData(noUser), BOT_TOKEN, NOW), null);
});

// -- Button and routes -------------------------------------------------------

test("the 查看全文 button needs an https inbox URL and a private chat", () => {
	assert.equal(canUseMiniApp({ inboxBaseUrl: "https://inbox.example.com", chatId: "987654321" }), true);
	assert.equal(canUseMiniApp({ inboxBaseUrl: "http://localhost:5173", chatId: "987654321" }), false);
	assert.equal(canUseMiniApp({ inboxBaseUrl: "https://inbox.example.com", chatId: "-1001234567890" }), false);
	assert.equal(canUseMiniApp({ inboxBaseUrl: "https://inbox.example.com", chatId: "" }), false);
});

test("the Mini App URL carries the mailbox and email, encoded", () => {
	assert.equal(
		miniAppUrl("https://inbox.example.com/", "me@example.com", "a/b"),
		"https://inbox.example.com/api/telegram/app?mailbox=me%40example.com&email=a%2Fb",
	);
});

test("only the Mini App page and its API skip Cloudflare Access", () => {
	assert.equal(isTelegramAppPath("/api/telegram/app"), true);
	assert.equal(isTelegramAppPath("/api/telegram/app/email"), true);
	assert.equal(isTelegramAppPath("/api/telegram/apple"), false);
	assert.equal(isTelegramAppPath("/api/telegram/webhook"), false);
	assert.equal(isTelegramAppPath("/api/v1/mailboxes"), false);
});
