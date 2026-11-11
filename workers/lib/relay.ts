// Cross-account inbound relay.
//
// Email Routing can only hand mail to a Worker in the zone's own Cloudflare
// account. For a domain that lives in another account, a small relay Worker
// there (see relay/) receives the message and POSTs the raw MIME here. The
// request cannot hold a Cloudflare Access session, so it authenticates with
// the shared RELAY_SECRET instead; app.ts exempts the path from the Access
// JWT check, and the Access application must bypass it too.

export const RELAY_INBOUND_PATH = "/api/relay/inbound";

/** Header carrying the SMTP envelope recipient the relay Worker received for. */
export const RELAY_ENVELOPE_TO_HEADER = "x-envelope-to";

function sameString(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * True when the request presents `Authorization: Bearer <RELAY_SECRET>`.
 * Always false while no secret is configured, so the endpoint stays closed
 * on deployments that do not use a relay.
 */
export function relayAuthorized(secret: string | undefined, authorization: string | undefined): boolean {
	if (!secret || !authorization) return false;
	const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
	return match !== null && sameString(match[1], secret);
}
