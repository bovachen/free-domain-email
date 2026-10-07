// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type AutoDraftSettings } from "~/services/api";
import type { BlacklistEntry, Mailbox } from "~/types";
import { queryKeys } from "./keys";

export function useMailboxes() {
	return useQuery<Mailbox[]>({
		queryKey: queryKeys.mailboxes.all,
		queryFn: () => api.listMailboxes() as Promise<Mailbox[]>,
	});
}

export function useMailbox(mailboxId: string | undefined) {
	return useQuery<Mailbox>({
		queryKey: mailboxId
			? queryKeys.mailboxes.detail(mailboxId)
			: ["mailboxes", "_disabled"],
		queryFn: () => api.getMailbox(mailboxId!) as Promise<Mailbox>,
		enabled: !!mailboxId,
	});
}

export function useCreateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ email, name }: { email: string; name: string }) =>
			api.createMailbox(email, name),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useUpdateMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			settings,
		}: { mailboxId: string; settings: unknown }) =>
			api.updateMailbox(mailboxId, settings),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.detail(mailboxId) });
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}

export function useWildcardSettings() {
	return useQuery<Record<string, boolean>>({
		queryKey: queryKeys.wildcard,
		queryFn: () => api.getWildcardSettings(),
	});
}

export function useUpdateWildcardSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (patch: Record<string, boolean>) =>
			api.updateWildcardSettings(patch),
		onSuccess: (data) => {
			qc.setQueryData(queryKeys.wildcard, data);
			qc.invalidateQueries({ queryKey: queryKeys.config });
		},
	});
}

export function useAutoDraftSettings() {
	return useQuery<AutoDraftSettings>({
		queryKey: queryKeys.autoDraft,
		queryFn: () => api.getAutoDraftSettings(),
	});
}

export function useUpdateAutoDraftSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (patch: AutoDraftSettings) => api.updateAutoDraftSettings(patch),
		onSuccess: (data) => {
			qc.setQueryData(queryKeys.autoDraft, data);
		},
	});
}

export function useTelegramSettings() {
	return useQuery({
		queryKey: queryKeys.telegram,
		queryFn: () => api.getTelegramSettings(),
	});
}

export function useUpdateTelegramSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (
			patch: Parameters<typeof api.updateTelegramSettings>[0],
		) => api.updateTelegramSettings(patch),
		onSuccess: (data) => {
			qc.setQueryData(queryKeys.telegram, data);
		},
	});
}

export function useBlacklist() {
	return useQuery<{ entries: BlacklistEntry[] }>({
		queryKey: queryKeys.blacklist,
		queryFn: () => api.getBlacklist(),
	});
}

export function useAddToBlacklist() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (address: string) => api.addToBlacklist(address),
		onSuccess: (data) => {
			qc.setQueryData(queryKeys.blacklist, data);
			qc.invalidateQueries({ queryKey: ["emails"] });
			qc.invalidateQueries({ queryKey: ["unified-emails"] });
			qc.invalidateQueries({ queryKey: queryKeys.unified.folders });
		},
	});
}

export function useRemoveFromBlacklist() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (address: string) => api.removeFromBlacklist(address),
		onSuccess: (data) => {
			qc.setQueryData(queryKeys.blacklist, data);
		},
	});
}

export function useUnifiedFolders() {
	return useQuery({
		queryKey: queryKeys.unified.folders,
		queryFn: () => api.listUnifiedFolders(),
		refetchInterval: 30_000,
	});
}

export function useDeleteMailbox() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (mailboxId: string) => api.deleteMailbox(mailboxId),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
		},
	});
}
