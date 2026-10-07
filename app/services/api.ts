// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { BlacklistEntry, Email, Folder, Mailbox } from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `请求失败（${status}）`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(
	url: string,
	options: RequestInit = {},
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(url: string, opts?: { params?: Record<string, string>; responseType?: string; signal?: AbortSignal }) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

export interface TelegramSettings {
	enabled: boolean;
	botTokenConfigured: boolean;
	chatId: string;
	inboxBaseUrl: string;
	webhookConfigured: boolean;
	webhookUrl: string;
	polling: boolean;
	mode: "webhook" | "polling" | "link";
	lastPollAt?: string;
	lastPollError?: string;
}

export interface AutoDraftSettings {
	enabled: boolean;
}

export interface CloudflareSettings {
	tokenConfigured: boolean;
	tokenSource: "env" | "saved" | null;
	resendConfigured: boolean;
}

export interface CloudflareZone {
	id: string;
	name: string;
	status: string;
	accountName: string;
	configured: boolean;
}

export interface DomainSetupResult {
	domain: string;
	steps: { step: string; ok: boolean; message: string }[];
}

export interface DomainPurgeProgress {
	done: boolean;
	cursor: string | null;
	mailboxesDeleted: number;
	mailboxesRemaining: number;
	telegramRefsDeleted: number;
}

// ---------- API client ----------

const api = {
	// Config
	getConfig: () =>
		get<{ domains: string[]; emailAddresses: string[]; wildcard: Record<string, boolean> }>("/api/v1/config"),
	getWildcardSettings: () => get<Record<string, boolean>>("/api/v1/settings/wildcard"),
	updateWildcardSettings: (patch: Record<string, boolean>) =>
		put<Record<string, boolean>>("/api/v1/settings/wildcard", patch),
	getAutoDraftSettings: () => get<AutoDraftSettings>("/api/v1/settings/auto-draft"),
	updateAutoDraftSettings: (patch: AutoDraftSettings) =>
		put<AutoDraftSettings>("/api/v1/settings/auto-draft", patch),
	getCloudflareSettings: () => get<CloudflareSettings>("/api/v1/settings/cloudflare"),
	saveCloudflareToken: (apiToken: string) =>
		put<CloudflareSettings>("/api/v1/settings/cloudflare", { apiToken }),
	listAvailableDomains: () => get<{ zones: CloudflareZone[] }>("/api/v1/domains/available"),
	setupDomain: (body: { zoneId: string; replaceMx?: boolean; resend?: boolean }) =>
		post<DomainSetupResult>("/api/v1/domains", body),
	removeDomain: (domain: string, body: { cloudflare?: boolean; resend?: boolean }) =>
		post<DomainSetupResult>(`/api/v1/domains/${encodeURIComponent(domain)}/remove`, body),
	purgeDomain: (domain: string, cursor: string | null) =>
		post<DomainPurgeProgress>(`/api/v1/domains/${encodeURIComponent(domain)}/purge`, { cursor }),
	getTelegramSettings: () => get<TelegramSettings>("/api/v1/settings/telegram"),
	updateTelegramSettings: (patch: {
		enabled?: boolean;
		botToken?: string;
		chatId?: string;
		inboxBaseUrl?: string;
		polling?: boolean;
	}) => put<TelegramSettings>("/api/v1/settings/telegram", patch),
	discoverTelegramChat: () => post<TelegramSettings>("/api/v1/settings/telegram/discover"),
	testTelegram: () => post<{ ok: boolean }>("/api/v1/settings/telegram/test"),
	registerTelegramWebhook: () => post<TelegramSettings>("/api/v1/settings/telegram/webhook"),
	unregisterTelegramWebhook: () =>
		request<TelegramSettings>("/api/v1/settings/telegram/webhook", { method: "DELETE" }),
	getBlacklist: () => get<{ entries: BlacklistEntry[] }>("/api/v1/settings/blacklist"),
	addToBlacklist: (address: string) =>
		post<{ entries: BlacklistEntry[] }>("/api/v1/settings/blacklist", { address }),
	removeFromBlacklist: (address: string) =>
		request<{ entries: BlacklistEntry[] }>("/api/v1/settings/blacklist", {
			method: "DELETE",
			body: JSON.stringify({ address }),
		}),
	reportSpam: (mailboxId: string, emailId: string) =>
		post<{ status: string; sender: string | null; blocked: boolean }>(
			`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/spam`,
		),
	listUnifiedEmails: (params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse>("/api/v1/unified/emails", { params, signal: opts?.signal }),
	listUnifiedFolders: () =>
		get<{ unread: Record<string, number>; mailboxCount: number }>("/api/v1/unified/folders"),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Emails
	listEmails: (mailboxId: string, params: Record<string, string>, opts?: { signal?: AbortSignal }) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, { params, signal: opts?.signal }),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, { signal: opts?.signal }),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, { folderId }),
	getThread: (mailboxId: string, threadId: string, opts?: { signal?: AbortSignal }) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, { signal: opts?.signal }),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`, { responseType: "blob" }),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) => post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`, email),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, { params }),
};

export default api;
