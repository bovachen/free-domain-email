// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// 发件人名单: the blacklist and the burn-after-reading keep list on one
// page, with search, filters, batch add (paste a column of addresses) and
// batch removal, for when the lists outgrow the sidebar panels.

import { Button, useKumoToastManager } from "@cloudflare/kumo";
import { MagnifyingGlassIcon, ProhibitIcon, PushPinIcon, XIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { formatListDate } from "shared/dates";
import {
	useAddKeepEntries,
	useAddToBlacklist,
	useBlacklist,
	useBurnSettings,
	useRemoveFromBlacklist,
	useRemoveKeepEntries,
} from "~/queries/mailboxes";
import type { ListInputError } from "~/services/api";

type Tab = "block" | "keep";

interface Row {
	address: string;
	type: "address" | "domain";
	createdAt: string;
	source: string;
}

const BLOCK_SOURCES: Record<string, string> = { spam: "举报垃圾邮件", telegram: "Telegram /block" };
const KEEP_SOURCES: Record<string, string> = { reader: "阅读时保留", telegram: "Telegram 查看全文" };

const TAB_INFO: Record<Tab, { title: string; description: string; placeholder: string; addLabel: string }> = {
	block: {
		title: "黑名单",
		description:
			"名单里的发件人的邮件直接进垃圾邮件，不发 Telegram 通知。填完整地址只拉黑该地址，填域名（如 example.com）拉黑整个域名和它的子域名；gmail.com 等公共邮箱和你自己的域名不能整域拉黑。",
		placeholder: "每行一个地址或域名，也可以用逗号或空格分隔，例如：\nspam@example.com\nbad-domain.com",
		addLabel: "拉黑",
	},
	keep: {
		title: "永久保留",
		description:
			"名单里的发件人的邮件从不阅后即焚。填完整地址只保留该地址，填域名（如 company.com）保留整个域名和它的子域名。加入名单时，这些发件人正在倒计时的邮件也会停下来。",
		placeholder: "每行一个地址或域名，也可以用逗号或空格分隔，例如：\nboss@company.com\ncompany.com",
		addLabel: "保留",
	},
};

/** Pasted text to entries: one per line, or separated by commas, semicolons or spaces. */
function splitInputs(text: string): string[] {
	return text
		.split(/[\s,;，；、]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

const rowKey = (row: Row) => `${row.type}:${row.address}`;

export default function SenderListsRoute() {
	const [params, setParams] = useSearchParams();
	const tab: Tab = params.get("tab") === "keep" ? "keep" : "block";
	const info = TAB_INFO[tab];
	const toastManager = useKumoToastManager();

	const { data: blacklist } = useBlacklist();
	const { data: burn } = useBurnSettings();
	const addBlock = useAddToBlacklist();
	const removeBlock = useRemoveFromBlacklist();
	const addKeep = useAddKeepEntries();
	const removeKeep = useRemoveKeepEntries();

	const [draft, setDraft] = useState("");
	const [errors, setErrors] = useState<ListInputError[]>([]);
	const [query, setQuery] = useState("");
	const [typeFilter, setTypeFilter] = useState<"all" | "address" | "domain">("all");
	const [sort, setSort] = useState<"recent" | "name">("recent");
	const [selected, setSelected] = useState<Set<string>>(new Set());

	const blockRows = useMemo<Row[]>(
		() =>
			(blacklist?.entries ?? []).map((entry) => ({
				address: entry.address,
				type: entry.type ?? "address",
				createdAt: entry.createdAt,
				source: entry.reason
					? `${BLOCK_SOURCES[entry.reason] ?? entry.reason}${entry.mailboxId ? ` · ${entry.mailboxId}` : ""}`
					: "手动添加",
			})),
		[blacklist],
	);
	const keepRows = useMemo<Row[]>(
		() =>
			(burn?.keep ?? []).map((entry) => ({
				address: entry.address,
				type: entry.type,
				createdAt: entry.createdAt,
				source: entry.source ? KEEP_SOURCES[entry.source] : "手动添加",
			})),
		[burn],
	);
	const rows = tab === "block" ? blockRows : keepRows;
	const loaded = tab === "block" ? Boolean(blacklist) : Boolean(burn);

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matches = rows.filter(
			(row) => (typeFilter === "all" || row.type === typeFilter) && (!q || row.address.includes(q)),
		);
		// Stored newest first, so "recent" is the stored order.
		return sort === "name" ? [...matches].sort((a, b) => a.address.localeCompare(b.address)) : matches;
	}, [rows, query, typeFilter, sort]);

	const selectedVisible = visible.filter((row) => selected.has(rowKey(row)));
	const allVisibleSelected = visible.length > 0 && selectedVisible.length === visible.length;
	const adding = addBlock.isPending || addKeep.isPending;
	const removing = removeBlock.isPending || removeKeep.isPending;

	const switchTab = (next: Tab) => {
		setParams({ tab: next }, { replace: true });
		setSelected(new Set());
		setDraft("");
		setErrors([]);
		setQuery("");
	};

	const toggleRow = (row: Row) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(rowKey(row))) next.delete(rowKey(row));
			else next.add(rowKey(row));
			return next;
		});

	const toggleAllVisible = () =>
		setSelected(allVisibleSelected ? new Set() : new Set(visible.map(rowKey)));

	const handleAdd = async () => {
		const inputs = splitInputs(draft);
		if (inputs.length === 0) return;
		try {
			const result =
				tab === "block"
					? await addBlock.mutateAsync(inputs)
					: await addKeep.mutateAsync({ addresses: inputs });
			const addedCount = inputs.length - result.errors.length;
			setErrors(result.errors);
			// Leave the rejected ones in the box so they can be fixed and re-added.
			setDraft(result.errors.map((e) => e.input).join("\n"));
			if (addedCount > 0) toastManager.add({ title: `已加入${info.title} ${addedCount} 条` });
		} catch (err) {
			toastManager.add({ title: err instanceof Error ? err.message : "添加失败", variant: "error" });
		}
	};

	const handleRemove = async (targets: Row[]) => {
		if (targets.length === 0) return;
		if (targets.length > 1 && !window.confirm(`从${info.title}移除这 ${targets.length} 条？`)) return;
		const addresses = targets.map((row) => row.address);
		try {
			if (tab === "block") await removeBlock.mutateAsync(addresses);
			else await removeKeep.mutateAsync(addresses);
			setSelected((prev) => {
				const next = new Set(prev);
				for (const row of targets) next.delete(rowKey(row));
				return next;
			});
			toastManager.add({
				title: targets.length === 1 ? `已从${info.title}移除 ${targets[0].address}` : `已从${info.title}移除 ${targets.length} 条`,
			});
		} catch (err) {
			toastManager.add({ title: err instanceof Error ? err.message : "移除失败", variant: "error" });
		}
	};

	return (
		<div className="h-full overflow-y-auto">
			<div className="max-w-4xl px-4 py-4 md:px-8 md:py-6 space-y-4">
				<h1 className="text-lg font-semibold text-kumo-default">发件人名单</h1>

				<div className="flex gap-1 border-b border-kumo-line" role="tablist">
					{(["block", "keep"] as const).map((key) => {
						const count = key === "block" ? blockRows.length : keepRows.length;
						const active = key === tab;
						return (
							<button
								key={key}
								type="button"
								role="tab"
								aria-selected={active}
								onClick={() => switchTab(key)}
								className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
									active
										? "border-kumo-brand font-medium text-kumo-default"
										: "border-transparent text-kumo-subtle hover:text-kumo-default"
								}`}
							>
								{key === "block" ? <ProhibitIcon size={14} /> : <PushPinIcon size={14} />}
								{TAB_INFO[key].title}
								<span className="text-xs text-kumo-subtle">{count}</span>
							</button>
						);
					})}
				</div>

				<p className="text-sm text-kumo-subtle">{info.description}</p>
				{tab === "keep" && burn && !burn.enabled && (
					<p className="text-sm text-kumo-warning">阅后即焚目前是关闭的，在侧栏「阅后即焚」里打开后这份名单才会起作用。</p>
				)}

				<div className="rounded-lg border border-kumo-line bg-kumo-base p-4 space-y-2">
					<textarea
						aria-label={`加入${info.title}的地址或域名`}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								void handleAdd();
							}
						}}
						placeholder={info.placeholder}
						rows={3}
						className="w-full resize-y rounded-md border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring"
					/>
					{errors.length > 0 && (
						<ul className="space-y-0.5 text-xs text-kumo-destructive">
							{errors.map((e) => (
								<li key={e.input}>
									{e.input}：{e.error}
								</li>
							))}
						</ul>
					)}
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs text-kumo-subtle">可以一次粘贴很多条，⌘/Ctrl + Enter 提交</span>
						<Button variant="primary" size="sm" loading={adding} disabled={!draft.trim()} onClick={() => void handleAdd()}>
							{info.addLabel}
						</Button>
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<div className="relative min-w-0 flex-1 basis-48">
						<MagnifyingGlassIcon size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-kumo-subtle" />
						<input
							aria-label="搜索名单"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="搜索地址或域名"
							className="w-full rounded-md border border-kumo-line bg-kumo-base py-1.5 pl-8 pr-2 text-sm"
						/>
					</div>
					<select
						aria-label="类型"
						value={typeFilter}
						onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
						className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm"
					>
						<option value="all">全部类型</option>
						<option value="address">单个地址</option>
						<option value="domain">整个域名</option>
					</select>
					<select
						aria-label="排序"
						value={sort}
						onChange={(e) => setSort(e.target.value as typeof sort)}
						className="rounded-md border border-kumo-line bg-kumo-base px-2 py-1.5 text-sm"
					>
						<option value="recent">最近添加</option>
						<option value="name">按字母</option>
					</select>
				</div>

				<div className="rounded-lg border border-kumo-line bg-kumo-base">
					<div className="flex items-center gap-3 border-b border-kumo-line px-4 py-2 text-xs text-kumo-subtle">
						<input
							type="checkbox"
							className="h-4 w-4 accent-kumo-brand"
							checked={allVisibleSelected}
							disabled={visible.length === 0}
							onChange={toggleAllVisible}
							aria-label="全选当前显示的条目"
						/>
						<span className="flex-1">
							{visible.length === rows.length ? `共 ${rows.length} 条` : `显示 ${visible.length} / ${rows.length} 条`}
							{selectedVisible.length > 0 && `，已选 ${selectedVisible.length} 条`}
						</span>
						{selectedVisible.length > 0 && (
							<Button variant="secondary" size="xs" loading={removing} onClick={() => void handleRemove(selectedVisible)}>
								移除所选
							</Button>
						)}
					</div>
					{!loaded ? (
						<p className="px-4 py-8 text-center text-sm text-kumo-subtle">正在加载…</p>
					) : visible.length === 0 ? (
						<p className="px-4 py-8 text-center text-sm text-kumo-subtle">
							{rows.length === 0 ? `${info.title}还是空的。` : "没有符合条件的条目。"}
						</p>
					) : (
						<ul>
							{visible.map((row) => (
								<li key={rowKey(row)} className="flex items-center gap-3 border-b border-kumo-line px-4 py-2 last:border-b-0">
									<input
										type="checkbox"
										className="h-4 w-4 shrink-0 accent-kumo-brand"
										checked={selected.has(rowKey(row))}
										onChange={() => toggleRow(row)}
										aria-label={`选择 ${row.address}`}
									/>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="truncate text-sm text-kumo-default" title={row.address}>
												{row.type === "domain" ? `@${row.address}` : row.address}
											</span>
											{row.type === "domain" && (
												<span className="shrink-0 rounded bg-kumo-tint px-1.5 py-0.5 text-[10px] text-kumo-subtle">整个域名</span>
											)}
										</div>
										<div className="truncate text-xs text-kumo-subtle">
											{row.source} · {formatListDate(row.createdAt)}
										</div>
									</div>
									<button
										type="button"
										className="shrink-0 rounded p-1 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-destructive"
										aria-label={`从${info.title}移除 ${row.address}`}
										disabled={removing}
										onClick={() => void handleRemove([row])}
									>
										<XIcon size={14} />
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}
