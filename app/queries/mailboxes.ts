// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { type AutoDraftSettings, type BurnSettings, type BurnSettingsPatch, type KeepEntry } from "~/services/api";
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

export function useBurnSettings() {
	return useQuery<BurnSettings>({
		queryKey: queryKeys.burn,
		queryFn: () => api.getBurnSettings(),
	});
}

export function useUpdateBurnSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (patch: BurnSettingsPatch) => api.updateBurnSettings(patch),
		onSuccess: (data) => {
			qc.setQueryData(queryKeys.burn, data);
		},
	});
}

export function useAddKeepEntries() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ addresses, source }: { addresses: string[]; source?: KeepEntry["source"] }) =>
			api.addKeepEntries(addresses, source),
		onSuccess: ({ errors: _errors, ...settings }) => {
			qc.setQueryData(queryKeys.burn, settings);
			// Matching mail stops burning; the reader's banner reads the email's retention.
			qc.invalidateQueries({ queryKey: ["emails"] });
		},
	});
}

export function useRemoveKeepEntries() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (addresses: string[]) => api.removeKeepEntries(addresses),
		onSuccess: (data) => {
			qc.setQueryData(queryKeys.burn, data);
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
		mutationFn: (addresses: string[]) => api.addToBlacklist(addresses),
		onSuccess: ({ entries }) => {
			qc.setQueryData(queryKeys.blacklist, { entries });
			qc.invalidateQueries({ queryKey: ["emails"] });
			qc.invalidateQueries({ queryKey: ["unified-emails"] });
			qc.invalidateQueries({ queryKey: queryKeys.unified.folders });
		},
	});
}

export function useRemoveFromBlacklist() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (addresses: string[]) => api.removeFromBlacklist(addresses),
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
