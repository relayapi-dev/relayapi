import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AlertCircle,
	ArrowUpRight,
	Check,
	Copy,
	Eye,
	EyeOff,
	Link2,
	Loader2,
	Plus,
	RefreshCw,
	Send,
	Unplug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/use-api";
import { useUsage } from "@/hooks/use-usage";
import { formatNumber } from "@/types/dashboard";
import { platformLabels } from "@/lib/platform-maps";
import { Segmented } from "../segmented";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const HEAT_COLORS = ["var(--muted)", "#9be9a8", "#40c463", "#30a14e", "#216e39"];
const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const DAY_MS = 86_400_000;

function card(extra = "") {
	return `rounded-[12px] border border-border bg-card p-6 md:p-[26px] ${extra}`;
}

function platformLabel(p?: string | null): string {
	if (!p) return "account";
	return platformLabels[p.toLowerCase()] || p;
}

function timeAgo(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return "";
	const diff = Date.now() - then;
	const m = Math.floor(diff / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 30) return `${d}d ago`;
	return new Date(iso).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-[14px] text-muted-foreground">{label}</div>
			<div className="mt-1.5 text-[20px] font-semibold tracking-[-0.01em]">
				{value}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Connections preview (top-left)
// ---------------------------------------------------------------------------

interface IntegrationAccount {
	id: string;
	display_name: string | null;
	username: string | null;
	platform: string;
	avatar_url?: string | null;
}

// Fixed card height shared by Connections + API key so the row stays balanced
// regardless of how many accounts are connected (and so the avatar grid always
// has a defined area to measure against).
const CARD_H = "h-[300px]";
// Avatar tile geometry (Tailwind size-10 + gap-2) used to compute how many
// tiles fit the grid. Keep in sync with the classNames below.
const TILE_PX = 40;
const TILE_GAP_PX = 8;
// How many accounts to fetch — an upper bound on tiles the grid can ever show
// (the card is fixed-height, so even a very wide screen tops out well under
// this). Beyond what fits, the remainder collapses into one "+N" tile.
const CONN_FETCH = 40;

// Measures a wrap-grid container and returns how many fixed-size tiles fit.
// Recomputes on resize so the "+N" overflow tile always lands on the last
// visible cell instead of being clipped.
function useGridCapacity(tile = TILE_PX, gap = TILE_GAP_PX) {
	const ref = useRef<HTMLDivElement>(null);
	const [capacity, setCapacity] = useState(0);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => {
			const w = el.clientWidth;
			const h = el.clientHeight;
			if (w <= 0 || h <= 0) return;
			const cols = Math.max(1, Math.floor((w + gap) / (tile + gap)));
			const rows = Math.max(1, Math.floor((h + gap) / (tile + gap)));
			setCapacity(cols * rows);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [tile, gap]);

	return [ref, capacity] as const;
}

function AccountAvatar({ acc }: { acc: IntegrationAccount }) {
	const title = `${acc.display_name || acc.username || "Account"} · ${platformLabel(acc.platform)}`;
	if (acc.avatar_url) {
		return (
			<img
				src={acc.avatar_url}
				alt={acc.display_name || acc.username || acc.platform || "account"}
				title={title}
				className="size-10 shrink-0 rounded-md object-cover ring-1 ring-border"
			/>
		);
	}
	return (
		<div
			title={title}
			className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-[13px] font-semibold text-muted-foreground"
		>
			{(acc.display_name || acc.username || acc.platform || "?")
				.charAt(0)
				.toUpperCase()}
		</div>
	);
}

function ConnectionsCard() {
	const { data, loading } = useApi<{
		data: IntegrationAccount[];
		total?: number;
		has_more?: boolean;
	}>(`accounts?limit=${CONN_FETCH}`);
	const [gridRef, capacity] = useGridCapacity();

	const accounts = data?.data ?? [];
	const total = data?.total ?? accounts.length;
	const isEmpty = !loading && total === 0;

	// Until the grid is measured, render nothing in it (the skeleton covers the
	// loading frame). Once measured, fit `capacity` tiles; if more accounts exist
	// than fit, give the last cell to a "+N" tile.
	const showOverflow = capacity > 0 && total > capacity;
	const visibleCount = showOverflow
		? Math.max(0, capacity - 1)
		: Math.min(total, capacity);
	const visible = accounts.slice(0, visibleCount);
	const overflow = Math.max(0, total - visible.length);
	const showSkeleton = loading || capacity === 0;

	return (
		<div className={card(`flex flex-col ${CARD_H}`)}>
			<div className="flex items-center justify-between">
				<h3 className="text-[17px] font-semibold">Connections</h3>
				<a
					href="/app/connections"
					className="inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
				>
					Manage <ArrowUpRight className="size-3.5" />
				</a>
			</div>

			{isEmpty ? (
				<>
					<p className="mt-3 text-[14.5px] leading-normal text-muted-foreground">
						Link a social channel to start publishing and listening across
						every platform.
					</p>
					<div className="mt-auto pt-[22px]">
						<Button asChild>
							<a href="/app/connections">
								<Plus className="size-4" /> Connect an account
							</a>
						</Button>
					</div>
				</>
			) : (
				<>
					<div
						ref={gridRef}
						className="mt-4 flex min-h-0 flex-1 flex-wrap content-start gap-2 overflow-hidden"
					>
						{showSkeleton
							? Array.from({ length: 12 }, (_, i) => (
									<div
										key={i}
										className="size-10 animate-pulse rounded-md bg-muted"
									/>
								))
							: visible.map((acc) => (
									<AccountAvatar key={acc.id} acc={acc} />
								))}
						{showOverflow ? (
							<a
								href="/app/connections"
								title="View all connections"
								className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								+{formatNumber(overflow)}
							</a>
						) : null}
					</div>
					<div className="mt-auto flex items-center justify-between pt-4">
						<span className="text-[13px] text-muted-foreground">
							{loading ? "" : `${formatNumber(total)} connected`}
						</span>
						<Button variant="outline" size="sm" asChild>
							<a href="/app/connections">
								<Plus className="size-3.5" /> Connect
							</a>
						</Button>
					</div>
				</>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// API key (top-right) — Stripe-style reveal & copy of the working key
// ---------------------------------------------------------------------------

const MASKED_KEY = `rlay_live_${"•".repeat(24)}`;
// Mobile shows an abbreviated mask so the key never crowds the narrow card.
const MASKED_KEY_SHORT = `rlay_live_${"•".repeat(3)}`;

function ApiKeyCard() {
	const { data: status, loading, refetch } = useApi<{ has_api_key: boolean }>(
		"dashboard-key-status",
	);
	const [key, setKey] = useState<string | null>(null);
	const [revealed, setRevealed] = useState(false);
	const [copied, setCopied] = useState(false);
	const [busy, setBusy] = useState(false);
	const hasKey = status?.has_api_key ?? false;

	const loadKey = useCallback(async (): Promise<string | null> => {
		const res = await fetch("/api/reveal-key", {
			headers: { "cache-control": "no-store" },
		});
		if (!res.ok) return null;
		const json = await res.json().catch(() => null);
		const k = (json?.key as string | null) ?? null;
		if (k) setKey(k);
		return k;
	}, []);

	const onReveal = async () => {
		if (revealed) {
			setRevealed(false);
			return;
		}
		setBusy(true);
		const k = key ?? (await loadKey());
		setBusy(false);
		if (k) setRevealed(true);
	};

	const onCopy = async () => {
		setBusy(true);
		const k = key ?? (await loadKey());
		setBusy(false);
		if (k) {
			await navigator.clipboard.writeText(k);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const onCreate = async () => {
		setBusy(true);
		await fetch("/api/bootstrap-key", { method: "POST" });
		const k = await loadKey();
		setBusy(false);
		if (k) setRevealed(true);
		refetch();
	};

	return (
		<div className={card(`flex flex-col ${CARD_H}`)}>
			<div className="flex items-center justify-between">
				<h3 className="text-[17px] font-semibold">API key</h3>
				<a
					href="/app/api-keys"
					className="inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
				>
					Manage <ArrowUpRight className="size-3.5" />
				</a>
			</div>

			{loading ? (
				// Mirrors the loaded layout: description near the top, the key control
				// pinned to the bottom via mt-auto, so the card height stays stable.
				<>
					<div className="mt-3 space-y-1.5">
						<div className="h-3.5 w-full animate-pulse rounded bg-muted" />
						<div className="h-3.5 w-3/5 animate-pulse rounded bg-muted" />
					</div>
					<div className="mt-auto pt-[22px]">
						<div className="h-[38px] w-full animate-pulse rounded-md bg-muted" />
						<div className="mt-3 h-4 w-40 animate-pulse rounded bg-muted" />
					</div>
				</>
			) : !hasKey ? (
				<>
					<p className="mt-3 text-[14.5px] leading-normal text-muted-foreground">
						Create a secret key to authenticate your requests to the RelayAPI.
					</p>
					<div className="mt-auto pt-[22px]">
						<Button onClick={onCreate} disabled={busy}>
							{busy ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<>
									<Plus className="size-4" /> Create API key
								</>
							)}
						</Button>
					</div>
				</>
			) : (
				<>
					<p className="mt-3 text-[14.5px] leading-normal text-muted-foreground">
						Use this secret key to authenticate requests. Keep it private — treat
						it like a password.
					</p>
					<div className="mt-auto pt-[22px]">
						<div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
							<code className="min-w-0 flex-1 truncate font-mono text-[11px] sm:text-[13px]">
								{revealed && key ? (
									key
								) : (
									<>
										<span className="sm:hidden">{MASKED_KEY_SHORT}</span>
										<span className="hidden sm:inline">{MASKED_KEY}</span>
									</>
								)}
							</code>
							<button
								type="button"
								onClick={onReveal}
								disabled={busy}
								title={revealed ? "Hide" : "Reveal"}
								className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								{busy && !revealed ? (
									<Loader2 className="size-4 animate-spin" />
								) : revealed ? (
									<EyeOff className="size-4" />
								) : (
									<Eye className="size-4" />
								)}
							</button>
							<button
								type="button"
								onClick={onCopy}
								disabled={busy}
								title="Copy"
								className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								{copied ? (
									<Check className="size-4 text-success" />
								) : (
									<Copy className="size-4" />
								)}
							</button>
						</div>
						<div className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
							<span className="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 font-medium text-success">
								Production
							</span>
							<span>·</span>
							<span>read &amp; write</span>
						</div>
					</div>
				</>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// API Calls (real heatmap + stats from the usage timeseries)
// ---------------------------------------------------------------------------

type Series = "all" | "publish" | "listen";

interface TimeseriesDay {
	date: string;
	total: number;
	publish: number;
	listen: number;
}

interface TimeseriesResponse {
	range: { from: string; to: string };
	days: TimeseriesDay[];
}

interface HeatCell {
	date: Date;
	key: string;
	count: number;
	future: boolean;
}

function ymd(d: Date): string {
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function seriesCount(d: TimeseriesDay, series: Series): number {
	return series === "all" ? d.total : series === "publish" ? d.publish : d.listen;
}

function buildWeeks(
	days: TimeseriesDay[],
	series: Series,
): { weeks: HeatCell[][]; max: number } {
	const counts = new Map<string, number>();
	for (const d of days) counts.set(d.date, seriesCount(d, series));

	const WEEKS = 52;
	const now = new Date();
	const today = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	// Rightmost column ends on the Saturday of the current week so the grid is
	// week-aligned (future days in that column render blank).
	const gridEnd = new Date(today.getTime() + (6 - today.getUTCDay()) * DAY_MS);
	const gridStart = new Date(gridEnd.getTime() - (WEEKS * 7 - 1) * DAY_MS);

	const weeks: HeatCell[][] = [];
	let max = 0;
	for (let w = 0; w < WEEKS; w++) {
		const col: HeatCell[] = [];
		for (let d = 0; d < 7; d++) {
			const date = new Date(gridStart.getTime() + (w * 7 + d) * DAY_MS);
			const key = ymd(date);
			const count = counts.get(key) ?? 0;
			if (count > max) max = count;
			col.push({ date, key, count, future: date.getTime() > today.getTime() });
		}
		weeks.push(col);
	}
	return { weeks, max };
}

function levelFor(count: number, max: number): number {
	if (count <= 0 || max <= 0) return 0;
	return Math.max(1, Math.min(4, Math.ceil((count / max) * 4)));
}

interface HeatStats {
	total: number;
	bestDay: string | null;
	bestMonth: string | null;
	current: number;
	longest: number;
}

function computeStats(days: TimeseriesDay[], series: Series): HeatStats {
	const active = new Set<string>();
	let total = 0;
	let bestDayKey: string | null = null;
	let bestDayCount = 0;
	const byMonth = new Map<string, number>();

	for (const d of days) {
		const count = seriesCount(d, series);
		total += count;
		if (count > 0) active.add(d.date);
		if (count > bestDayCount) {
			bestDayCount = count;
			bestDayKey = d.date;
		}
		const m = d.date.slice(0, 7);
		byMonth.set(m, (byMonth.get(m) ?? 0) + count);
	}

	let bestMonthKey: string | null = null;
	let bestMonthCount = 0;
	for (const [m, v] of byMonth) {
		if (v > bestMonthCount) {
			bestMonthCount = v;
			bestMonthKey = m;
		}
	}

	// Streaks over the last year of calendar days (consecutive days with ≥1 call).
	const now = new Date();
	const todayMs = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate(),
	);
	let current = 0;
	for (let i = 0; i <= 366; i++) {
		if (active.has(ymd(new Date(todayMs - i * DAY_MS)))) current++;
		else break;
	}
	let longest = 0;
	let run = 0;
	for (let i = 365; i >= 0; i--) {
		if (active.has(ymd(new Date(todayMs - i * DAY_MS)))) {
			run++;
			if (run > longest) longest = run;
		} else {
			run = 0;
		}
	}

	return {
		total,
		bestDay:
			bestDayCount > 0 && bestDayKey
				? new Date(`${bestDayKey}T00:00:00Z`).toLocaleDateString("en-US", {
						month: "short",
						day: "numeric",
						year: "numeric",
					})
				: null,
		bestMonth:
			bestMonthCount > 0 && bestMonthKey
				? new Date(`${bestMonthKey}-01T00:00:00Z`).toLocaleDateString("en-US", {
						month: "long",
					})
				: null,
		current,
		longest,
	};
}

function ApiCallsCard() {
	const [series, setSeries] = useState<Series>("all");
	const { data } = useApi<TimeseriesResponse>("usage-timeseries?days=365");
	const days = useMemo(() => data?.days ?? [], [data]);
	const { weeks, max } = useMemo(
		() => buildWeeks(days, series),
		[days, series],
	);
	const stats = useMemo(() => computeStats(days, series), [days, series]);

	const monthLabels = useMemo(() => {
		const labels: string[] = [];
		let last = -1;
		for (const col of weeks) {
			const m = col[0]?.date.getUTCMonth() ?? -1;
			if (m !== last) {
				labels.push(MONTH_INITIALS[m] ?? "");
				last = m;
			} else {
				labels.push("");
			}
		}
		return labels;
	}, [weeks]);

	return (
		<div className={card()}>
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<div className="text-[14px] text-muted-foreground">API Calls</div>
					<div className="mt-1 text-[32px] font-semibold tracking-[-0.02em]">
						{formatNumber(stats.total)}
					</div>
				</div>
				<Segmented
					value={series}
					onChange={setSeries}
					options={[
						{ value: "all", label: "All" },
						{ value: "publish", label: "Publish" },
						{ value: "listen", label: "Listen" },
					]}
				/>
			</div>

			<div className="mt-[22px] overflow-x-auto">
				<div className="mb-1.5 flex gap-[3px] pl-[22px]">
					{monthLabels.map((mo, i) => (
						<div
							key={i}
							className="flex-1 text-[11px] text-muted-foreground"
						>
							{mo}
						</div>
					))}
				</div>
				<div className="flex gap-1.5">
					<div className="flex w-4 flex-col justify-between py-px">
						{["", "M", "", "W", "", "F", ""].map((d, i) => (
							<div
								key={i}
								className="h-[13px] text-[11px] leading-[13px] text-muted-foreground"
							>
								{d}
							</div>
						))}
					</div>
					<div className="flex flex-1 gap-[3px]">
						{weeks.map((col, wi) => (
							<div key={wi} className="flex flex-1 flex-col gap-[3px]">
								{col.map((cell, di) => (
									<div
										key={di}
										title={
											cell.future
												? undefined
												: `${cell.count} call${cell.count === 1 ? "" : "s"} · ${cell.key}`
										}
										className="aspect-square w-full rounded-[2.5px]"
										style={{
											background: cell.future
												? "transparent"
												: HEAT_COLORS[levelFor(cell.count, max)],
										}}
									/>
								))}
							</div>
						))}
					</div>
				</div>
			</div>

			<div className="mt-7 grid grid-cols-2 gap-4 md:grid-cols-4">
				<Stat label="Most Active Month" value={stats.bestMonth ?? "—"} />
				<Stat label="Most Active Day" value={stats.bestDay ?? "—"} />
				<Stat
					label="Longest Streak"
					value={stats.longest ? `${stats.longest}d` : "—"}
				/>
				<Stat
					label="Current Streak"
					value={stats.current ? `${stats.current}d` : "—"}
				/>
			</div>

			<div className="mt-6 flex items-center gap-2 text-[13px] text-muted-foreground">
				<span>Fewer</span>
				<span className="flex gap-[3px]">
					{HEAT_COLORS.map((c, i) => (
						<span
							key={i}
							className="size-3 rounded-[3px]"
							style={{ background: c }}
						/>
					))}
				</span>
				<span>More</span>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Recent activity (under API Calls)
// ---------------------------------------------------------------------------

interface ActivityItem {
	id: string;
	kind: "post" | "connection";
	event: "published" | "connected" | "disconnected" | "token_refreshed" | "error";
	platforms: string[];
	text: string | null;
	timestamp: string;
}

function activityTitle(it: ActivityItem): string {
	if (it.kind === "post") {
		const labels = it.platforms.map(platformLabel);
		return labels.length ? `Published to ${labels.join(", ")}` : "Published a post";
	}
	const label = platformLabel(it.platforms[0]);
	switch (it.event) {
		case "connected":
			return `Connected ${label}`;
		case "disconnected":
			return `Disconnected ${label}`;
		case "token_refreshed":
			return `Refreshed ${label} access`;
		case "error":
			return `${label} connection error`;
		default:
			return `${label} updated`;
	}
}

function ActivityIcon({ it }: { it: ActivityItem }) {
	const base =
		"flex size-8 shrink-0 items-center justify-center rounded-full";
	if (it.kind === "post") {
		return (
			<div className={`${base} bg-success/10 text-success`}>
				<Send className="size-4" />
			</div>
		);
	}
	switch (it.event) {
		case "connected":
			return (
				<div className={`${base} bg-success/10 text-success`}>
					<Link2 className="size-4" />
				</div>
			);
		case "disconnected":
			return (
				<div className={`${base} bg-muted text-muted-foreground`}>
					<Unplug className="size-4" />
				</div>
			);
		case "token_refreshed":
			return (
				<div className={`${base} bg-muted text-muted-foreground`}>
					<RefreshCw className="size-4" />
				</div>
			);
		case "error":
			return (
				<div className={`${base} bg-destructive/10 text-destructive`}>
					<AlertCircle className="size-4" />
				</div>
			);
		default:
			return (
				<div className={`${base} bg-muted text-muted-foreground`}>
					<Link2 className="size-4" />
				</div>
			);
	}
}

function ActivityCard() {
	const { data, loading } = useApi<{ data: ActivityItem[] }>("activity?limit=8");
	const items = data?.data ?? [];

	return (
		<div className={card()}>
			<h3 className="text-[17px] font-semibold">Recent activity</h3>

			{loading && items.length === 0 ? (
				<div className="mt-3 flex flex-col">
					{[0, 1, 2, 3, 4].map((i) => (
						<div
							key={i}
							className={`flex items-start gap-3.5 py-3 ${
								i ? "border-t border-border" : ""
							}`}
						>
							<div className="size-8 shrink-0 animate-pulse rounded-full bg-muted" />
							<div className="min-w-0 flex-1 space-y-1.5">
								<div className="h-3.5 w-40 animate-pulse rounded bg-muted" />
								<div className="h-3 w-24 animate-pulse rounded bg-muted" />
							</div>
							<div className="h-3 w-10 shrink-0 animate-pulse rounded bg-muted" />
						</div>
					))}
				</div>
			) : items.length === 0 ? (
				<p className="mt-4 text-[14px] text-muted-foreground">
					No recent activity yet. Publish a post or connect an account to see it
					here.
				</p>
			) : (
				<div className="mt-3 flex flex-col">
					{items.map((it, i) => (
						<div
							key={it.id}
							className={`flex items-start gap-3.5 py-3 ${
								i ? "border-t border-border" : ""
							}`}
						>
							<ActivityIcon it={it} />
							<div className="min-w-0 flex-1">
								<div className="text-[14px] font-medium">
									{activityTitle(it)}
								</div>
								{it.text ? (
									<div className="mt-0.5 truncate text-[13px] text-muted-foreground">
										{it.text}
									</div>
								) : null}
							</div>
							<span className="shrink-0 text-[12.5px] text-muted-foreground">
								{timeAgo(it.timestamp)}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Current plan + usage (unchanged behaviour, real data)
// ---------------------------------------------------------------------------

function PlanUsageCard() {
	const { usage } = useUsage();
	const plan = usage?.plan || "free";
	const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
	const used = usage?.api_calls?.used ?? 0;
	const included = usage?.api_calls?.included ?? 0;
	const pct =
		included > 0 ? Math.min(Math.round((used / included) * 100), 100) : 0;

	return (
		<div className={card()}>
			<div className="grid grid-cols-1 gap-10 md:grid-cols-2">
				<div className="flex flex-col">
					<div className="flex items-center gap-2.5">
						<h3 className="text-[17px] font-semibold">{planName}</h3>
						<span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
							Current
						</span>
					</div>
					<p className="mt-3 max-w-full text-[14.5px] leading-normal text-muted-foreground sm:max-w-[380px]">
						Everything you need to publish and listen across all connected
						channels, with generous monthly limits.
					</p>
					<div className="mt-auto pt-7">
						<Button variant="outline" size="sm" asChild>
							<a href="/app/billing">Adjust Plan</a>
						</Button>
					</div>
				</div>
				<div className="flex flex-col">
					<div className="text-[15px] font-medium">
						{formatNumber(used)}{" "}
						<span className="font-normal text-muted-foreground">
							/ {included > 0 ? formatNumber(included) : "—"}
						</span>
					</div>
					<div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-200">
						<div
							className="h-full rounded-full bg-primary"
							style={{ width: `${pct}%` }}
						/>
					</div>
					<p className="mt-3.5 text-[14px] text-muted-foreground">
						API calls this period
					</p>
					<div className="mt-auto pt-7">
						<Button variant="outline" size="sm" asChild>
							<a href="/app/usage">View Usage</a>
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------

export function OverviewPage() {
	return (
		<div className="flex flex-col gap-[18px] pb-12">
			<div className="grid grid-cols-1 gap-5 md:grid-cols-2">
				<ConnectionsCard />
				<ApiKeyCard />
			</div>

			<PlanUsageCard />

			<ApiCallsCard />

			<ActivityCard />
		</div>
	);
}
