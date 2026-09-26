// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	index,
	type RouteConfig,
	route,
} from "@react-router/dev/routes";

export default [
	index("routes/home.tsx"),
	route("mail", "routes/mail-layout.tsx", [
		route("emails/:folder", "routes/email-list.tsx", { id: "mail-unified-list" }),
		route("search", "routes/search-results.tsx", { id: "mail-unified-search" }),
		route("mailbox/:mailboxId/emails/:folder", "routes/email-list.tsx", { id: "mail-account-list" }),
		route("mailbox/:mailboxId/settings", "routes/settings.tsx", { id: "mail-account-settings" }),
		route("mailbox/:mailboxId/search", "routes/search-results.tsx", { id: "mail-account-search" }),
	]),
	route("mailbox/:mailboxId", "routes/mailbox.tsx", [
		index("routes/mailbox-index.tsx"),
		route("emails/:folder", "routes/email-list.tsx", { id: "legacy-email-list" }),
		route("settings", "routes/settings.tsx", { id: "legacy-settings" }),
		route("search", "routes/search-results.tsx", { id: "legacy-search" }),
	]),
	route("report-spam", "routes/report-spam.tsx"),
	route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
