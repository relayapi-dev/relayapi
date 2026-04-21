// Action group editor shell (Plan 2 — Unit B4, Phase O).
//
// Entry point for editing an `action_group` node. The panel dispatcher
// synthesises `{ key, kind: "action_group", config }` and calls us with the
// flat config; we emit a new config back whenever the user edits.
//
// Layout:
//   ┌────────────────────────────────────┐
//   │ Action list (ordered, reorderable) │
//   ├────────────────────────────────────┤
//   │ + Add action ▾ (grouped dropdown)  │
//   ├────────────────────────────────────┤
//   │ Preview (dry-run simulate)         │
//   └────────────────────────────────────┘

import { ChevronDown, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AutomationNode } from "../graph-types";
import { useAutomationCatalog } from "../use-catalog";
import { ActionList } from "./action-list";
import { Preview } from "./preview";
import {
	ACTION_CATEGORIES,
	defaultActionFor,
	FALLBACK_ACTION_CATALOG,
	type Action,
	type ActionCatalogEntry,
	type ActionCategory,
	type ActionGroupConfig,
	type ActionType,
} from "./types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
	/** The action-group node being edited (kind === "action_group"). */
	node: Pick<AutomationNode, "key" | "kind" | "config">;
	/** Called with the new `config` whenever the user edits. */
	onChange(config: ActionGroupConfig): void;
	/** Automation id — needed for the dry-run simulate endpoint. */
	automationId?: string;
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function ActionEditor({ node, onChange, automationId }: Props) {
	const cfg = (node.config ?? {}) as { actions?: Action[] };
	const actions = Array.isArray(cfg.actions) ? cfg.actions : [];

	const setActions = (next: Action[]) => onChange({ actions: next });

	const addAction = (type: ActionType) => {
		setActions([...actions, defaultActionFor(type)]);
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="rounded-xl border border-[#e6e9ef] bg-white p-3">
				<div className="mb-2 flex items-center justify-between">
					<div>
						<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
							Actions
						</div>
						<p className="mt-0.5 text-[11px] text-[#64748b]">
							Runs in order. Flip a row to{" "}
							<span className="font-medium">Continue</span> so one failure
							doesn't stop the rest.
						</p>
					</div>
					<span className="text-[11px] text-[#94a3b8]">
						{actions.length} total
					</span>
				</div>
				<ActionList actions={actions} onChange={setActions} />
				<div className="mt-2">
					<AddActionButton onAdd={addAction} />
				</div>
			</div>

			<PortsHint actions={actions} />

			{automationId ? (
				<Preview
					automationId={automationId}
					nodeKey={node.key}
					actions={actions}
				/>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Ports hint — mirrors the port derivation in `derive-ports.ts` so the user
// understands which output ports exist without opening the canvas.
// ---------------------------------------------------------------------------

function PortsHint({ actions }: { actions: Action[] }) {
	const hasAbort = actions.some(
		(a) => (a.on_error ?? "abort") === "abort",
	);
	return (
		<div className="rounded-xl border border-[#eef2f7] bg-[#fbfcfe] p-3 text-[11px] text-[#475569]">
			<div className="font-medium text-[#1f2937]">Ports on this node</div>
			<ul className="mt-1 space-y-0.5">
				<li>
					<span className="font-mono text-[11px] text-[#4f46e5]">next</span> —
					fires after all actions complete.
				</li>
				{hasAbort ? (
					<li>
						<span className="font-mono text-[11px] text-amber-600">error</span>{" "}
						— fires if any action with "Abort" set fails.
					</li>
				) : (
					<li className="text-[#94a3b8]">
						No <span className="font-mono">error</span> port — set at least one
						action to{" "}
						<span className="font-medium">Abort</span> to enable error routing.
					</li>
				)}
			</ul>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Add-action dropdown — grouped by category per spec §12.2
// ---------------------------------------------------------------------------

function AddActionButton({ onAdd }: { onAdd(type: ActionType): void }) {
	const [open, setOpen] = useState(false);
	const catalog = useAutomationCatalog();

	const entries: ActionCatalogEntry[] = useMemo(() => {
		const live = catalog.data?.action_types;
		if (Array.isArray(live) && live.length > 0) {
			return live.map((entry) => ({
				type: entry.type as ActionType,
				label: entry.label,
				category: (entry.category as ActionCategory) ?? "contact_data",
			}));
		}
		return FALLBACK_ACTION_CATALOG;
	}, [catalog.data]);

	const grouped = useMemo(() => {
		const map = new Map<ActionCategory, ActionCatalogEntry[]>();
		for (const entry of entries) {
			const arr = map.get(entry.category) ?? [];
			arr.push(entry);
			map.set(entry.category, arr);
		}
		return map;
	}, [entries]);

	return (
		<div className="relative">
			<Button
				type="button"
				variant="outline"
				onClick={() => setOpen((v) => !v)}
				className="h-9 w-full gap-1 rounded-lg border border-dashed border-[#c4d2ff] bg-[#f5f8ff] text-[12px] font-medium text-[#4f46e5] hover:bg-[#eef2ff]"
				aria-expanded={open}
			>
				<Plus className="size-3.5" />
				Add action
				<ChevronDown className="size-3 opacity-60" />
			</Button>
			{open ? (
				<div
					className="absolute z-20 mt-1 max-h-[360px] w-full overflow-auto rounded-lg border border-[#e6e9ef] bg-white p-1 shadow-lg"
					onMouseLeave={() => setOpen(false)}
				>
					{ACTION_CATEGORIES.map(({ key, label }) => {
						const rows = grouped.get(key);
						if (!rows || rows.length === 0) return null;
						return (
							<div key={key} className="mb-1 last:mb-0">
								<div className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">
									{label}
								</div>
								{rows.map((entry) => (
									<button
										key={entry.type}
										type="button"
										onClick={() => {
											onAdd(entry.type);
											setOpen(false);
										}}
										className={cn(
											"flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-[#f5f8fc]",
											entry.category === "v1_1_stubs" &&
												"text-[#64748b]",
											entry.category === "destructive" &&
												"text-destructive",
										)}
									>
										<span className="font-medium">{entry.label}</span>
										{entry.category === "v1_1_stubs" ? (
											<span className="text-[10px] text-amber-600">
												v1.1
											</span>
										) : null}
									</button>
								))}
							</div>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
