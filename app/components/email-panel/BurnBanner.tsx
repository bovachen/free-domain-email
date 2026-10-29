// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, useKumoToastManager } from "@cloudflare/kumo";
import { Folders } from "shared/folders";
import { burnNotice, formatTimeLeft } from "shared/burn";
import { useAddKeepEntry, useBurnSettings } from "~/queries/mailboxes";
import type { Email } from "~/types";

interface BurnBannerProps {
	email: Email;
	onToggleStar: () => void;
}

/**
 * Burn-after-reading notice for the open email, with the two ways to keep
 * it: a star keeps this one, the keep list keeps everything from its sender.
 */
export default function BurnBanner({ email, onToggleStar }: BurnBannerProps) {
	const { data: settings } = useBurnSettings();
	const addKeepEntry = useAddKeepEntry();
	const toastManager = useKumoToastManager();

	if (!settings?.enabled || email.folder_id !== Folders.INBOX) return null;
	if (email.retention !== "code" && email.retention !== "burn") return null;

	let text: string;
	if (email.starred) {
		text = "📌 已保留（加了星标），不会焚毁。";
	} else {
		const minutesLeft = email.burn_at ? Math.max(1, Math.ceil((Date.parse(email.burn_at) - Date.now()) / 60_000)) : null;
		const when = minutesLeft ? `将在 ${formatTimeLeft(minutesLeft)}后焚毁` : burnNotice(email.retention, settings);
		text = `🔥 ${when}，之后在废纸篓里保留 ${settings.purgeDays} 天可恢复。`;
	}

	const handleKeepSender = async () => {
		try {
			await addKeepEntry.mutateAsync(email.sender);
			toastManager.add({ title: `已把 ${email.sender} 加入永久保留名单` });
		} catch (err) {
			toastManager.add({ title: err instanceof Error ? err.message : "保存失败", variant: "error" });
		}
	};

	return (
		<div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-kumo-line bg-kumo-tint text-sm text-kumo-default shrink-0 md:px-6">
			<span className="min-w-0 flex-1">{text}</span>
			{email.starred ? (
				<Button size="sm" variant="secondary" onClick={onToggleStar}>
					取消保留
				</Button>
			) : (
				<>
					<Button size="sm" variant="primary" onClick={onToggleStar}>
						保留
					</Button>
					<Button size="sm" variant="secondary" disabled={addKeepEntry.isPending} onClick={() => void handleKeepSender()}>
						以后都保留此发件人
					</Button>
				</>
			)}
		</div>
	);
}
