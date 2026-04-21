// Inbox automation badge (Plan 3 — Unit C4, Task V1).
//
// Renders a compact pill in the conversation header when the current
// contact has at least one active automation run. The badge shows the
// automation name and the contact's current step. Clicking it jumps to
// the automation detail page's Runs tab with the run pre-selected.
//
// Data source: `/api/contacts/{id}/active-automation-runs` — a dashboard
// proxy that fans out over all active automations for the org and
// collects runs for this contact. See the proxy for the rationale.

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	formatStepLabel,
	formatStepPosition,
	pickPrimaryRun,
	type AutomationNode,
	type ProxyAutomation,
	type ProxyRun,
} from "./automation-badge-helpers";

// Re-export helpers so callers that imported from `./automation-badge`
// keep working.
export {
	formatStepLabel,
	formatStepPosition,
	pickPrimaryRun,
} from "./automation-badge-helpers";
export type {
	AutomationNode,
	ProxyAutomation,
	ProxyRun,
} from "./automation-badge-helpers";

// ---------------------------------------------------------------------------
// Types — match the proxy response
// ---------------------------------------------------------------------------

interface ProxyResponse {
	runs: ProxyRun[];
	automations: ProxyAutomation[];
}

interface AutomationDetailForStep {
	id: string;
	graph?: { nodes?: AutomationNode[] } | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
	contactId: string;
	channel: string;
	/**
	 * Optional — when provided, clicking the badge routes here instead of
	 * the default `/app/automation/{id}?tab=runs&run_id=X`.
	 */
	onOpenRun?: (args: { automationId: string; runId: string }) => void;
}

export function AutomationBadge({ contactId, channel: _channel, onOpenRun }: Props) {
	const [response, setResponse] = useState<ProxyResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [detail, setDetail] = useState<AutomationDetailForStep | null>(null);

	useEffect(() => {
		if (!contactId) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		setResponse(null);
		setDetail(null);

		(async () => {
			try {
				const res = await fetch(
					`/api/contacts/${encodeURIComponent(contactId)}/active-automation-runs`,
					{ signal: AbortSignal.timeout(15_000) },
				);
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as
						| { error?: { message?: string } }
						| null;
					throw new Error(body?.error?.message ?? `Error ${res.status}`);
				}
				const json = (await res.json()) as ProxyResponse;
				if (!cancelled) setResponse(json);
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : "Network error");
				}
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [contactId]);

	const primary = useMemo(() => {
		if (!response) return null;
		return pickPrimaryRun(response.runs, response.automations);
	}, [response]);

	// Once we've picked a run, lazily fetch the automation detail to get
	// node titles for the "at <step>" label. We don't block the badge on
	// it — we render immediately with the best label we have.
	useEffect(() => {
		if (!primary) {
			setDetail(null);
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(
					`/api/automations/${encodeURIComponent(primary.automation.id)}`,
					{ signal: AbortSignal.timeout(15_000) },
				);
				if (!res.ok) return;
				const json = (await res.json()) as AutomationDetailForStep;
				if (!cancelled) setDetail(json);
			} catch {
				// Node titles are best-effort; silent failure is fine.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [primary]);

	if (loading && !primary) {
		return (
			<div className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-400">
				<Loader2 className="size-3 animate-spin" />
				<span>Checking automations</span>
			</div>
		);
	}
	if (error || !primary) {
		return null;
	}

	const { run, automation } = primary;
	const nodes = detail?.graph?.nodes;
	const stepLabel = formatStepLabel(run, nodes);
	const position = formatStepPosition(run.current_node_key, nodes);

	const href = `/app/automation/${encodeURIComponent(automation.id)}?tab=runs&run_id=${encodeURIComponent(run.id)}`;

	const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
		if (onOpenRun) {
			event.preventDefault();
			onOpenRun({ automationId: automation.id, runId: run.id });
		}
	};

	return (
		<a
			href={href}
			onClick={handleClick}
			className={cn(
				"inline-flex max-w-[20rem] items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100",
			)}
			title={`${automation.name} — ${stepLabel}${position ? ` (step ${position.index}/${position.total})` : ""}`}
		>
			<Zap className="size-3.5 shrink-0" />
			<span className="truncate">{automation.name}</span>
			<span className="shrink-0 text-amber-700/80">·</span>
			<span className="truncate text-amber-700">
				{position ? `step ${position.index}/${position.total}` : `at ${stepLabel}`}
			</span>
			<ChevronRight className="size-3 shrink-0 opacity-70" />
		</a>
	);
}

// (Tests import helpers directly from ./automation-badge-helpers.)
