import assert from "node:assert/strict";
import test from "node:test";
import PostalMime from "postal-mime";
import { isShownInBody, listedAttachments } from "../shared/attachments.ts";

/** An iPhone Mail message the way it arrives: a photo marked inline in plain-text mail. */
const IPHONE_PHOTO_MAIL = [
	"From: someone@icloud.com",
	"To: admin@example.com",
	"Subject: ",
	"MIME-Version: 1.0",
	'Content-Type: multipart/mixed; boundary="Apple-Mail-1"',
	"",
	"--Apple-Mail-1",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"到这步，然后怎么操作",
	"--Apple-Mail-1",
	'Content-Type: image/jpeg; name="IMG_0001.jpeg"',
	'Content-Disposition: inline; filename="IMG_0001.jpeg"',
	"Content-Transfer-Encoding: base64",
	"Content-Id: <8F2A-11@apple.com>",
	"",
	Buffer.from("jpeg bytes").toString("base64"),
	"--Apple-Mail-1",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"发自我的 iPhone",
	"--Apple-Mail-1--",
	"",
].join("\r\n");

test("an iPhone photo in plain-text mail is listed, though marked inline", async () => {
	const parsed = await new PostalMime().parse(IPHONE_PHOTO_MAIL);
	const attachments = parsed.attachments.map((att) => ({
		filename: att.filename,
		content_id: att.contentId ?? null,
		disposition: att.disposition,
	}));
	assert.equal(attachments[0].disposition, "inline");
	const body = parsed.html || parsed.text || "";
	assert.deepEqual(listedAttachments(attachments, body).map((att) => att.filename), ["IMG_0001.jpeg"]);
});

test("an inline image the HTML body shows through cid: is left out", () => {
	const logo = { content_id: "<Logo@Example.com>", disposition: "inline" };
	const body = '<p>Hi</p><img src="cid:logo@example.com">';
	assert.equal(isShownInBody(logo, body), true);
	assert.deepEqual(listedAttachments([logo], body), []);
});

test("regular attachments are always listed, even when the body links them", () => {
	const pdf = { content_id: "<doc@example.com>", disposition: "attachment" };
	assert.equal(isShownInBody(pdf, '<a href="cid:doc@example.com">'), false);
	assert.equal(isShownInBody({ content_id: null, disposition: "attachment" }, "<p>Hi</p>"), false);
});

test("inline parts without a usable Content-Id are listed", () => {
	assert.equal(isShownInBody({ content_id: null, disposition: "inline" }, "cid:"), false);
	assert.equal(isShownInBody({ content_id: "<>", disposition: "inline" }, '<img src="cid:">'), false);
	assert.deepEqual(listedAttachments(undefined, ""), []);
});
