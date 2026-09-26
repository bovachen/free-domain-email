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
	{ id: Folders.INBOX, label: "Inbox" },
	{ id: Folders.DRAFT, label: "Drafts" },
	{ id: Folders.SENT, label: "Sent" },
	{ id: Folders.ARCHIVE, label: "Archive" },
	{ id: Folders.SPAM, label: "Spam" },
	{ id: Folders.TRASH, label: "Trash" },
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
		err instanceof Error ? err.message : "Telegram request failed";

	const handleSaveTelegram = async () => {
		setTelegramBusy(true);
		try {
			await updateTelegram.mutateAsync({
				botToken: botToken.trim() || undefined,
				chatId: chatId.trim() || undefined,
				inboxBaseUrl: inboxBaseUrl.trim() || undefined,
			});
			setBotToken("");
			toastManager.add({ title: "Telegram settings saved" });
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
			toastManager.add({ title: `Found chat ${data.chatId}` });
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
			toastManager.add({ title: "Test message sent" });
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
					? "Webhook connected — buttons and replies now work inside Telegram"
					: "Webhook disconnected",
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
			toastManager.add({ title: `Blocked ${address}` });
		} catch (err) {
			toastManager.add({
				title: err instanceof Error ? err.message : "Failed to block address",
				variant: "error",
			});
		}
	};

	const handleRemoveBlacklist = async (address: string) => {
		try {
			await removeFromBlacklist.mutateAsync(address);
			toastManager.add({ title: `Unblocked ${address}` });
		} catch (err) {
			toastManager.add({
				title: err instanceof Error ? err.message : "Failed to unblock address",
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
			const domain = box.email.split("@")[1] || "other";
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
				<div className="text-base font-semibold text-kumo-default">Mail</div>
				<div className="text-xs text-kumo-subtle mt-0.5">
					{mailboxes.length} account{mailboxes.length === 1 ? "" : "s"}
				</div>
			</div>

			<div className="px-3 py-3">
				<Button
					variant="primary"
					icon={<PencilSimpleIcon size={16} />}
					onClick={handleCompose}
					className="w-full"
				>
					Compose
				</Button>
			</div>

			<nav className="flex-1 overflow-y-auto px-2 space-y-0.5">
				<div className="px-3 pt-1 pb-1 text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
					Favorites
				</div>
				{SYSTEM_FOLDER_LINKS.map((item) => (
					<FolderLink
						key={`all-${item.id}`}
						to={`/mail/emails/${item.id}`}
						icon={FOLDER_ICONS[item.id]}
						label={item.id === Folders.INBOX ? "All Inboxes" : item.label}
						unreadCount={unifiedUnread[item.id]}
						onClick={handleNavClick}
					/>
				))}

				<div className="flex items-center justify-between px-3 pt-5 pb-1">
					<span className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">
						Accounts
					</span>
					<Tooltip content="Add mailbox" asChild>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={<PlusIcon size={16} />}
							onClick={() => {
								setSelectedDomain(domains[0] || "");
								setIsCreateMailboxOpen(true);
							}}
							aria-label="Add mailbox"
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
												to={`/mail/mailbox/${encodeURIComponent(box.id)}/emails/${cf.id}`}
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
											<span>New folder</span>
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
					<span className="flex-1 text-left">Catch-all addresses</span>
					{wildcardOpen ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
				</button>
				{wildcardOpen && (
					<div className="px-3 pb-2 space-y-2">
						<p className="text-xs text-kumo-subtle">
							When on, any prefix at that domain is accepted and a mailbox is created automatically.
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
									aria-label={`Catch-all for ${domain}`}
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
					<span className="flex-1 text-left">Telegram alerts</span>
					{telegramReady && <span className="text-xs text-kumo-subtle">On</span>}
					{telegramOpen ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
				</button>
				{telegramOpen && (
					<div className="px-3 pb-2 space-y-2">
						<p className="text-xs text-kumo-subtle">
							Incoming mail is previewed in Telegram. Buttons mark read, star, delete, flag spam or block the sender in place, and replying to the message sends an email reply — no browser needed.
						</p>
						<label className="flex items-center justify-between gap-2 text-sm">
							<span>Enable</span>
							<input
								type="checkbox"
								className="h-4 w-4 accent-kumo-brand"
								checked={telegram?.enabled === true}
								onChange={(e) => updateTelegram.mutate({ enabled: e.target.checked })}
								aria-label="Enable Telegram notifications"
							/>
						</label>
						<input
							aria-label="Bot token"
							type="password"
							autoComplete="off"
							placeholder={
								telegram?.botTokenConfigured
									? "Token saved — paste to replace"
									: "Bot token from @BotFather"
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
							aria-label="Inbox URL"
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
								Save
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={telegramBusy}
								onClick={() => void handleDiscoverTelegram()}
							>
								Detect chat
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={telegramBusy}
								onClick={() => void handleTestTelegram()}
							>
								Test
							</Button>
							<Button
								size="sm"
								variant={telegram?.webhookConfigured ? "secondary" : "primary"}
								disabled={telegramBusy || !telegram?.botTokenConfigured}
								onClick={() => void handleToggleWebhook()}
							>
								{telegram?.webhookConfigured ? "Disconnect webhook" : "Connect webhook"}
							</Button>
						</div>
						{telegram?.webhookConfigured && (
							<p className="text-xs text-kumo-subtle font-mono break-all">
								Webhook: {telegram.webhookUrl}
							</p>
						)}
						{telegram?.mode === "polling" && (
							<p className="text-xs text-kumo-subtle">
								Mode: polling (cron, every minute). Buttons and replies work without any Access changes; a tap usually lands within a few seconds.
								{telegram.lastPollAt && ` Last poll: ${new Date(telegram.lastPollAt).toLocaleTimeString()}.`}
								{telegram.lastPollError && ` Last error: ${telegram.lastPollError}`}
							</p>
						)}
						<p className="text-xs text-kumo-subtle">
							Message @BotFather to create a bot, paste the token, then open the bot and send /start — the chat binds automatically. Alert buttons act directly in Telegram via polling by default. Connect webhook only if you want instant delivery; the Cloudflare Access app must then bypass {telegram?.webhookUrl ? new URL(telegram.webhookUrl).pathname : "/api/telegram/webhook"}.
						</p>
					</div>
				)}
				<button
					type="button"
					onClick={() => setBlacklistOpen((v) => !v)}
					className="flex items-center gap-2 w-full px-3 py-2 text-sm text-kumo-strong hover:bg-kumo-tint rounded-md"
				>
					<ProhibitIcon size={16} />
					<span className="flex-1 text-left">Blacklist</span>
					{(blacklist?.entries.length ?? 0) > 0 && (
						<span className="text-xs text-kumo-subtle">{blacklist?.entries.length}</span>
					)}
					{blacklistOpen ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
				</button>
				{blacklistOpen && (
					<div className="px-3 pb-2 space-y-2">
						<p className="text-xs text-kumo-subtle">
							Blocked senders skip the inbox and Telegram alerts. Reporting spam also adds the sender here.
						</p>
						<div className="flex gap-1">
							<input
								aria-label="Address to block"
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
								Block
							</Button>
						</div>
						<div className="max-h-40 overflow-y-auto space-y-1">
							{(blacklist?.entries ?? []).length === 0 ? (
								<p className="text-xs text-kumo-subtle">No blocked senders.</p>
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
											aria-label={`Unblock ${entry.address}`}
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
						Account settings
					</NavLink>
				)}
			</div>

			<Dialog.Root open={isCreateMailboxOpen} onOpenChange={setIsCreateMailboxOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Add mailbox
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
								aria-label="Prefix"
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
										Cancel
									</Button>
								)}
							/>
							<Button type="submit" variant="primary">
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			<Dialog.Root open={isCreateFolderOpen} onOpenChange={setIsCreateFolderOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Create folder
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
							label="Folder name"
							placeholder="e.g. Projects"
							value={newFolderName}
							onChange={(e) => setNewFolderName(e.target.value)}
							required
						/>
						<div className="flex justify-end gap-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary">
										Cancel
									</Button>
								)}
							/>
							<Button type="submit" variant="primary" disabled={!newFolderName.trim()}>
								Create
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</aside>
	);
}
