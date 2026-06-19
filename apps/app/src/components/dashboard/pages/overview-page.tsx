import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/use-api";
import { useUsage } from "@/hooks/use-usage";
import { formatNumber } from "@/types/dashboard";
import { platformLabels } from "@/lib/platform-maps";
import { Segmented } from "../segmented";

// ---- Heatmap (52 weeks x 7 days). Deterministic placeholder series until a
// daily API-call timeseries endpoint is wired in. Reference: Overview.jsx. ----
const HEAT_COLORS = ["var(--muted)", "#9be9a8", "#40c463", "#30a14e", "#216e39"];
const MONTH_LABELS = ["A", "M", "J", "J", "A", "S", "O", "N", "D", "J", "F", "M"];

function buildHeat(): number[][] {
	let seed = 7;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const weeks: number[][] = [];
	for (let w = 0; w < 52; w++) {
		const days: number[] = [];
		for (let d = 0; d < 7; d++) {
			const p = rnd() + (w > 44 ? 0.25 : 0);
			let lvl = 0;
			if (p > 0.94) lvl = 4;
			else if (p > 0.88) lvl = 3;
			else if (p > 0.8) lvl = 2;
			else if (p > 0.68) lvl = 1;
			days.push(lvl);
		}
		weeks.push(days);
	}
	const lastWeek = weeks[weeks.length - 1];
	if (lastWeek) lastWeek[1] = 4;
	return weeks;
}

function Heatmap() {
	const heat = useMemo(buildHeat, []);
	return (
		<div className="mt-[22px] overflow-x-auto">
			<div className="mb-1.5 flex pl-[22px]">
				{MONTH_LABELS.map((mo, i) => (
					<div
						key={`${mo}-${i}`}
						className="flex-1 text-[12px] text-muted-foreground"
					>
						{mo}
					</div>
				))}
			</div>
			<div className="flex gap-1.5">
				<div className="flex w-4 flex-col justify-between py-px">
					{["", "M", "", "W", "", "F", ""].map((d, i) => (
						<div
							key={`${d}-${i}`}
							className="h-[13px] text-[11px] leading-[13px] text-muted-foreground"
						>
							{d}
						</div>
					))}
				</div>
				<div className="flex flex-1 gap-[3px]">
					{heat.map((week, wi) => (
						<div key={wi} className="flex flex-1 flex-col gap-[3px]">
							{week.map((lvl, di) => (
								<div
									key={di}
									className="aspect-square w-full rounded-[2.5px]"
									style={{ background: HEAT_COLORS[lvl] }}
								/>
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

function card(extra = "") {
	return `rounded-[12px] border border-border bg-card p-6 md:p-[26px] ${extra}`;
}

function PlanCard({
	name,
	price,
	desc,
	cta,
}: {
	name: string;
	price: string;
	desc: string;
	cta: string;
}) {
	return (
		<div className={card("flex flex-col")}>
			<div className="flex items-baseline gap-2.5">
				<h3 className="text-[17px] font-semibold">{name}</h3>
				<span className="text-[14px] text-muted-foreground">{price}/mo.</span>
			</div>
			<p className="mt-3 text-[14.5px] leading-normal text-muted-foreground">
				{desc}
			</p>
			<div className="mt-auto pt-[22px]">
				<Button asChild>
					<a href="/app/billing">{cta}</a>
				</Button>
			</div>
		</div>
	);
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

interface IntegrationAccount {
	id: string;
	display_name: string | null;
	username: string | null;
	platform: string;
}

export function OverviewPage() {
	const { usage } = useUsage();
	const [series, setSeries] = useState<"all" | "publish" | "listen">("all");

	const plan = usage?.plan || "free";
	const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
	const used = usage?.api_calls?.used ?? 0;
	const included = usage?.api_calls?.included ?? 0;
	const pct =
		included > 0 ? Math.min(Math.round((used / included) * 100), 100) : 0;

	const { data: accountsData } = useApi<{ data: IntegrationAccount[] }>(
		"accounts?limit=4",
	);
	const accounts = accountsData?.data ?? [];

	return (
		<div className="flex flex-col gap-[18px] pb-12">
			{/* Upgrade plan cards */}
			<div className="grid gap-5 md:grid-cols-2">
				<PlanCard
					name="Scale"
					price="$99"
					desc="Get 5× the monthly API calls, higher rate limits, and priority publishing across every channel."
					cta="Upgrade to Scale"
				/>
				<PlanCard
					name="Enterprise"
					price="$499"
					desc="Maximum throughput with unlimited connections, SSO, audit logs, and a dedicated SLA."
					cta="Upgrade to Enterprise"
				/>
			</div>

			{/* Current plan + usage */}
			<div className={card()}>
				<div className="grid gap-10 md:grid-cols-2">
					<div className="flex flex-col">
						<div className="flex items-center gap-2.5">
							<h3 className="text-[17px] font-semibold">{planName}</h3>
							<span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
								Current
							</span>
						</div>
						<p className="mt-3 max-w-[380px] text-[14.5px] leading-normal text-muted-foreground">
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

			{/* API calls heatmap */}
			<div className={card()}>
				<div className="flex items-start justify-between gap-4">
					<div>
						<div className="text-[14px] text-muted-foreground">API Calls</div>
						<div className="mt-1 text-[32px] font-semibold tracking-[-0.02em]">
							{formatNumber(used)}
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

				<Heatmap />

				<div className="mt-7 grid grid-cols-2 gap-4 md:grid-cols-4">
					<Stat label="Most Active Month" value="March" />
					<Stat label="Most Active Day" value="Mar 24, 2026" />
					<Stat label="Longest Streak" value="14d" />
					<Stat label="Current Streak" value="12d" />
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

			{/* Integrations */}
			<div className="overflow-hidden rounded-[12px] border border-border bg-card">
				{accounts.length === 0 ? (
					<div className="flex items-center justify-between gap-4 px-6 py-[18px]">
						<div className="min-w-0">
							<div className="text-[15px] font-medium">Connect an account</div>
							<div className="truncate text-[14px] text-muted-foreground">
								Link a social channel to start publishing and listening.
							</div>
						</div>
						<Button variant="outline" size="sm" asChild>
							<a href="/app/connections">
								Connect <ArrowUpRight className="size-3.5" />
							</a>
						</Button>
					</div>
				) : (
					accounts.map((acc, i) => (
						<div
							key={acc.id}
							className={`flex items-center gap-3.5 px-6 py-[18px] ${
								i ? "border-t border-border" : ""
							}`}
						>
							<div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-[13px] font-semibold text-muted-foreground">
								{(acc.display_name || acc.username || acc.platform)
									.charAt(0)
									.toUpperCase()}
							</div>
							<div className="min-w-0 flex-1">
								<div className="text-[15px] font-medium">
									{acc.display_name || acc.username || "Account"}
								</div>
								<div className="truncate text-[14px] text-muted-foreground">
									{platformLabels[acc.platform?.toLowerCase()] || acc.platform}
									{acc.username ? ` · @${acc.username}` : ""}
								</div>
							</div>
							<Button variant="outline" size="sm" asChild>
								<a href="/app/connections">
									Manage <ChevronDown className="size-3.5" />
								</a>
							</Button>
						</div>
					))
				)}
			</div>
		</div>
	);
}
