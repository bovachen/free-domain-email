// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Button, Loader } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import api from "~/services/api";

export default function ReportSpamRoute() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();
	const mailbox = searchParams.get("mailbox") || "";
	const emailId = searchParams.get("email") || "";
	const [status, setStatus] = useState<"loading" | "ok" | "error">(
		mailbox && emailId ? "loading" : "error",
	);
	const [message, setMessage] = useState(
		mailbox && emailId ? "正在举报垃圾邮件并拉黑发送者…" : "缺少邮件信息，无法举报。",
	);
	const [sender, setSender] = useState<string | null>(null);
	const ran = useRef(false);

	useEffect(() => {
		if (ran.current) return;
		ran.current = true;
		if (!mailbox || !emailId) return;

		const cacheKey = `spam-report:${mailbox}:${emailId}`;
		try {
			const cached = sessionStorage.getItem(cacheKey);
			if (cached) {
				const parsed = JSON.parse(cached) as { sender?: string | null };
				setStatus("ok");
				setSender(parsed.sender ?? null);
				setMessage(
					parsed.sender
						? `已将 ${parsed.sender} 加入黑名单，邮件已移入垃圾箱。之后来自该地址的邮件会直接进 Spam。`
						: "邮件已移入垃圾箱。",
				);
				return;
			}
		} catch {
			// Ignore bad cache and report again.
		}

		void api
			.reportSpam(mailbox, emailId)
			.then((res) => {
				try {
					sessionStorage.setItem(cacheKey, JSON.stringify(res));
				} catch {
					// Private mode / quota — reporting still succeeded.
				}
				setStatus("ok");
				setSender(res.sender);
				setMessage(
					res.sender
						? `已将 ${res.sender} 加入黑名单，邮件已移入垃圾箱。之后来自该地址的邮件会直接进 Spam。`
						: "邮件已移入垃圾箱。",
				);
			})
			.catch((err) => {
				setStatus("error");
				setMessage(err instanceof Error ? err.message : "举报失败");
			});
	}, [mailbox, emailId]);

	const spamHref = mailbox
		? `/mail/mailbox/${encodeURIComponent(mailbox)}/emails/spam`
		: "/mail/emails/spam";
	const inboxHref = mailbox
		? `/mail/mailbox/${encodeURIComponent(mailbox)}/emails/inbox`
		: "/mail/emails/inbox";

	return (
		<div className="min-h-screen flex items-center justify-center p-6 bg-kumo-recessed">
			<div className="w-full max-w-md rounded-xl border border-kumo-line bg-kumo-base p-6 text-center">
				<div className="flex justify-center mb-4">
					{status === "loading" && <Loader size="lg" />}
					{status === "ok" && (
						<CheckCircleIcon size={48} weight="duotone" className="text-kumo-success" />
					)}
					{status === "error" && (
						<WarningIcon size={48} weight="duotone" className="text-kumo-destructive" />
					)}
				</div>
				<h1 className="text-lg font-semibold text-kumo-default mb-2">
					{status === "loading" && "举报垃圾邮件"}
					{status === "ok" && "已举报并拉黑"}
					{status === "error" && "无法完成举报"}
				</h1>
				<p className="text-sm text-kumo-subtle mb-5">{message}</p>
				{sender && (
					<p className="text-xs text-kumo-subtle mb-5 font-mono break-all">{sender}</p>
				)}
				<div className="flex flex-col sm:flex-row gap-2 justify-center">
					<Button variant="primary" onClick={() => navigate(spamHref)}>
						查看垃圾箱
					</Button>
					<Button variant="secondary" onClick={() => navigate(inboxHref)}>
						返回收件箱
					</Button>
				</div>
			</div>
		</div>
	);
}
