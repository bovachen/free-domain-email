// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

// "添加域名": lists the zones in the user's Cloudflare account and, for the
// one picked, enables Email Routing, points the catch-all rule at this
// Worker, records the domain, and (when RESEND_API_KEY allows it) registers
// the domain with Resend and writes its DNS records.

import type { Env } from "../types";
import { addDomain, configuredDomains } from "./domain-settings";

const SETTINGS_KEY = "settings/cloudflare.json";
const CF_API = "https://api.cloudflare.com/client/v4";
const RESEND_API = "https://api.resend.com";
const DEFAULT_WORKER_NAME = "free-domain-email";
const ROUTING_MX_SUFFIX = ".mx.cloudflare.net";

interface CloudflareSettings {
	apiToken: string;
}

export interface CloudflarePublicSettings {
	tokenConfigured: boolean;
	/** "env" when CLOUDFLARE_API_TOKEN is a Worker secret; it then wins over a saved token. */
	tokenSource: "env" | "saved" | null;
}

export interface Zone {
	id: string;
	name: string;
	status: string;
	account: { id: string; name: string };
}

export interface ZoneSummary {
	id: string;
	name: string;
	status: string;
	accountName: string;
	configured: boolean;
}

export interface SetupStep {
	step: string;
	ok: boolean;
	message: string;
}

export interface MxConflict {
	id: string;
	content: string;
	priority?: number;
}

export class MxConflictError extends Error {
	records: MxConflict[];
	constructor(records: MxConflict[]) {
		super("这个域名已有其他 MX 记录，开启 Email Routing 会让原来的邮箱收不到信");
		this.records = records;
	}
}

// -- Settings -------------------------------------------------------

async function getSavedSettings(bucket: R2Bucket): Promise<CloudflareSettings> {
	const obj = await bucket.get(SETTINGS_KEY);
	return obj ? ((await obj.json()) as CloudflareSettings) : { apiToken: "" };
}

function resolveToken(env: Env, saved: CloudflareSettings): string {
	return env.CLOUDFLARE_API_TOKEN || saved.apiToken || "";
}

export async function getCloudflareSettings(env: Env): Promise<CloudflarePublicSettings> {
	const saved = await getSavedSettings(env.BUCKET);
	const tokenSource = env.CLOUDFLARE_API_TOKEN ? "env" : saved.apiToken ? "saved" : null;
	return { tokenConfigured: tokenSource !== null, tokenSource };
}

/** Saves the token after checking that it can list zones. */
export async function saveCloudflareToken(env: Env, apiToken: string): Promise<CloudflarePublicSettings> {
	const token = apiToken.trim();
	if (token) await cf(token, "GET", "/zones?per_page=1");
	await env.BUCKET.put(SETTINGS_KEY, JSON.stringify({ apiToken: token }));
	return getCloudflareSettings(env);
}

async function requireToken(env: Env): Promise<string> {
	const token = resolveToken(env, await getSavedSettings(env.BUCKET));
	if (!token) throw new Error("请先填写 Cloudflare API Token");
	return token;
}

// -- Cloudflare API -------------------------------------------------

interface CfResponse<T> {
	success: boolean;
	errors?: { code: number; message: string }[];
	result: T;
	result_info?: { page: number; total_pages: number };
}

async function cf<T>(token: string, method: string, path: string, body?: unknown): Promise<CfResponse<T>> {
	const res = await fetch(`${CF_API}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as CfResponse<T>;
	if (!res.ok || !data.success) {
		const detail = data.errors?.map((e) => `${e.message}（${e.code}）`).join("；") || `HTTP ${res.status}`;
		const hint = res.status === 403 || res.status === 401 ? "。请检查 API Token 的权限" : "";
		throw new Error(`Cloudflare API ${method} ${path.split("?")[0]} 失败：${detail}${hint}`);
	}
	return data;
}

async function listZones(token: string): Promise<Zone[]> {
	const zones: Zone[] = [];
	for (let page = 1; ; page++) {
		const data = await cf<Zone[]>(token, "GET", `/zones?per_page=50&page=${page}`);
		zones.push(...data.result);
		if (!data.result_info || page >= data.result_info.total_pages) break;
	}
	return zones;
}

export async function listAvailableZones(env: Env): Promise<ZoneSummary[]> {
	const token = await requireToken(env);
	const [zones, domains] = await Promise.all([listZones(token), configuredDomains(env)]);
	return zones
		.map((z) => ({
			id: z.id,
			name: z.name,
			status: z.status,
			accountName: z.account?.name || "",
			configured: domains.includes(z.name.toLowerCase()),
		}))
		.sort((a, b) => Number(a.configured) - Number(b.configured) || a.name.localeCompare(b.name));
}

interface DnsRecord {
	id: string;
	type: string;
	name: string;
	content: string;
	priority?: number;
}

/** Root MX records that do not belong to Email Routing. */
async function conflictingMx(token: string, zone: Zone): Promise<MxConflict[]> {
	const { result } = await cf<DnsRecord[]>(
		token,
		"GET",
		`/zones/${zone.id}/dns_records?type=MX&name=${encodeURIComponent(zone.name)}&per_page=100`,
	);
	return result
		.filter((r) => !r.content.toLowerCase().endsWith(ROUTING_MX_SUFFIX))
		.map((r) => ({ id: r.id, content: r.content, priority: r.priority }));
}

interface CatchAll {
	enabled: boolean;
	actions: { type: string; value?: string[] }[];
}

/** The Worker other configured domains' catch-all rules send mail to, if any. */
async function workerFromOtherDomains(env: Env, token: string, zones: Zone[], exclude: string): Promise<string | null> {
	const domains = (await configuredDomains(env)).filter((d) => d !== exclude);
	for (const zone of zones.filter((z) => domains.includes(z.name.toLowerCase()))) {
		try {
			const { result } = await cf<CatchAll>(token, "GET", `/zones/${zone.id}/email/routing/rules/catch_all`);
			const action = result.actions?.find((a) => a.type === "worker");
			if (result.enabled && action?.value?.[0]) return action.value[0];
		} catch {
			// Try the next domain.
		}
	}
	return null;
}

/**
 * Workers cannot read their own script name, so reuse the target of an
 * already-configured domain's catch-all rule. Falls back to WORKER_NAME,
 * then the default name from wrangler.jsonc.
 */
async function detectWorkerName(env: Env, token: string, zones: Zone[], exclude: string): Promise<string> {
	return (await workerFromOtherDomains(env, token, zones, exclude)) || env.WORKER_NAME || DEFAULT_WORKER_NAME;
}

// -- Resend ---------------------------------------------------------

interface ResendRecord {
	record: string;
	name: string;
	type: string;
	value: string;
	priority?: number;
}

interface ResendDomain {
	id: string;
	name: string;
	status: string;
	records?: ResendRecord[];
}

async function resend<T>(apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${RESEND_API}${path}`, {
		method,
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as T & { message?: string; name?: string };
	if (!res.ok) {
		if (data.name === "restricted_api_key") {
			throw new Error(
				"RESEND_API_KEY 只有发信权限，无法添加域名。请在 Resend 后台手动添加这个域名，或换成 Full access 的 Key",
			);
		}
		throw new Error(`Resend ${method} ${path} 失败：${data.message || `HTTP ${res.status}`}`);
	}
	return data;
}

async function findResendDomain(apiKey: string, name: string): Promise<ResendDomain | undefined> {
	const { data } = await resend<{ data: ResendDomain[] }>(apiKey, "GET", "/domains");
	return data.find((d) => d.name.toLowerCase() === name.toLowerCase());
}

function resendRecordName(r: ResendRecord, zone: Zone): string {
	return r.name ? `${r.name}.${zone.name}` : zone.name;
}

function sameContent(a: string, b: string): boolean {
	const normalize = (s: string) => s.replace(/^"|"$/g, "").toLowerCase();
	return normalize(a) === normalize(b);
}

async function setupResend(env: Env, token: string, zone: Zone): Promise<SetupStep> {
	const apiKey = env.RESEND_API_KEY!;
	let domain = await findResendDomain(apiKey, zone.name);
	if (!domain) domain = await resend<ResendDomain>(apiKey, "POST", "/domains", { name: zone.name });
	if (domain.status === "verified") {
		return { step: "Resend 发信", ok: true, message: "域名已在 Resend 中验证" };
	}
	const detail = await resend<ResendDomain>(apiKey, "GET", `/domains/${domain.id}`);

	let written = 0;
	for (const r of detail.records ?? []) {
		const fqdn = resendRecordName(r, zone);
		const { result: current } = await cf<DnsRecord[]>(
			token,
			"GET",
			`/zones/${zone.id}/dns_records?type=${r.type}&name=${encodeURIComponent(fqdn)}`,
		);
		if (current.some((c) => sameContent(c.content, r.value))) continue;
		await cf(token, "POST", `/zones/${zone.id}/dns_records`, {
			type: r.type,
			name: fqdn,
			content: r.value,
			ttl: 1,
			proxied: false,
			...(r.priority !== undefined ? { priority: r.priority } : {}),
			comment: "Resend (free-domain-email)",
		});
		written++;
	}
	await resend(apiKey, "POST", `/domains/${domain.id}/verify`);
	return {
		step: "Resend 发信",
		ok: true,
		message: `已添加到 Resend，写入 ${written} 条 DNS 记录，正在验证（通常几分钟内完成）`,
	};
}

// -- Setup ----------------------------------------------------------

export async function setupDomain(
	env: Env,
	opts: { zoneId: string; replaceMx?: boolean; resend?: boolean },
): Promise<{ domain: string; steps: SetupStep[] }> {
	const token = await requireToken(env);
	const zones = await listZones(token);
	const zone = zones.find((z) => z.id === opts.zoneId);
	if (!zone) throw new Error("没有找到这个域名，或 API Token 无权访问它");
	const domain = zone.name.toLowerCase();
	const steps: SetupStep[] = [];

	// 1. Email Routing (adds and locks the MX/SPF records).
	const conflicts = await conflictingMx(token, zone);
	if (conflicts.length > 0) {
		if (!opts.replaceMx) throw new MxConflictError(conflicts);
		for (const r of conflicts) await cf(token, "DELETE", `/zones/${zone.id}/dns_records/${r.id}`);
		steps.push({ step: "删除旧 MX 记录", ok: true, message: conflicts.map((r) => r.content).join("、") });
	}
	const routing = await cf<{ enabled: boolean; status: string }>(token, "GET", `/zones/${zone.id}/email/routing`)
		.then((d) => d.result)
		.catch(() => null);
	if (routing?.enabled && routing.status === "ready") {
		steps.push({ step: "Email Routing", ok: true, message: "已经是开启状态" });
	} else {
		const { result } = await cf<{ status: string }>(token, "POST", `/zones/${zone.id}/email/routing/dns`, {});
		steps.push({ step: "Email Routing", ok: true, message: `已开启，并添加 MX/SPF 记录（状态：${result.status}）` });
	}

	// 2. Catch-all -> this Worker.
	const workerName = await detectWorkerName(env, token, zones, domain);
	await cf(token, "PUT", `/zones/${zone.id}/email/routing/rules/catch_all`, {
		name: "free-domain-email",
		enabled: true,
		matchers: [{ type: "all" }],
		actions: [{ type: "worker", value: [workerName] }],
	});
	steps.push({ step: "Catch-all 规则", ok: true, message: `任意地址 → Worker ${workerName}` });

	// 3. Record the domain so the Worker accepts its mail.
	await addDomain(env, domain);
	steps.push({ step: "加入域名列表", ok: true, message: `通配地址默认开启，*@${domain} 的邮件会自动建邮箱` });

	// 4. Optional: Resend sending. Failures here do not undo the receiving side.
	if (opts.resend && env.RESEND_API_KEY) {
		try {
			steps.push(await setupResend(env, token, zone));
		} catch (e) {
			steps.push({ step: "Resend 发信", ok: false, message: (e as Error).message });
		}
	}

	return { domain, steps };
}

// -- Teardown -------------------------------------------------------

/**
 * Undoes setupDomain on the Cloudflare/Resend side. Each step is
 * independent: a failure is reported and the rest still run.
 */
export async function teardownDomain(
	env: Env,
	domain: string,
	opts: { cloudflare?: boolean; resend?: boolean },
): Promise<SetupStep[]> {
	const steps: SetupStep[] = [];
	if (!opts.cloudflare && !opts.resend) return steps;

	let token: string;
	let zone: Zone | undefined;
	let zones: Zone[] = [];
	try {
		token = await requireToken(env);
		zones = await listZones(token);
		zone = zones.find((z) => z.name.toLowerCase() === domain);
		if (!zone) throw new Error("Cloudflare 账户里没有找到这个域名，或 API Token 无权访问它");
	} catch (e) {
		return [{ step: "Cloudflare", ok: false, message: (e as Error).message }];
	}
	const run = async (step: string, fn: () => Promise<string>) => {
		try {
			steps.push({ step, ok: true, message: await fn() });
		} catch (e) {
			steps.push({ step, ok: false, message: (e as Error).message });
		}
	};

	if (opts.cloudflare) {
		// Only touch rules that send mail to this Worker; forwards set up by hand stay.
		const ownWorker = await workerFromOtherDomains(env, token, zones, domain);
		const isOwn = (action?: { type: string; value?: string[] }) =>
			action?.type === "worker" && (!ownWorker || action.value?.[0] === ownWorker);

		await run("Catch-all 规则", async () => {
			const { result } = await cf<CatchAll>(token, "GET", `/zones/${zone!.id}/email/routing/rules/catch_all`);
			if (!result.enabled || !result.actions?.some(isOwn)) return "没有指向这个 Worker，未改动";
			await cf(token, "PUT", `/zones/${zone!.id}/email/routing/rules/catch_all`, {
				enabled: false,
				matchers: [{ type: "all" }],
				actions: [{ type: "drop" }],
			});
			return "已停用（不再转给 Worker）";
		});

		await run("路由规则", async () => {
			const { result } = await cf<{ id: string; actions: { type: string; value?: string[] }[] }[]>(
				token,
				"GET",
				`/zones/${zone!.id}/email/routing/rules?per_page=50`,
			);
			const own = result.filter((r) => r.actions?.some(isOwn));
			for (const r of own) await cf(token, "DELETE", `/zones/${zone!.id}/email/routing/rules/${r.id}`);
			return own.length > 0 ? `删除了 ${own.length} 条指向 Worker 的规则` : "没有指向 Worker 的规则";
		});

		await run("Email Routing", async () => {
			await cf(token, "DELETE", `/zones/${zone!.id}/email/routing/dns`);
			return "已关闭，并删除收信用的 MX/SPF 记录";
		});
	}

	if (opts.resend) {
		await run("Resend 发信", async () => {
			const apiKey = env.RESEND_API_KEY;
			if (!apiKey) return "没有配置 RESEND_API_KEY，跳过";
			const found = await findResendDomain(apiKey, domain);
			if (!found) return "Resend 里没有这个域名";
			const detail = await resend<ResendDomain>(apiKey, "GET", `/domains/${found.id}`);
			let removed = 0;
			for (const r of detail.records ?? []) {
				const { result } = await cf<DnsRecord[]>(
					token,
					"GET",
					`/zones/${zone!.id}/dns_records?type=${r.type}&name=${encodeURIComponent(resendRecordName(r, zone!))}`,
				);
				for (const rec of result.filter((c) => sameContent(c.content, r.value))) {
					await cf(token, "DELETE", `/zones/${zone!.id}/dns_records/${rec.id}`);
					removed++;
				}
			}
			await resend(apiKey, "DELETE", `/domains/${found.id}`);
			return `已从 Resend 删除，并删除 ${removed} 条发信 DNS 记录`;
		});
	}

	return steps;
}
