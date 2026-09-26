// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Pagination, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowsClockwiseIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	FlagIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Folders, getFolderDisplayName } from "shared/folders";
import { formatListDate } from "shared/dates";
import MailboxSplitView from "~/components/MailboxSplitView";
import { getSnippetText } from "~/lib/utils";
import {
	useDeleteEmail,
	useEmails,
	useMarkThreadRead,
	useReportSpam,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";

const PAGE_SIZE = 25;

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		title: string;
		description: string;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "收件箱是空的",
		description:
			"新邮件到达后会显示在这里。发一封邮件，开始对话吧。",
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<PaperPlaneTiltIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: "没有已发送的邮件",
		description: "发出的邮件会显示在这里。",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <FileIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "没有草稿",
		description: "还没写完的邮件会保存在这里。",
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <ArchiveIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "归档是空的",
		description:
			"把邮件移到这里，无需删除也能让收件箱保持整洁。",
	},
	[Folders.TRASH]: {
		icon: <TrashIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "废纸篓是空的",
		description:
			"删除的邮件会显示在这里，可以恢复或永久删除。",
	},
	[Folders.SPAM]: {
		icon: <WarningIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "没有垃圾邮件",
		description:
			"举报的垃圾邮件和已拉黑发件人的邮件会显示在这里。",
	},
};

function EmailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 w-4 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-12 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
}: {
	folder?: string;
	onCompose: () => void;
}) {
	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<EnvelopeSimpleIcon size={48} weight="thin" className="text-kumo-subtle" />
		),
		title: "没有邮件",
		description: "此文件夹是空的。",
	};

	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{config.icon}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				{config.title}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">
				{config.description}
			</p>
			{"showCompose" in config && config.showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<PencilSimpleIcon size={16} />}
					onClick={onCompose}
				>
					写邮件
				</Button>
			)}
		</div>
	);
}

export default function EmailListRoute() {
	const { mailboxId: mailboxIdParam, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();
	const mailboxId = mailboxIdParam ? decodeURIComponent(mailboxIdParam) : undefined;
	const unified = !mailboxId;
	const [searchParams] = useSearchParams();
	const deepEmailId = searchParams.get("email");
	const { setComposeMailboxId } = useUIStore();
	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const [page, setPage] = useState(1);
	const appliedDeepLink = useRef<string | null>(null);

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const deleteEmail = useDeleteEmail();
	const reportSpam = useReportSpam();
	const toastManager = useKumoToastManager();

	const params = useMemo(
		() => ({
			folder: folder || "",
			page: String(page),
			limit: String(PAGE_SIZE),
		}),
		[folder, page],
	);

	const {
		data: emailData,
		isFetching: isRefreshing,
	} = useEmails(mailboxId, params, { refetchInterval: 30_000 });

	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;

	const { data: folders = [] } = useFolders(mailboxId);

	const folderName = useMemo(() => {
		const found = folders.find((f) => f.id === folder);
		return getFolderDisplayName(folder || Folders.INBOX, found?.name);
	}, [folders, folder]);

	const isPanelOpen = selectedEmailId !== null || isComposing;

	// Track folder identity to detect folder changes vs page changes
	const prevFolderRef = useRef<string | undefined>(undefined);

	useEffect(() => {
		const folderChanged = prevFolderRef.current !== `${mailboxId}/${folder}`;
		prevFolderRef.current = `${mailboxId}/${folder}`;

		if (folderChanged) {
			if (!deepEmailId) closePanel();
			setPage(1);
		}
	}, [mailboxId, folder, closePanel, deepEmailId]);

	useEffect(() => {
		if (!deepEmailId || !mailboxId) return;
		const key = `${mailboxId}:${deepEmailId}`;
		if (appliedDeepLink.current === key) return;
		appliedDeepLink.current = key;
		selectEmail(deepEmailId, mailboxId);
		setComposeMailboxId(mailboxId);
	}, [deepEmailId, mailboxId, selectEmail, setComposeMailboxId]);

	const mailboxOf = (email: Email) => email.mailbox_id || mailboxId;

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		const box = mailboxOf(email);
		if (box)
			updateEmail.mutate({
				mailboxId: box,
				id: email.id,
				data: { starred: !email.starred },
			});
	};

	const handleDelete = (e: React.MouseEvent, emailId: string, boxId?: string) => {
		e.preventDefault();
		e.stopPropagation();
		const box = boxId || mailboxId;
		if (box) {
			const confirmed = window.confirm("确定要删除这封邮件吗？");
			if (!confirmed) return;
			deleteEmail.mutate({ mailboxId: box, id: emailId });
			if (selectedEmailId === emailId) closePanel();
		}
	};

	const handleReportSpam = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		const box = mailboxOf(email);
		if (!box) return;
		const blockLabel = email.sender ? `拉黑 ${email.sender}` : "拉黑该发件人";
		if (!window.confirm(`举报为垃圾邮件并${blockLabel}？之后该发件人的邮件会直接进入垃圾邮件。`)) {
			return;
		}
		reportSpam.mutate(
			{ mailboxId: box, id: email.id },
			{
				onSuccess: (result) => {
					toastManager.add({
						title: result.sender
							? `已拉黑 ${result.sender}，邮件已移到垃圾邮件`
							: "已移到垃圾邮件",
					});
					if (selectedEmailId === email.id) closePanel();
				},
				onError: (err) => {
					toastManager.add({
						title: err instanceof Error ? err.message : "举报失败",
						variant: "error",
					});
				},
			},
		);
	};

	const handleRefresh = () => {
		if (unified) {
			queryClient.invalidateQueries({ queryKey: queryKeys.unified.emails(params) });
			queryClient.invalidateQueries({ queryKey: queryKeys.unified.folders });
			return;
		}
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const handleRowClick = (email: Email) => {
		const box = mailboxOf(email);
		selectEmail(email.id, box);
		if (box) setComposeMailboxId(box);
		if (box && hasUnread(email)) {
			if (email.thread_id && email.thread_count && email.thread_count > 1) {
				markThreadRead.mutate({
					mailboxId: box,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId: box,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	const formatParticipants = (email: Email): string => {
		if (email.participants) {
			const names = email.participants
				.split(",")
				.map((p) => p.trim().split("@")[0])
				.filter((name, idx, arr) => arr.indexOf(name) === idx);
			if (names.length <= 3) return names.join(", ");
			return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
		}
		return email.sender.split("@")[0];
	};

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
				{/* Folder header */}
				<div className="flex items-center justify-between px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
					<h1 className="text-lg font-semibold text-kumo-default">
						{folderName}
					</h1>
					<div className="flex items-center gap-1">
						{totalCount > 0 && (
							<span className="text-sm text-kumo-subtle mr-2 hidden sm:inline">
								共 {totalCount} 个会话
							</span>
						)}
						<Tooltip
							content={isRefreshing ? "正在刷新…" : "刷新"}
							side="bottom"
							asChild
						>
							<Button
								variant="ghost"
								shape="square"
								size="sm"
								icon={
									<ArrowsClockwiseIcon
										size={18}
										className={isRefreshing ? "animate-spin" : ""}
									/>
								}
								onClick={handleRefresh}
								disabled={isRefreshing}
								aria-label="刷新"
							/>
						</Tooltip>
					</div>
				</div>

				{/* Email rows */}
				<div className="flex-1 overflow-y-auto">
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : emails.length > 0 ? (
						<div>
							{emails.map((email) => {
								const isSelected = selectedEmailId === email.id;
								const snippet = getSnippetText(email.snippet);
								return (
									<div
										key={`${email.mailbox_id || mailboxId || ""}:${email.id}`}
										role="button"
										tabIndex={0}
										onClick={() => handleRowClick(email)}
										onKeyDown={(e) => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												handleRowClick(email);
											}
										}}
										className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors border-b border-kumo-line px-4 py-2.5 md:px-6 md:py-3 ${
											isPanelOpen ? "md:px-4 md:py-2.5" : ""
										} ${isSelected ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
									>
										{/* Unread dot */}
										<div className="w-2.5 shrink-0 flex justify-center">
											{hasUnread(email) && (
												<div className="h-2 w-2 rounded-full bg-kumo-brand" />
											)}
										</div>

										{/* Star */}
										<button
											type="button"
											className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
											onClick={(e) => {
												e.stopPropagation();
												toggleStar(e, email);
											}}
										>
											<StarIcon
												size={16}
												weight={email.starred ? "fill" : "regular"}
												className={
													email.starred
														? "text-kumo-warning"
														: "text-kumo-subtle hover:text-kumo-warning"
												}
											/>
										</button>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span
													className={`truncate text-sm ${hasUnread(email) ? "font-semibold text-kumo-default" : "text-kumo-strong"}`}
												>
													{formatParticipants(email)}
												</span>
												{(email.thread_count ?? 1) > 1 && (
													<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
														{email.thread_count}
													</span>
												)}
												{email.has_draft && (
													<span className="shrink-0 text-xs text-kumo-destructive font-medium">
														草稿
													</span>
												)}
												{email.needs_reply && !email.has_draft && (
													<Tooltip content="待回复" asChild>
														<span className="shrink-0 text-kumo-warning">
															<ArrowBendUpLeftIcon size={14} weight="bold" />
														</span>
													</Tooltip>
												)}
												<span className="text-sm text-kumo-subtle shrink-0 ml-auto">
													{formatListDate(email.date)}
												</span>
											</div>
											{unified && email.mailbox_id && (
												<div className="text-xs text-kumo-subtle truncate mt-0.5">
													{email.mailbox_id}
												</div>
											)}
											<div className="truncate text-sm mt-0.5">
												<span
													className={hasUnread(email) ? "font-medium text-kumo-default" : "text-kumo-subtle"}
												>
													{email.subject}
												</span>
											{snippet && (
												<span className="text-kumo-subtle font-normal">
													{" "}&mdash; {snippet}
												</span>
											)}
										</div>
									</div>

										{/* Hover actions */}
										<div className="hidden group-hover:flex items-center shrink-0">
											<Tooltip content={email.read ? "标为未读" : "标为已读"} asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={email.read ? <EnvelopeSimpleIcon size={14} /> : <EnvelopeOpenIcon size={14} />}
													onClick={(e) => {
														e.stopPropagation();
														if (mailboxId)
															updateEmail.mutate({
																mailboxId,
																id: email.id,
																data: { read: !email.read },
															});
													}}
													aria-label={email.read ? "标为未读" : "标为已读"}
												/>
											</Tooltip>
											{folder !== Folders.SPAM && folder !== Folders.SENT && folder !== Folders.DRAFT && (
												<Tooltip content="举报垃圾邮件并拉黑发件人" asChild>
													<Button
														variant="ghost"
														shape="square"
														size="sm"
														icon={<FlagIcon size={14} className="text-kumo-destructive" />}
														onClick={(e) => handleReportSpam(e, email)}
														aria-label="举报垃圾邮件并拉黑发件人"
													/>
												</Tooltip>
											)}
											<Tooltip content="删除" asChild>
												<Button
													variant="ghost"
													shape="square"
													size="sm"
													icon={<TrashIcon size={14} />}
													onClick={(e) => handleDelete(e, email.id, mailboxOf(email))}
													aria-label="删除"
												/>
											</Tooltip>
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<FolderEmptyState
							folder={folder}
							onCompose={() => startCompose()}
						/>
					)}
				</div>

				{/* Pagination */}
				{totalCount > PAGE_SIZE && (
					<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
						<Pagination
							page={page}
							setPage={setPage}
							perPage={PAGE_SIZE}
							totalCount={totalCount}
							text={({ pageShowingRange }) => `第 ${pageShowingRange} 个会话，共 ${totalCount} 个`}
						/>
					</div>
				)}
		</MailboxSplitView>
	);
}
