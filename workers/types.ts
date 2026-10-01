// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	/** Optional: send outbound mail through Resend instead of the `send_email` binding. */
	RESEND_API_KEY?: string;
	/** Optional: Cloudflare API token for "添加域名"; wins over a token saved in the web UI. */
	CLOUDFLARE_API_TOKEN?: string;
	/** Optional: catch-all target when no existing domain already routes to this Worker. */
	WORKER_NAME?: string;
}
