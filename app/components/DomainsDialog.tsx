// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Dialog, useKumoToastManager } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, CheckCircleIcon, TrashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { queryKeys } from "~/queries/keys";
import { useMailboxes } from "~/queries/mailboxes";
import api, { ApiError, type CloudflareSettings, type DomainSetupResult } from "~/services/api";

// Pre-fills the Cloudflare "Create API token" page with the permissions the
// setup needs. Unknown keys are dropped silently by the dashboard, so the
// dialog also lists the permissions in plain text.
const TOKEN_PERMISSIONS = [
	{ key: "zone", type: "read" },
	{ key: "zone_settings", type: "edit" },
	{ key: "dns", type: "edit" },
	{ key: "email_routing_rules", type: "edit" },
];
const TOKEN_TEMPLATE_URL =
	"https://dash.cloudflare.com/profile/api-tokens?" +
	new URLSearchParams({
		permissionGroupKeys: JSON.stringify(TOKEN_PERMISSIONS),
		accountId: "*",
		zoneId: "all",
		name: "free-domain-email",
	}).toString();

interface MxConflict {
	id: string;
	content: string;
	priority?: number;
}

type Steps = DomainSetupResult["steps"];

function StepList({ title, steps }: { title: string; steps: Steps }) {
	return (
		<div className="rounded-md border border-kumo-line p-3 space-y-1.5">
			<p className="text-sm font-medium">{title}</p>
			{steps.map((s) => (
				<div key={s.step} className="flex items-start gap-2 text-xs">
					{s.ok ? (
						<CheckCircleIcon size={14} className="mt-0.5 shrink-0 text-kumo-success" />
					) : (
						<WarningCircleIcon size={14} className="mt-0.5 shrink-0 text-kumo-warning" />
					)}
					<span>
						<span className="font-medium">{s.step}：</span>
						{s.message}
					</span>
				</div>
			))}
		</div>
	);
}

function invalidateDomainQueries(queryClient: ReturnType<typeof useQueryClient>) {
	queryClient.invalidateQueries({ queryKey: queryKeys.config });
	queryClient.invalidateQueries({ queryKey: queryKeys.wildcard });
	queryClient.invalidateQueries({ queryKey: queryKeys.availableDomains });
}

// -- Removal --------------------------------------------------------

function RemoveDomainPanel({
	domain,
	settings,
	onCancel,
	onDone,
}: {
	domain: string;
	settings?: CloudflareSettings;
	onCancel: () => void;
	onDone: (steps: Steps) => void;
}) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const { data: mailboxes = [] } = useMailboxes();
	const count = mailboxes.filter((m) => m.email.toLowerCase().endsWith(`@${domain}`)).length;
	const canCleanCloudflare = settings?.tokenConfigured === true;
	const [cleanCloudflare, setCleanCloudflare] = useState(canCleanCloudflare);
	const [cleanResend, setCleanResend] = useState(false);
	const [confirmText, setConfirmText] = useState("");
	const [progress, setProgress] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const handleRemove = async () => {
		setError(null);
		setProgress("正在移除域名…");
		try {
			// A 404 means an earlier attempt already removed the domain; just finish the cleanup.
			const steps = await api
				.removeDomain(domain, {
					cloudflare: canCleanCloudflare && cleanCloudflare,
					resend: settings?.resendConfigured === true && cleanResend,
				})
				.then((r) => r.steps)
				.catch((err) => {
					if (err instanceof ApiError && err.status === 404) return [];
					throw err;
				});
			invalidateDomainQueries(queryClient);
			if (mailboxId?.toLowerCase().endsWith(`@${domain}`)) navigate("/mail/emails/inbox");

			let cursor: string | null = null;
			let mailboxesDeleted = 0;
			let refsDeleted = 0;
			for (;;) {
				const p = await api.purgeDomain(domain, cursor);
				mailboxesDeleted += p.mailboxesDeleted;
				refsDeleted += p.telegramRefsDeleted;
				setProgress(
					p.mailboxesRemaining > 0
						? `正在删除邮箱… 已删除 ${mailboxesDeleted} 个，剩余 ${p.mailboxesRemaining} 个`
						: "正在清理 Telegram 通知记录…",
				);
				if (p.done) break;
				cursor = p.cursor;
			}
			queryClient.invalidateQueries({ queryKey: queryKeys.mailboxes.all });
			queryClient.invalidateQueries({ queryKey: ["unified-emails"] });
			queryClient.invalidateQueries({ queryKey: queryKeys.unified.folders });
			onDone([
				...steps,
				{
					step: "邮件数据",
					ok: true,
					message: `删除了 ${mailboxesDeleted} 个邮箱（含邮件、附件、AI 助手记录）和 ${refsDeleted} 条 Telegram 通知记录`,
				},
			]);
		} catch (err) {
			setError(
				`${err instanceof Error ? err.message : "移除失败"}。域名已移出列表的话，可以再次点击继续清理。`,
			);
			setProgress(null);
		}
	};

	const busy = progress !== null;

	return (
		<div className="rounded-md border border-kumo-danger bg-kumo-base p-3 space-y-3 text-sm">
			<p className="font-medium">移除 {domain}</p>
			<p className="text-xs">
				会永久删除这个域名下的 <span className="font-semibold">{count}</span>{" "}
				个邮箱及其全部邮件、附件、AI 助手对话和 Telegram 通知记录，无法恢复。
			</p>
			<label className="flex items-start gap-2 text-xs">
				<input
					type="checkbox"
					className="mt-0.5 h-4 w-4 accent-kumo-brand"
					checked={canCleanCloudflare && cleanCloudflare}
					disabled={!canCleanCloudflare || busy}
					onChange={(e) => setCleanCloudflare(e.target.checked)}
				/>
				<span>
					同时清理 Cloudflare 设置：停用转给 Worker 的 Catch-all 和路由规则，关闭 Email Routing 并删除收信 MX/SPF 记录
					{!canCleanCloudflare && "（需要先在下方保存 Cloudflare API Token）"}
				</span>
			</label>
			{settings?.resendConfigured && (
				<label className="flex items-start gap-2 text-xs">
					<input
						type="checkbox"
						className="mt-0.5 h-4 w-4 accent-kumo-brand"
						checked={cleanResend}
						disabled={!canCleanCloudflare || busy}
						onChange={(e) => setCleanResend(e.target.checked)}
					/>
					<span>同时从 Resend 删除这个域名和它的发信 DNS 记录（之后不能再从这个域名发信）</span>
				</label>
			)}
			<div className="space-y-1">
				<p className="text-xs">输入域名确认：</p>
				<input
					aria-label="输入域名确认"
					placeholder={domain}
					value={confirmText}
					disabled={busy}
					onChange={(e) => setConfirmText(e.target.value)}
					className="w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm"
				/>
			</div>
			{progress && <p className="text-xs text-kumo-subtle">{progress}</p>}
			{error && <p className="text-xs text-kumo-danger">{error}</p>}
			<div className="flex gap-2">
				<Button
					size="sm"
					variant="destructive"
					disabled={busy || confirmText.trim().toLowerCase() !== domain}
					onClick={() => void handleRemove()}
				>
					永久移除
				</Button>
				<Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
					取消
				</Button>
			</div>
		</div>
	);
}

// -- Dialog ---------------------------------------------------------

export default function DomainsDialog({
	open,
	onOpenChange,
	domains,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	domains: string[];
}) {
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const [token, setToken] = useState("");
	const [savingToken, setSavingToken] = useState(false);
	const [withResend, setWithResend] = useState(true);
	const [busyZone, setBusyZone] = useState<string | null>(null);
	const [conflict, setConflict] = useState<{ zoneId: string; name: string; records: MxConflict[] } | null>(null);
	const [result, setResult] = useState<{ title: string; steps: Steps } | null>(null);
	const [setupError, setSetupError] = useState<string | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);

	const { data: settings } = useQuery({
		queryKey: queryKeys.cloudflare,
		queryFn: () => api.getCloudflareSettings(),
		enabled: open,
	});
	const zonesQuery = useQuery({
		queryKey: queryKeys.availableDomains,
		queryFn: () => api.listAvailableDomains(),
		enabled: open && settings?.tokenConfigured === true,
		retry: false,
	});

	const handleSaveToken = async () => {
		setSavingToken(true);
		try {
			const saved = await api.saveCloudflareToken(token.trim());
			queryClient.setQueryData(queryKeys.cloudflare, saved);
			queryClient.invalidateQueries({ queryKey: queryKeys.availableDomains });
			setToken("");
		} catch (err) {
			toastManager.add({ title: err instanceof Error ? err.message : "保存失败", variant: "error" });
		} finally {
			setSavingToken(false);
		}
	};

	const handleSetup = async (zoneId: string, name: string, replaceMx = false) => {
		setBusyZone(zoneId);
		setResult(null);
		setSetupError(null);
		setConflict(null);
		try {
			const data = await api.setupDomain({ zoneId, replaceMx, resend: withResend });
			setResult({ title: `${data.domain} 已添加`, steps: data.steps });
			invalidateDomainQueries(queryClient);
		} catch (err) {
			if (err instanceof ApiError && err.status === 409 && Array.isArray(err.body.mxConflicts)) {
				setConflict({ zoneId, name, records: err.body.mxConflicts as MxConflict[] });
			} else {
				setSetupError(err instanceof Error ? err.message : "添加失败");
			}
		} finally {
			setBusyZone(null);
		}
	};

	const zones = (zonesQuery.data?.zones ?? []).filter((z) => !domains.includes(z.name.toLowerCase()));

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					setResult(null);
					setSetupError(null);
					setConflict(null);
					setRemoving(null);
				}
				onOpenChange(next);
			}}
		>
			<Dialog size="lg" className="p-6 max-h-[85vh] overflow-y-auto">
				<Dialog.Title className="text-base font-semibold mb-4">域名管理</Dialog.Title>

				<section className="space-y-2 mb-6">
					<h3 className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">已添加的域名</h3>
					{domains.length === 0 ? (
						<p className="text-sm text-kumo-subtle">还没有域名。</p>
					) : (
						<div className="divide-y divide-kumo-line rounded-md border border-kumo-line">
							{domains.map((d) => (
								<div key={d} className="flex items-center gap-2 px-3 py-2">
									<span className="min-w-0 flex-1 truncate text-sm">{d}</span>
									<Button
										size="sm"
										variant="ghost"
										icon={<TrashIcon size={14} />}
										disabled={removing !== null}
										onClick={() => {
											setResult(null);
											setRemoving(d);
										}}
									>
										移除
									</Button>
								</div>
							))}
						</div>
					)}
					{removing && (
						<RemoveDomainPanel
							key={removing}
							domain={removing}
							settings={settings}
							onCancel={() => setRemoving(null)}
							onDone={(steps) => {
								setResult({ title: `${removing} 已移除`, steps });
								setRemoving(null);
							}}
						/>
					)}
				</section>

				<section className="space-y-3">
					<h3 className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle">从 Cloudflare 添加</h3>
					<p className="text-xs text-kumo-subtle">
						选择 Cloudflare 账户里的域名，会自动开启 Email Routing、把 Catch-all 转给这个 Worker，并加入域名列表。
					</p>

					{settings && !settings.tokenConfigured && (
						<div className="space-y-3">
							<p className="text-sm">
								先在 Cloudflare 创建一个 API Token，让收件箱可以读取你的域名并配置邮件路由。
							</p>
							<a
								href={TOKEN_TEMPLATE_URL}
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 text-sm text-kumo-link hover:underline"
							>
								打开 Cloudflare 创建 Token <ArrowSquareOutIcon size={14} />
							</a>
							<div className="text-xs text-kumo-subtle space-y-1">
								<p>需要的权限（链接已预填，缺少的请手动补上）：</p>
								<ul className="list-disc pl-5">
									<li>Zone → Zone → Read</li>
									<li>Zone → Zone Settings → Edit</li>
									<li>Zone → DNS → Edit</li>
									<li>Zone → Email Routing Rules → Edit</li>
								</ul>
								<p>Zone Resources 选 All zones（或只选要添加的域名）。</p>
							</div>
							<div className="flex gap-2">
								<input
									aria-label="Cloudflare API Token"
									type="password"
									autoComplete="off"
									placeholder="粘贴 API Token"
									value={token}
									onChange={(e) => setToken(e.target.value)}
									className="min-w-0 flex-1 rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm"
								/>
								<Button
									variant="primary"
									disabled={savingToken || !token.trim()}
									onClick={() => void handleSaveToken()}
								>
									{savingToken ? "验证中…" : "保存"}
								</Button>
							</div>
						</div>
					)}

					{settings?.tokenConfigured && (
						<>
							{settings.resendConfigured && (
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										className="h-4 w-4 accent-kumo-brand"
										checked={withResend}
										onChange={(e) => setWithResend(e.target.checked)}
									/>
									同时在 Resend 添加域名并写入发信 DNS 记录（需要 Full access 的 RESEND_API_KEY）
								</label>
							)}

							{zonesQuery.isLoading && <p className="text-sm text-kumo-subtle">正在读取 Cloudflare 域名…</p>}
							{zonesQuery.error && (
								<p className="text-sm text-kumo-danger">{(zonesQuery.error as Error).message}</p>
							)}

							{zones.length > 0 && (
								<div className="divide-y divide-kumo-line rounded-md border border-kumo-line">
									{zones.map((z) => (
										<div key={z.id} className="flex items-center gap-2 px-3 py-2">
											<div className="min-w-0 flex-1">
												<div className="truncate text-sm font-medium">{z.name}</div>
												<div className="truncate text-xs text-kumo-subtle">{z.accountName}</div>
											</div>
											{z.status !== "active" && <Badge variant="secondary">{z.status}</Badge>}
											<Button
												size="sm"
												variant="primary"
												disabled={busyZone !== null || z.status !== "active"}
												onClick={() => void handleSetup(z.id, z.name)}
											>
												{busyZone === z.id ? "配置中…" : "添加"}
											</Button>
										</div>
									))}
								</div>
							)}
							{zonesQuery.isSuccess && zones.length === 0 && (
								<p className="text-sm text-kumo-subtle">
									没有可添加的域名：这个 Token 能看到的域名都已添加，或者 Zone Resources 没有包含其他域名。
								</p>
							)}

							{conflict && (
								<div className="rounded-md border border-kumo-warning bg-kumo-warning-tint p-3 space-y-2 text-sm">
									<p className="font-medium">{conflict.name} 已有其他 MX 记录：</p>
									<ul className="list-disc pl-5 text-xs font-mono">
										{conflict.records.map((r) => (
											<li key={r.id}>
												{r.priority ?? ""} {r.content}
											</li>
										))}
									</ul>
									<p className="text-xs text-kumo-subtle">
										继续会删除这些记录并改用 Cloudflare Email Routing 收信，原来的邮箱服务将收不到这个域名的邮件。
									</p>
									<div className="flex gap-2">
										<Button
											size="sm"
											variant="destructive"
											disabled={busyZone !== null}
											onClick={() => void handleSetup(conflict.zoneId, conflict.name, true)}
										>
											删除旧记录并继续
										</Button>
										<Button size="sm" variant="secondary" onClick={() => setConflict(null)}>
											取消
										</Button>
									</div>
								</div>
							)}

							{setupError && <p className="text-sm text-kumo-danger">{setupError}</p>}

							{settings.tokenSource === "saved" && (
								<button
									type="button"
									className="text-xs text-kumo-subtle hover:underline"
									onClick={async () => {
										const saved = await api.saveCloudflareToken("");
										queryClient.setQueryData(queryKeys.cloudflare, saved);
									}}
								>
									更换 API Token
								</button>
							)}
						</>
					)}
				</section>

				{result && (
					<div className="mt-4">
						<StepList title={result.title} steps={result.steps} />
					</div>
				)}

				<div className="flex justify-end mt-4">
					<Dialog.Close
						render={(props) => (
							<Button {...props} variant="secondary">
								关闭
							</Button>
						)}
					/>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
