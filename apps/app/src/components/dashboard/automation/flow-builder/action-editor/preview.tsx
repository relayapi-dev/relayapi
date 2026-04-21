// Action preview (Plan 2 — Unit B4, Task O3).
//
// "Dry-run actions" button that posts to `/api/automations/{id}/simulate`
// via the existing proxy. Shows a step-by-step transcript of what would
// fire with resolved merge-tag values.

import { AlertCircle, CheckCircle2, Loader2, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { summarizeAction, type Action } from "./types";

interface SimulateStep {
	node_key: string;
	node_kind: string;
	entered_via_port_key: string | null;
	exited_via_port_key: string | null;
	outcome: "advance" | "wait_input" | "wait_delay" | "end" | "fail";
	payload?: unknown;
}

interface SimulateResponse {
	steps: SimulateStep[];
	ended_at_node: string | null;
	exit_reason: string;
}

interface Props {
	automationId: string;
	nodeKey: string;
	actions: Action[];
}

export function Preview({ automationId, nodeKey, actions }: Props) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<SimulateResponse | null>(null);

	const run = async () => {
		setLoading(true);
		setError(null);
		setResult(null);
		try {
			const res = await fetch(
				`/api/automations/${encodeURIComponent(automationId)}/simulate`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						start_node_key: nodeKey,
						test_context: {},
						branch_choices: {},
						execute_side_effects: false,
					}),
				},
			);
			const body = (await res.json().catch(() => null)) as
				| (SimulateResponse & { error?: { message?: string } })
				| null;
			if (!res.ok) {
				throw new Error(
					body?.error?.message ?? `Simulate failed with status ${res.status}`,
				);
			}
			setResult(body as SimulateResponse);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to dry-run actions");
		} finally {
			setLoading(false);
		}
	};

	// Filter the simulate transcript to just the steps that touched this
	// action group (its node_key). Each step's payload may include per-action
	// resolved values keyed by action id.
	const relevantSteps = (result?.steps ?? []).filter(
		(s) => s.node_key === nodeKey,
	);

	return (
		<div className="rounded-xl border border-[#e6e9ef] bg-white p-3">
			<div className="flex items-center justify-between">
				<div>
					<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
						Preview
					</div>
					<p className="mt-0.5 text-[11px] text-[#64748b]">
						Dry-run the action group — no side effects will fire.
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={run}
					disabled={loading || actions.length === 0}
					className="h-8 gap-1 rounded-lg border border-[#d9dde6] bg-white px-2 text-[11px]"
				>
					{loading ? (
						<Loader2 className="size-3 animate-spin" />
					) : (
						<Play className="size-3" />
					)}
					{loading ? "Running…" : "Dry-run actions"}
				</Button>
			</div>

			{error ? (
				<div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
					<AlertCircle className="mt-0.5 size-3" />
					<span>{error}</span>
				</div>
			) : null}

			{result ? (
				<Transcript
					result={result}
					relevantSteps={relevantSteps}
					actions={actions}
				/>
			) : null}
		</div>
	);
}

function Transcript({
	result,
	relevantSteps,
	actions,
}: {
	result: SimulateResponse;
	relevantSteps: SimulateStep[];
	actions: Action[];
}) {
	return (
		<div className="mt-3 space-y-2">
			<div className="text-[10px] font-medium uppercase tracking-wide text-[#64748b]">
				Transcript
			</div>
			<div className="space-y-2">
				{relevantSteps.length === 0 ? (
					<p className="text-[11px] text-[#64748b]">
						Simulator finished — exit reason:{" "}
						<span className="font-mono">{result.exit_reason}</span>. No step
						touched this node.
					</p>
				) : (
					relevantSteps.map((step, idx) => (
						<StepRow key={`${step.node_key}-${idx}`} step={step} actions={actions} />
					))
				)}
			</div>
			<div className="flex items-center gap-1.5 pt-1 text-[11px] text-[#64748b]">
				<CheckCircle2 className="size-3 text-emerald-600" />
				Ended at{" "}
				<span className="font-mono">{result.ended_at_node ?? "—"}</span> with
				reason{" "}
				<span className="font-mono">{result.exit_reason}</span>.
			</div>
		</div>
	);
}

function StepRow({
	step,
	actions,
}: {
	step: SimulateStep;
	actions: Action[];
}) {
	const payload = step.payload as
		| { actions?: Array<{ id: string; would_fire: boolean; resolved?: unknown; error?: string }> }
		| undefined;
	const actionResults = Array.isArray(payload?.actions)
		? payload!.actions
		: [];

	return (
		<div className="rounded-lg border border-[#eef2f7] bg-[#fbfcfe] p-2">
			<div className="flex items-center gap-2">
				<span className="rounded bg-[#eef4ff] px-1.5 py-0.5 text-[10px] font-semibold text-[#4f46e5]">
					{step.node_kind}
				</span>
				<span className="text-[11px] text-[#475569]">
					outcome:{" "}
					<span className="font-mono">{step.outcome}</span>
					{step.exited_via_port_key ? (
						<>
							{" "}
							via{" "}
							<span className="font-mono">{step.exited_via_port_key}</span>
						</>
					) : null}
				</span>
			</div>

			{actionResults.length > 0 ? (
				<ol className="mt-2 space-y-1">
					{actionResults.map((r, i) => {
						const action = actions.find((a) => a.id === r.id);
						return (
							<li
								key={r.id ?? i}
								className={cn(
									"flex items-start gap-2 rounded px-2 py-1 text-[11px]",
									r.would_fire
										? "bg-emerald-50 text-emerald-800"
										: "bg-amber-50 text-amber-800",
								)}
							>
								<span className="font-semibold">
									{r.would_fire ? "would fire" : "would abort"}
								</span>
								<span className="flex-1">
									{action ? summarizeAction(action) : r.id}
									{r.error ? (
										<span className="ml-1 text-destructive">
											— {r.error}
										</span>
									) : null}
								</span>
								{r.resolved &&
								typeof r.resolved === "object" &&
								Object.keys(r.resolved as object).length > 0 ? (
									<pre className="font-mono text-[10px] text-[#334155]">
										{truncatedJson(r.resolved)}
									</pre>
								) : null}
							</li>
						);
					})}
				</ol>
			) : (
				<p className="mt-1 text-[11px] text-[#94a3b8]">
					Simulator did not return per-action detail — use the main simulator
					panel for a deeper trace.
				</p>
			)}
		</div>
	);
}

function truncatedJson(v: unknown): string {
	const s = JSON.stringify(v);
	if (!s) return "";
	return s.length > 100 ? `${s.slice(0, 97)}…` : s;
}
