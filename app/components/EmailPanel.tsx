// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { Folders } from "shared/folders";
import EmailPanelDialogs from "~/components/email-panel/EmailPanelDialogs";
import EmailPanelHeader from "~/components/email-panel/EmailPanelHeader";
import EmailPanelToolbar from "~/components/email-panel/EmailPanelToolbar";
import SingleMessageView from "~/components/email-panel/SingleMessageView";
import ThreadMessage from "~/components/email-panel/ThreadMessage";
import { splitEmailList, toEmailListValue } from "~/lib/utils";
import api from "~/services/api";
import { useDeleteEmail, useEmail, useMoveEmail, useReplyToEmail, useReportSpam, useSendEmail, useThreadReplies, useUpdateEmail } from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { useMailbox } from "~/queries/mailboxes";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email, Folder, Mailbox } from "~/types";

function EmailPanelSkeleton() {
	return (
		<div className="animate-pulse p-5 space-y-4">
			<div className="h-5 w-2/3 rounded bg-kumo-fill" />
			<div className="flex items-center gap-3"><div className="w-10 h-10 rounded-full bg-kumo-fill" /><div className="space-y-2 flex-1"><div className="h-3 w-40 rounded bg-kumo-fill" /><div className="h-2.5 w-24 rounded bg-kumo-fill" /></div></div>
			<div className="space-y-2 pt-4"><div className="h-2.5 w-full rounded bg-kumo-fill" /><div className="h-2.5 w-5/6 rounded bg-kumo-fill" /><div className="h-2.5 w-4/6 rounded bg-kumo-fill" /><div className="h-2.5 w-3/4 rounded bg-kumo-fill" /></div>
		</div>
	);
}

export default function EmailPanel({ emailId }: { emailId: string }) {
	const { mailboxId: mailboxIdParam, folder } = useParams<{ mailboxId: string; folder: string }>();
	const selectedMailboxId = useUIStore((s) => s.selectedMailboxId);
	const mailboxId = mailboxIdParam
		? decodeURIComponent(mailboxIdParam)
		: selectedMailboxId || undefined;
	const { data: email } = useEmail(mailboxId, emailId) as { data?: Email };
	const { data: threadRepliesRaw } = useThreadReplies(mailboxId, email?.thread_id) as {
		data?: Email[];
	};
	const updateEmail = useUpdateEmail();
	const deleteEmailMut = useDeleteEmail();
	const moveEmailMut = useMoveEmail();
	const reportSpamMut = useReportSpam();
	const sendEmailMut = useSendEmail();
	const replyMut = useReplyToEmail();
	const { data: folders = [] } = useFolders(mailboxId) as { data?: Folder[] };
	const { data: currentMailbox } = useMailbox(mailboxId) as {
		data?: Mailbox;
	};
	const { closePanel, startCompose } = useUIStore();
	const toastManager = useKumoToastManager();
	const [isSending, setIsSending] = useState(false);
	const [sourceViewEmail, setSourceViewEmail] = useState<Email | null>(null);
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
	const [previewImage, setPreviewImage] = useState<{ url: string; filename: string } | null>(null);
	const isDraftFolder = folder === Folders.DRAFT;
	const isSpamFolder = folder === Folders.SPAM || email?.folder_id === Folders.SPAM;

	const threadReplies = useMemo(() => {
		if (!threadRepliesRaw || !email) return [];
		return threadRepliesRaw.filter((e) => e.id !== email.id);
	}, [threadRepliesRaw, email]);

	const allMessages = useMemo(() => {
		if (!email) return [];
		return [email, ...threadReplies].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
	}, [email, threadReplies]);

	// Reset expanded state only when the selected email changes, not on every refetch.
	// Using allMessages as a dependency would reset user expand/collapse state on background refetches.
	const currentEmailId = email?.id;
	useEffect(() => { if (allMessages.length > 1) setExpandedMessages(new Set([allMessages[0].id])); }, [currentEmailId]); // eslint-disable-line react-hooks/exhaustive-deps

	const toggleExpand = (msgId: string) => { setExpandedMessages((prev) => { const next = new Set(prev); if (next.has(msgId)) next.delete(msgId); else next.add(msgId); return next; }); };

	const draftMessageIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of allMessages) { if (msg.folder_id === Folders.DRAFT) ids.add(msg.id); else if (isDraftFolder && msg.id === emailId) ids.add(msg.id); }
		return ids;
	}, [allMessages, isDraftFolder, emailId]);

	const lastReceivedMessage = useMemo(() => {
		const ce = currentMailbox?.email;
		const received = allMessages.filter((msg) => !draftMessageIds.has(msg.id) && msg.sender !== ce);
		if (received.length > 0) return received[0];
		const nonDrafts = allMessages.filter((msg) => !draftMessageIds.has(msg.id));
		return nonDrafts.length > 0 ? nonDrafts[0] : email;
	}, [allMessages, draftMessageIds, currentMailbox?.email, email]);

	const moveToFolders = useMemo(() => { const cur = folder || email?.folder_id; return folders.filter((f) => f.id !== cur); }, [folders, folder, email?.folder_id]);

	if (!email) return <EmailPanelSkeleton />;

	const toggleStar = () => { if (mailboxId) updateEmail.mutate({ mailboxId, id: email.id, data: { starred: !email.starred } }); };
	const handleMove = (folderId: string) => { if (mailboxId) { moveEmailMut.mutate({ mailboxId, id: email.id, folderId }); closePanel(); } };
	const handleDelete = () => { if (mailboxId) { if (!window.confirm("确定要删除这封邮件吗？")) return; deleteEmailMut.mutate({ mailboxId, id: email.id }); closePanel(); } };

	const spamTarget = lastReceivedMessage?.sender && lastReceivedMessage.sender !== currentMailbox?.email
		? lastReceivedMessage
		: email;
	const canReportSpam = !isDraftFolder && email.folder_id !== Folders.SENT && email.folder_id !== Folders.DRAFT;

	const handleReportSpam = () => {
		if (!mailboxId) return;
		const blockLabel = spamTarget.sender ? `拉黑 ${spamTarget.sender}` : "拉黑该发件人";
		if (!window.confirm(`举报为垃圾邮件并${blockLabel}？之后该发件人的邮件会直接进入垃圾邮件。`)) return;
		reportSpamMut.mutate(
			{ mailboxId, id: spamTarget.id },
			{
				onSuccess: (result) => {
					toastManager.add({
						title: result.sender
							? `已拉黑 ${result.sender}，邮件已移到垃圾邮件`
							: "已移到垃圾邮件",
					});
					closePanel();
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

	const handleNotSpam = () => {
		if (!mailboxId) return;
		moveEmailMut.mutate({ mailboxId, id: email.id, folderId: Folders.INBOX });
		toastManager.add({ title: "已移回收件箱。如需继续接收该发件人的邮件，请在黑名单中解除拉黑。" });
		closePanel();
	};

	const handleEditDraft = (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (target.in_reply_to) { startCompose({ mode: "reply", originalEmail: allMessages.find((msg) => msg.id === target.in_reply_to), draftEmail: target }); }
		else { startCompose({ mode: "new", originalEmail: undefined, draftEmail: target }); }
	};

	const handleDeleteDraft = async (draftMsg?: Email) => {
		const target = draftMsg || email;
		if (!mailboxId) return;
		if (!window.confirm("确定要丢弃这封草稿吗？")) return;
		deleteEmailMut.mutate({ mailboxId, id: target.id });
		toastManager.add({ title: "草稿已丢弃" });
		if (target.id === emailId) closePanel();
	};

	const handleSendDraft = async (draftMsg?: Email) => {
		let target = draftMsg || email;
		if (!mailboxId || !currentMailbox) return;
		setIsSending(true);
		try {
			if (!target.recipient || !target.subject) { try { const fresh = await api.getEmail(mailboxId, target.id) as Email; if (fresh) target = fresh; } catch {} }
			if (!target.recipient) { toastManager.add({ title: "无法发送：这封草稿没有填写收件人。", variant: "error" }); return; }
			const toRecipients = splitEmailList(target.recipient);
			if (toRecipients.length === 0) { toastManager.add({ title: "无法发送：这封草稿没有有效的收件人。", variant: "error" }); return; }
			const fromName = currentMailbox.settings?.fromName || currentMailbox.name;
			const from = fromName && fromName !== currentMailbox.email ? { email: currentMailbox.email, name: fromName } : currentMailbox.email;
			const originalEmail = target.in_reply_to ? allMessages.find((msg) => msg.id === target.in_reply_to) : undefined;
			const emailData = {
				to: toEmailListValue(toRecipients),
				cc: toEmailListValue(splitEmailList(target.cc)),
				bcc: toEmailListValue(splitEmailList(target.bcc)),
				from,
				subject: target.subject || "（无主题）",
				html: target.body || "",
				text: target.body ? target.body.replace(/<[^>]*>/g, "").trim() : "",
			};
			if (originalEmail) await replyMut.mutateAsync({ mailboxId, emailId: originalEmail.id, email: emailData }); else await sendEmailMut.mutateAsync({ mailboxId, email: emailData });
			await deleteEmailMut.mutateAsync({ mailboxId, id: target.id });
			toastManager.add({ title: "邮件已发送" });
			if (isDraftFolder) closePanel();
		} catch (err) {
			const message = (err instanceof Error ? err.message : null) || "邮件发送失败";
			toastManager.add({ title: message, variant: "error" });
		} finally { setIsSending(false); }
	};

	const hasThread = allMessages.length > 1;

	return (
		<div className="flex flex-col h-full">
			<EmailPanelToolbar
				email={email}
				mailboxId={mailboxId}
				isDraftFolder={isDraftFolder}
				isSending={isSending}
				moveToFolders={moveToFolders}
				onBack={closePanel}
				onSendDraft={() => handleSendDraft()}
				onEditDraft={() => handleEditDraft()}
				onReply={() =>
					startCompose({ mode: "reply", originalEmail: lastReceivedMessage })
				}
				onReplyAll={() =>
					startCompose({
						mode: "reply-all",
						originalEmail: lastReceivedMessage,
					})
				}
				onForward={() => startCompose({ mode: "forward", originalEmail: email })}
				onToggleStar={toggleStar}
				onToggleRead={() => {
					if (mailboxId) {
						updateEmail.mutate({
							mailboxId,
							id: email.id,
							data: { read: !email.read },
						});
					}
				}}
				onMove={handleMove}
				onViewSource={() => setSourceViewEmail(email)}
				onDelete={handleDelete}
				onReportSpam={handleReportSpam}
				onNotSpam={handleNotSpam}
				isSpamFolder={isSpamFolder}
				canReportSpam={canReportSpam}
				isReportingSpam={reportSpamMut.isPending}
			/>

			<EmailPanelHeader
				subject={email.subject}
				messageCount={allMessages.length}
				showThreadCount={hasThread}
			/>

			<div className="flex-1 overflow-y-auto">
				{hasThread ? (
					allMessages.map((msg, idx) => {
						const isDraft = draftMessageIds.has(msg.id);
						return (
							<ThreadMessage
								key={msg.id}
								email={msg}
								mailboxId={mailboxId}
								mailboxEmail={currentMailbox?.email}
								isLast={idx === allMessages.length - 1}
								isDraft={isDraft}
								isSending={isDraft ? isSending : false}
								isExpanded={expandedMessages.has(msg.id)}
								onToggleExpand={() => toggleExpand(msg.id)}
								onSendDraft={isDraft ? () => handleSendDraft(msg) : undefined}
								onEditDraft={isDraft ? () => handleEditDraft(msg) : undefined}
								onDeleteDraft={isDraft ? () => handleDeleteDraft(msg) : undefined}
								onViewSource={() => setSourceViewEmail(msg)}
								onPreviewImage={(url, filename) =>
									setPreviewImage({ url, filename })
								}
							/>
						);
					})
				) : (
					<SingleMessageView
						email={email}
						mailboxId={mailboxId}
						onPreviewImage={(url, filename) =>
							setPreviewImage({ url, filename })
						}
					/>
				)}
			</div>

			<EmailPanelDialogs
				sourceViewEmail={sourceViewEmail}
				previewImage={previewImage}
				onCloseSource={() => setSourceViewEmail(null)}
				onClosePreview={() => setPreviewImage(null)}
			/>
		</div>
	);
}
