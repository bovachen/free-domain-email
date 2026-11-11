// Inbound relay for a domain that lives in a different Cloudflare account
// than the inbox Worker.
//
// Email Routing can only deliver to a Worker in the zone's own account, so
// this Worker is deployed there (the free plan is enough), set as the
// domain's catch-all target, and passes every message on to the inbox over
// HTTPS. It stores nothing and sends no mail itself.
//
// Settings (Worker → Settings → Variables and Secrets, or wrangler):
//   INBOX_URL     variable  the inbox's address, e.g. https://inbox.example.com
//   RELAY_SECRET  secret    the same value as the inbox Worker's RELAY_SECRET
//
// Plain JavaScript with no imports, so it can also be pasted straight into
// the dashboard editor.

const INBOUND_PATH = "/api/relay/inbound";

export default {
	async email(message, env) {
		if (!env.INBOX_URL || !env.RELAY_SECRET) {
			throw new Error("relay is not configured: set INBOX_URL and RELAY_SECRET");
		}

		const response = await fetch(new URL(INBOUND_PATH, env.INBOX_URL), {
			method: "POST",
			headers: {
				authorization: `Bearer ${env.RELAY_SECRET}`,
				"content-type": "message/rfc822",
				"x-envelope-to": message.to,
				"x-envelope-from": message.from,
			},
			// FixedLengthStream gives the request a Content-Length, so the raw
			// message streams through without being buffered here.
			body: message.raw.pipeThrough(new FixedLengthStream(message.rawSize)),
		});

		if (!response.ok) {
			// Throwing fails the delivery, so the sending server retries or
			// bounces instead of the message vanishing. A 403 here means the
			// two RELAY_SECRET values differ or the inbox's Cloudflare Access
			// application does not bypass the relay path.
			const detail = (await response.text()).slice(0, 200);
			throw new Error(`inbox answered ${response.status} for ${message.to}: ${detail}`);
		}
	},
};
