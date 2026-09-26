// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Tooltip } from "@cloudflare/kumo";
import {
	CheckIcon,
	CopyIcon,
	PlugsIcon,
	WrenchIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// Clipboard API unavailable or permission denied — ignore silently
		}
	};

	return (
		<Tooltip content={copied ? "已复制" : "复制"} asChild>
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				icon={
					copied ? (
						<CheckIcon size={12} weight="bold" className="text-kumo-success" />
					) : (
						<CopyIcon size={12} />
					)
				}
				onClick={handleCopy}
				aria-label="复制到剪贴板"
			/>
		</Tooltip>
	);
}

const TOOLS = [
	{ name: "list_mailboxes", desc: "列出所有邮箱" },
	{ name: "list_emails", desc: "列出文件夹中的邮件" },
	{ name: "get_email", desc: "读取含正文的完整邮件" },
	{ name: "get_thread", desc: "加载整个会话" },
	{ name: "search_emails", desc: "按关键词搜索邮件" },
	{ name: "draft_reply", desc: "为邮件起草回复" },
	{ name: "create_draft", desc: "创建草稿（新邮件或回复）" },
	{ name: "update_draft", desc: "修改已有草稿" },
	{ name: "send_reply", desc: "发送回复" },
	{ name: "send_email", desc: "发送新邮件" },
	{ name: "mark_email_read", desc: "将邮件标为已读/未读" },
	{ name: "move_email", desc: "将邮件移至文件夹" },
	{ name: "delete_email", desc: "永久删除邮件" },
	{ name: "report_spam", desc: "举报垃圾邮件并拉黑发件人" },
];

export default function MCPPanel() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const baseUrl =
		typeof window !== "undefined" ? window.location.origin : "https://your-app.workers.dev";
	const mcpUrl = `${baseUrl}/mcp`;

	return (
		<div className="flex flex-col h-full">
			{/* Content */}
			<div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
				{/* Intro */}
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-brand/10">
							<PlugsIcon
								size={20}
								weight="duotone"
								className="text-kumo-brand"
							/>
						</div>
						<div>
							<h3 className="text-sm font-semibold text-kumo-default">
								通过 MCP 连接
							</h3>
							<p className="text-xs text-kumo-subtle">
								Model Context Protocol
							</p>
						</div>
					</div>
					<p className="text-xs text-kumo-subtle leading-relaxed">
						此 AI 助手提供 MCP 服务器，AI 编程助手可以借此直接管理你的收件箱——用自然语言读取邮件、搜索、起草回复和发送邮件。
					</p>
				</div>

				{/* MCP URL */}
				<div className="space-y-1.5">
					<label className="text-xs font-medium text-kumo-strong block">
						服务器 URL
					</label>
					<div className="relative group">
						<div className="absolute right-1.5 top-1/2 -translate-y-1/2">
							<CopyButton text={mcpUrl} />
						</div>
						<div className="bg-kumo-recessed text-kumo-default font-mono text-[11px] px-3 py-2.5 pr-10 rounded-lg border border-kumo-line break-all leading-relaxed">
							{mcpUrl}
						</div>
					</div>
				</div>

				{/* Available tools */}
				<div className="space-y-2">
					<h4 className="text-xs uppercase tracking-wider font-semibold text-kumo-subtle px-0.5">
						可用工具
					</h4>
					<div className="border border-kumo-line rounded-lg divide-y divide-kumo-line">
						{TOOLS.map((tool) => (
							<div
								key={tool.name}
								className="flex items-center gap-2.5 px-3 py-2"
							>
								<WrenchIcon
									size={12}
									weight="bold"
									className="text-kumo-brand shrink-0"
								/>
								<div className="min-w-0 flex-1">
									<span className="text-xs font-mono font-medium text-kumo-default">
										{tool.name}
									</span>
								</div>
								<span className="text-[11px] text-kumo-subtle shrink-0">
									{tool.desc}
								</span>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
