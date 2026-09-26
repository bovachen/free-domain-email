// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Dialog, Input, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	CaretDownIcon,
	CaretRightIcon,
	FileIcon,
	FolderIcon,
	GearSixIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	PlusIcon,
	ProhibitIcon,
	TelegramLogoIcon,
	TrashIcon,
	TrayIcon,
	WarningIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { Folders, SYSTEM_FOLDER_IDS } from "shared/folders";
import { useUIStore } from "~/hooks/useUIStore";
import { useCreateFolder, useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import {
	useAddToBlacklist,
	useBlacklist,
	useCreateMailbox,
	useMailboxes,
	useRemoveFromBlacklist,
	useTelegramSettings,
	useUnifiedFolders,
	useUpdateTelegramSettings,
	useUpdateWildcardSettings,
	useWildcardSettings,
} from "~/queries/mailboxes";
import api from "~/services/api";

const FOLDER_ICONS: Record<string, React.ReactNode> = {
	[Folders.INBOX]: <TrayIcon size={18} weight="regular" />,
	[Folders.SENT]: <PaperPlaneTiltIcon size={18} weight="regular" />,
	[Folders.DRAFT]: <FileIcon size={18} weight="regular" />,
	[Folders.ARCHIVE]: <ArchiveIcon size={18} weight="regular" />,
	[Folders.TRASH]: <TrashIcon size={18} weight="regular" />,
	[Folders.SPAM]: <WarningIcon size={18} weight="regular" />,
};

const SYSTEM_FOLDER_LINKS = [
	{ id: Folders.INBOX, label: "收件箱" },
	{ id: Folders.DRAFT, label: "草稿" },
	{ id: Folders.SENT, label: "已发送" },
	{ id: Folders.ARCHIVE, label: "归档" },
	{ id: Folders.SPAM, label: "垃圾邮件" },
	{ id: Folders.TRASH, label: "废纸篓" },
];

function FolderLink({
	to,
	icon,
	label,
	unreadCount,
	onClick,
	indent = false,
}: {
	to: string;
	icon: React.ReactNode;
	label: string;
	unreadCount?: number;
	onClick?: () => void;
	indent?: boolean;
}) {
	return (
		<NavLink
			to={to}
			onClick={onClick}
			className={({ isActive }) =>
				`flex items-center gap-3 py-1.5 rounded-md text-sm transition-colors ${
					indent ? "pl-8 pr-3" : "px-3"
				} ${
					isActive
						? "bg-kumo-fill font-semibold text-kumo-default"
						: "text-kumo-strong hover:bg-kumo-tint"
				}`
			}
		>
			<span className="shrink-0">{icon}</span>
			<span className="truncate flex-1">{label}</span>
			{unreadCount != null && unreadCount > 0 && (
				<Badge variant="secondary">{unreadCount}</Badge>
			)}
		</NavLink>
	);
}

export default function Sidebar() {
	const { mailboxId } = useParams<{ mailboxId: string; folder: string }>();
	const navigate = useNavigate();
	const { startCompose, closeSidebar, setComposeMailboxId } = useUIStore();
	const { data: mailboxes = [] } = useMailboxes();
	const { data: unifiedFolders } = useUnifiedFolders();
	const { data: accountFolders = [] } = useFolders(mailboxId);
	const { data: wildcard = {} } = useWildcardSettings();
	const updateWildcard = useUpdateWildcardSettings();
	const createMailbox = useCreateMailbox();
	const createFolderMutation = useCreateFolder();
	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity,
	});
	const domains = configData?.domains ?? [];

	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const [isCreateMailboxOpen, setIsCreateMailboxOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedDomain, setSelectedDomain] = useState(domains[0] || "");
	const [wildcardOpen, setWildcardOpen] = useState(false);
	const [telegramOpen, setTelegramOpen] = useState(false);
	const [botToken, setBotToken] = useState("");
	const [chatId, setChatId] = useState("");
	const [telegramBusy, setTelegramBusy] = useState(false);
	const [blacklistOpen, setBlacklistOpen] = useState(false);
	const [blacklistAddress, setBlacklistAddress] = useState("");
	const { data: telegram } = useTelegramSettings();
	const { data: blacklist } = useBlacklist();
	const addToBlacklist = useAddToBlacklist();
	const removeFromBlacklist = useRemoveFromBlacklist();
	const updateTelegram = useUpdateTelegramSettings();
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const [inboxBaseUrl, setInboxBaseUrl] = useState("");

	useEffect(() => {
		if (!telegram) return;
		setChatId(telegram.chatId || "");
		setInboxBaseUrl(telegram.inboxBaseUrl || "");
	}, [telegram]);

	const telegramError = (err: unknown) =>
		err instanceof Error ? err.message : "Telegram 请求失败";

	const handleSaveTelegram = async () => {
		setTelegramBusy(true);
		try {
			await updateTelegram.mutateAsync({
				botToken: botToken.trim() || undefined,
				chatId: chatId.trim() || undefined,
				inboxBaseUrl: inboxBaseUrl.trim() || undefined,
			});
			setBotToken("");
			toastManager.add({ title: "Telegram 设置已保存" });
		} catch (err) {
			toastManager.add({ title: telegramError(err), variant: "error" });
		} finally {
			setTelegramBusy(false);
		}
	};

	const handleDiscoverTelegram = async () => {
		setTelegramBusy(true);
		try {
			if (botToken.trim()) {
				await updateTelegram.mutateAsync({ botToken: botToken.trim() });
				setBotToken("");
			}
			const data = await api.discoverTelegramChat();
			queryClient.setQueryData(queryKeys.telegram, data);
			setChatId(data.chatId);
			toastManager.add({ title: `已找到对话 ${data.chatId}` });
		} catch (err) {
			toastManager.add({ title: telegramError(err), variant: "error" });
		} finally {
			setTelegramBusy(false);
		}
	};

	const handleTestTelegram = async () => {
		setTelegramBusy(true);
		try {
			if (botToken.trim() || chatId.trim()) {
				await updateTelegram.mutateAsync({
					botToken: botToken.trim() || undefined,
					chatId: chatId.trim() || undefined,
				});
				setBotToken("");
			}
			await api.testTelegram();
			toastManager.add({ title: "测试消息已发送" });
		} catch (err) {
			toastManager.add({ title: telegramError(err), variant: "error" });
		} finally {
			setTelegramBusy(false);
		}
	};

	const handleToggleWebhook = async () => {
		setTelegramBusy(true);
		try {
			if (botToken.trim() || inboxBaseUrl.trim()) {
				await updateTelegram.mutateAsync({
					botToken: botToken.trim() || undefined,
					inboxBaseUrl: inboxBaseUrl.trim() || undefined,
				});
				setBotToken("");
			}
			const data = telegram?.webhookConfigured
				? await api.unregisterTelegramWebhook()
				: await api.registerTelegramWebhook();
			queryClient.setQueryData(queryKeys.telegram, data);
			toastManager.add({
				title: data.webhookConfigured
					? "Webhook 已连接，现在可直接在 Telegram 中使用按钮和回复"
					: "Webhook 已断开",
			});
		} catch (err) {
			toastManager.add({ title: telegramError(err), variant: "error" });
		} finally {
			setTelegramBusy(false);
		}
	};

	const telegramReady = Boolean(
		telegram?.enabled && telegram.botTokenConfigured && telegram.chatId,
	);

	const handleAddBlacklist = async () => {
		const address = blacklistAddress.trim();
		if (!address) return;
		try {
			await addToBlacklist.mutateAsync(address);
			setBlacklistAddress("");
			toastManager.add({ title: `已拉黑 ${address}` });
		} catch (err) {
			toastManager.add({
				title: err instanceof Error ? err.message : "拉黑失败",
				variant: "error",
			});
		}
	};

	const handleRemoveBlacklist = async (address: string) => {
		try {
			await removeFromBlacklist.mutateAsync(address);
			toastManager.add({ title: `已解除拉黑 ${address}` });
		} catch (err) {
			toastManager.add({
				title: err instanceof Error ? err.message : "解除拉黑失败",
				variant: "error",
			});
		}
	};

	const unifiedUnread = unifiedFolders?.unread ?? {};

	const handleNavClick = () => closeSidebar();

	const handleCompose = () => {
		setComposeMailboxId(mailboxId || mailboxes[0]?.id || null);
		startCompose();
	};

	const grouped = useMemo(() => {
		const byDomain: Record<string, typeof mailboxes> = {};
		for (const box of mailboxes) {
			const domain = box.email.split("@")[1] || "其他";
			if (!byDomain[domain]) byDomain[domain] = [];
			byDomain[domain].push(box);
		}
		return Object.entries(byDomain).sort(([a], [b]) => a.localeCompare(b));
	}, [mailboxes]);

	const customFolders = useMemo(
		() =>
			accountFolders.filter(
				(f) => !(SYSTEM_FOLDER_IDS as readonly string[]).includes(f.id),
			),
		[accountFolders],
	);

	return (
		<aside className="h-full w-64 bg-kumo-recessed flex flex-col shrink-0 border-r border-kumo-line">
			<div className="px-4 pt-4 pb-1">
				<div className="text-base font-semibold text-kumo-default">邮件</div>
				<div className="text-xs text-kumo-subtle mt-0.5">
					{mailboxes.length} 个账户
				</div>
			</div>

			<div className="px-3 py-3">
				<Button
					variant="primary"
					icon={<PencilSimpleIcon size={16} />}
					onClick={handleCompose}
					className="w-full"
				>
					写邮件
				</Button>
			</div>

			<nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
				<div className="px-3 pt-1 pb-1 text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
					个人收藏
				</div>
				{SYSTEM_FOLDER_LINKS.map((item) => (
					<FolderLink
						key={`all-${item.id}`}
						to={`/mail/emails/${item.id}`}
						icon={FOLDER_ICONS[item.id]}
						label={item.id === Folders.INBOX ? "所有收件箱" : item.label}
						unreadCount={unifiedUnread[item.id]}
						onClick={handleNavClick}
					/>
				))}

				<div className="flex items-center justify-between px-3 pt-5 pb-1">
					<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
						账户
					</span>
					<Tooltip content="添加邮箱" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<PlusIcon size={16} />}
							onClick={() => {
								setSelectedDomain(domains[0] || "");
								setIsCreateMailboxOpen(true);
							}}
							aria-label="添加邮箱"
						/>
					</Tooltip>
				</div>

				{grouped.map(([domain, boxes]) => (
					<div key={domain} className="mb-1">
						<div className="flex items-center gap-1 px-3 py-1 text-xs font-medium text-kumo-subtle">
							<span className="truncate flex-1">{domain}</span>
						</div>
						{boxes.map((box) => {
							const open = expanded[box.id] ?? mailboxId === box.id;
							return (
								<div key={box.id}>
									<button
										type="button"
										className="flex items-center gap-1 w-full px-3 py-1.5 text-sm text-kumo-strong hover:bg-kumo-tint rounded-md"
										onClick={() => {
											setExpanded((prev) => ({ ...prev, [box.id]: !open }));
											navigate(`/mail/mailbox/${encodeURIComponent(box.id)}/emails/inbox`);
											handleNavClick();
										}}
									>
										{open ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
										<span className="truncate flex-1 text-left">
											{box.settings?.fromName || box.email.split("@")[0]}
										</span>
									</button>
									{open &&
										SYSTEM_FOLDER_LINKS.map((item) => (
											<FolderLink
												key={`${box.id}-${item.id}`}
												to={`/mail/mailbox/${encodeURIComponent(box.id)}/emails/${item.id}`}
												icon={FOLDER_ICONS[item.id]}
												label={item.label}
												indent
												onClick={handleNavClick}
											/>
										))}
									{open && mailboxId === box.id && customFolders.length > 0 &&
										customFolders.map((cf) => (
											<FolderLink
												key={cf.id}
												to={`/mail/mailbox/${encodeURIComponent(box.id)}/emails/${encodeURIComponent(cf.id)}`}
												icon={<FolderIcon size={16} />}
												label={cf.name}
												unreadCount={cf.unreadCount}
												indent
												onClick={handleNavClick}
											/>
										))}
									{open && mailboxId === box.id && (
										<button
											type="button"
											onClick={() => setIsCreateFolderOpen(true)}
											className="flex items-center gap-3 w-full py-1.5 pl-8 pr-3 rounded-md text-sm text-kumo-subtle hover:bg-kumo-tint"
										>
											<PlusIcon size={16} />
											<span>新建文件夹</span>
										</button>
									)}
								</div>
							);
						})}
					</div>
				))}
			</nav>

			<div className="border-t border-kumo-line p-2 space-y-1">
				<button
					type="button"
					onClick={() => setWildcardOpen((v) => !v)}
					className="flex items-center gap-2 w-full px-3 py-2 text-sm text-kumo-strong hover:bg-kumo-tint rounded-md"
				>
					<GearSixIcon size={16} />
					<span className="flex-1 text-left">通配地址</span>
					{wildcardOpen ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
				</button>
				{wildcardOpen && (
					<div className="px-3 pb-2 space-y-2">
						<p className="text-xs text-kumo-subtle">
							开启后，发往该域名任意前缀的邮件都会被接收，并自动创建对应邮箱。
						</p>
						{domains.map((domain) => (
							<label key={domain} className="flex items-center justify-between gap-2 text-sm">
								<span className="truncate">*@{domain}</span>
								<input
									type="checkbox"
									className="h-4 w-4 accent-kumo-brand"
									checked={wildcard[domain] !== false}
									onChange={(e) =>
										updateWildcard.mutate({ [domain]: e.target.checked })
									}
									aria-label={`${domain} 的通配地址`}
								/>
							</label>
						))}
					</div>
				)}
				<button
					type="button"
					onClick={() => setTelegramOpen((v) => !v)}
					className="flex items-center gap-2 w-full px-3 py-2 text-sm text-kumo-strong hover:bg-kumo-tint rounded-md"
				>
					<TelegramLogoIcon size={16} />
					<span className="flex-1 text-left">Telegram 通知</span>
					{telegramReady && <span className="text-xs text-kumo-subtle">已开启</span>}
					{telegramOpen ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
				</button>
				{telegramOpen && (
					<div className="px-3 pb-2 space-y-2">
						<p className="text-xs text-kumo-subtle">
							新邮件会在 Telegram 中预览。可通过按钮直接标为已读、加星标、删除、举报垃圾邮件或拉黑发件人，回复该消息即可回复邮件，无需打开浏览器。
						</p>
						<label className="flex items-center justify-between gap-2 text-sm">
							<span>启用</span>
							<input
								type="checkbox"
								className="h-4 w-4 accent-kumo-brand"
								checked={telegram?.enabled === true}
								onChange={(e) => updateTelegram.mutate({ enabled: e.target.checked })}
								aria-label="启用 Telegram 通知"
							/>
						</label>
						<input
							aria-label="Bot Token"
							type="password"
							autoComplete="off"
							placeholder={
								telegram?.botTokenConfigured
									? "Token 已保存，粘贴可替换"
									: "从 @BotFather 获取的 Token"
							}
							value={botToken}
							onChange={(e) => setBotToken(e.target.value)}
							className="w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm"
						/>
						<input
							aria-label="Chat ID"
							placeholder="Chat ID"
							value={chatId}
							onChange={(e) => setChatId(e.target.value)}
							className="w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm"
						/>
						<input
							aria-label="收件箱 URL"
							placeholder="https://inbox.example.com"
							value={inboxBaseUrl}
							onChange={(e) => setInboxBaseUrl(e.target.value)}
							className="w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm"
						/>
						<div className="flex flex-wrap gap-1">
							<Button
								size="sm"
								variant="secondary"
								disabled={telegramBusy}
								onClick={() => void handleSaveTelegram()}
							>
								保存
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={telegramBusy}
								onClick={() => void handleDiscoverTelegram()}
							>
								检测对话
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={telegramBusy}
								onClick={() => void handleTestTelegram()}
							>
								测试
							</Button>
							<Button
								size="sm"
								variant={telegram?.webhookConfigured ? "secondary" : "primary"}
								disabled={telegramBusy || !telegram?.botTokenConfigured}
								onClick={() => void handleToggleWebhook()}
							>
								{telegram?.webhookConfigured ? "断开 Webhook" : "连接 Webhook"}
							</Button>
						</div>
						{telegram?.webhookConfigured && (
							<p className="text-xs text-kumo-subtle font-mono break-all">
								Webhook：{telegram.webhookUrl}
							</p>
						)}
						{telegram?.mode === "polling" && (
							<p className="text-xs text-kumo-subtle">
								模式：轮询（cron，每分钟一次）。按钮和回复无需修改任何 Access 设置即可使用，点击后通常几秒内生效。
								{telegram.lastPollAt && `上次轮询：${new Date(telegram.lastPollAt).toLocaleTimeString("zh-CN")}。`}
								{telegram.lastPollError && `最近错误：${telegram.lastPollError}`}
							</p>
						)}
						<p className="text-xs text-kumo-subtle">
							通过 @BotFather 创建机器人并粘贴其 Token，然后打开该机器人发送 /start，对话即会自动绑定。通知中的按钮默认通过轮询直接在 Telegram 中生效。仅在需要即时送达时才连接 Webhook，届时须在 Cloudflare Access 应用中为 {telegram?.webhookUrl ? new URL(telegram.webhookUrl).pathname : "/api/telegram/webhook"} 配置绕过（Bypass）策略。
						</p>
					</div>
				)}
				<button
					type="button"
					onClick={() => setBlacklistOpen((v) => !v)}
					className="flex items-center gap-2 w-full px-3 py-2 text-sm text-kumo-strong hover:bg-kumo-tint rounded-md"
				>
					<ProhibitIcon size={16} />
					<span className="flex-1 text-left">黑名单</span>
					{(blacklist?.entries.length ?? 0) > 0 && (
						<span className="text-xs text-kumo-subtle">{blacklist?.entries.length}</span>
					)}
					{blacklistOpen ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
				</button>
				{blacklistOpen && (
					<div className="px-3 pb-2 space-y-2">
						<p className="text-xs text-kumo-subtle">
							已拉黑的发件人不会进入收件箱，也不会触发 Telegram 通知。举报垃圾邮件时也会将发件人加入黑名单。
						</p>
						<div className="flex gap-1">
							<input
								aria-label="要拉黑的地址"
								placeholder="spam@example.com"
								value={blacklistAddress}
								onChange={(e) => setBlacklistAddress(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										void handleAddBlacklist();
									}
								}}
								className="min-w-0 flex-1 rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm"
							/>
							<Button
								size="sm"
								variant="secondary"
								disabled={addToBlacklist.isPending || !blacklistAddress.trim()}
								onClick={() => void handleAddBlacklist()}
							>
								拉黑
							</Button>
						</div>
						<div className="max-h-40 overflow-y-auto space-y-1">
							{(blacklist?.entries ?? []).length === 0 ? (
								<p className="text-xs text-kumo-subtle">暂无已拉黑的发件人。</p>
							) : (
								blacklist?.entries.map((entry) => (
									<div
										key={entry.address}
										className="flex items-center gap-1 rounded-md bg-kumo-tint px-2 py-1"
									>
										<span className="min-w-0 flex-1 truncate text-xs text-kumo-default" title={entry.address}>
											{entry.address}
										</span>
										<button
											type="button"
											className="shrink-0 text-kumo-subtle hover:text-kumo-destructive"
											aria-label={`解除拉黑 ${entry.address}`}
											onClick={() => void handleRemoveBlacklist(entry.address)}
										>
											<XIcon size={12} />
										</button>
									</div>
								))
							)}
						</div>
					</div>
				)}
				{mailboxId && (
					<NavLink
						to={`/mail/mailbox/${encodeURIComponent(mailboxId)}/settings`}
						onClick={handleNavClick}
						className="flex items-center gap-2 px-3 py-2 text-sm text-kumo-strong hover:bg-kumo-tint rounded-md"
					>
						账户设置
					</NavLink>
				)}
			</div>

			<Dialog.Root open={isCreateMailboxOpen} onOpenChange={setIsCreateMailboxOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						添加邮箱
					</Dialog.Title>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							if (!newPrefix || !selectedDomain) return;
							const email = `${newPrefix}@${selectedDomain}`.toLowerCase();
							createMailbox.mutate(
								{ email, name: newPrefix },
								{
									onSuccess: () => {
										setIsCreateMailboxOpen(false);
										setNewPrefix("");
										navigate(`/mail/mailbox/${encodeURIComponent(email)}/emails/inbox`);
									},
								},
							);
						}}
						className="space-y-4"
					>
						<div className="flex items-center gap-2">
							<Input
								aria-label="前缀"
								placeholder="hello"
								value={newPrefix}
								onChange={(e) => setNewPrefix(e.target.value)}
								required
							/>
							<span className="text-sm text-kumo-subtle">@</span>
							<select
								className="flex-1 rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm"
								value={selectedDomain}
								onChange={(e) => setSelectedDomain(e.target.value)}
							>
								{domains.map((d) => (
									<option key={d} value={d}>
										{d}
									</option>
								))}
							</select>
						</div>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										取消
									</Button>
								)}
							/>
							<Button type="submit" variant="primary">
								创建
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			<Dialog.Root open={isCreateFolderOpen} onOpenChange={setIsCreateFolderOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						新建文件夹
					</Dialog.Title>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							if (newFolderName.trim() && mailboxId) {
								createFolderMutation.mutate({ mailboxId, name: newFolderName.trim() });
								setNewFolderName("");
								setIsCreateFolderOpen(false);
							}
						}}
						className="space-y-4"
					>
						<Input
							label="文件夹名称"
							placeholder="例如：项目"
							value={newFolderName}
							onChange={(e) => setNewFolderName(e.target.value)}
							required
						/>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										取消
									</Button>
								)}
							/>
							<Button type="submit" variant="primary" disabled={!newFolderName.trim()}>
								创建
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</aside>
	);
}
