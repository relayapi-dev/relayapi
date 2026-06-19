import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUsage } from "@/hooks/use-usage";
import { formatNumber } from "@/types/dashboard";
import { PageHeader } from "@/components/dashboard/page-header";

function card(extra = "") {
	return `rounded-[12px] border border-border bg-card p-6 ${extra}`;
}

function StatCard({
	label,
	value,
	sub,
}: {
	label: string;
	value: string;
	sub?: string;
}) {
	return (
		<div className={card()}>
			<div className="text-[13px] text-muted-foreground">{label}</div>
			<div className="mt-2 text-[28px] font-semibold tracking-[-0.02em]">
				{value}
			</div>
			{sub && <div className="mt-1 text-[13px] text-muted-foreground">{sub}</div>}
		</div>
	);
}

export function UsagePage() {
	const { usage } = useUsage();

	const plan = usage?.plan || "free";
	const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
	const used = usage?.api_calls?.used ?? 0;
	const included = usage?.api_calls?.included ?? 0;
	const remaining = Math.max(included - used, 0);
	const pct =
		included > 0 ? Math.min(Math.round((used / included) * 100), 100) : 0;

	return (
		<div className="space-y-6 pb-16">
			<PageHeader
				title="Usage"
				docsHref="https://docs.relayapi.dev/"
				action={
					<Button variant="outline" size="sm" asChild>
						<a href="/app/billing">
							Manage plan <ArrowUpRight className="size-4" />
						</a>
					</Button>
				}
			/>

			<div className="grid gap-4 sm:grid-cols-3">
				<StatCard label="Plan" value={planName} sub="Current subscription" />
				<StatCard
					label="API calls used"
					value={formatNumber(used)}
					sub={`of ${included > 0 ? formatNumber(included) : "—"} included`}
				/>
				<StatCard
					label="Remaining"
					value={included > 0 ? formatNumber(remaining) : "—"}
					sub="this billing period"
				/>
			</div>

			<div className={card()}>
				<div className="flex items-baseline justify-between">
					<h3 className="text-[15px] font-medium">API calls this period</h3>
					<span className="text-[13px] text-muted-foreground">{pct}%</span>
				</div>
				<div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-200">
					<div
						className="h-full rounded-full bg-primary transition-all"
						style={{ width: `${pct}%` }}
					/>
				</div>
				<p className="mt-3 text-[13px] text-muted-foreground">
					{formatNumber(used)} of{" "}
					{included > 0 ? formatNumber(included) : "your"} included calls used.
					Need more? Upgrade your plan for higher limits and priority publishing.
				</p>
			</div>

			<div
				className={card(
					"flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between",
				)}
			>
				<div className="min-w-0">
					<div className="text-[15px] font-medium">
						Detailed usage analytics
					</div>
					<div className="text-[13px] text-muted-foreground">
						See per-channel publish and listen activity over time.
					</div>
				</div>
				<Button variant="outline" size="sm" asChild>
					<a href="/app/analytics">
						View Analytics <ArrowUpRight className="size-3.5" />
					</a>
				</Button>
			</div>
		</div>
	);
}
