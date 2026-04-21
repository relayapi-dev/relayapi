// Action list (Plan 2 — Unit B4, Task O1).
//
// Renders an ordered list of actions. Each row shows an icon + type label +
// one-line summary, an `on_error` dropdown, and a ⋯ menu (Duplicate,
// Move up, Move down, Delete). Clicking anywhere else on the row toggles
// an inline form (only one form expanded at a time — the simpler UX; we
// can loosen that later if users ask).
//
// Reorder uses move-up / move-down buttons for v1 — matches the B3 pattern
// in the MessageComposer's BlockList. Real drag-and-drop can be layered on
// later without changing the parent contract.

import {
	ArrowDown,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	Copy,
	MoreHorizontal,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ActionForm } from "./action-form";
import {
	generateActionId,
	reorder,
	summarizeAction,
	validateAction,
	type Action,
	type OnError,
} from "./types";

interface Props {
	actions: Action[];
	onChange(next: Action[]): void;
}

export function ActionList({ actions, onChange }: Props) {
	const [expandedId, setExpandedId] = useState<string | null>(() =>
		actions[0]?.id ?? null,
	);
	const [openMenuId, setOpenMenuId] = useState<string | null>(null);

	if (actions.length === 0) {
		return (
			<div className="rounded-xl border border-dashed border-[#d9dde6] bg-[#fbfcfe] p-6 text-center">
				<p className="text-[12px] text-[#64748b]">
					No actions yet. Use{" "}
					<span className="font-semibold">+ Add action</span> below to add the
					first one.
				</p>
			</div>
		);
	}

	const updateAt = (idx: number, next: Action) => {
		const copy = actions.slice();
		copy[idx] = next;
		onChange(copy);
	};
	const removeAt = (idx: number) => {
		const next = actions.filter((_, i) => i !== idx);
		onChange(next);
		// If we just removed the expanded row, collapse.
		const removed = actions[idx];
		if (removed && removed.id === expandedId) setExpandedId(null);
	};
	const move = (from: number, to: number) => onChange(reorder(actions, from, to));
	const duplicate = (idx: number) => {
		const src = actions[idx];
		if (!src) return;
		const copy: Action = { ...src, id: generateActionId() };
		const next = actions.slice();
		next.splice(idx + 1, 0, copy);
		onChange(next);
	};
	const setOnError = (idx: number, next: OnError) => {
		const src = actions[idx];
		if (!src) return;
		updateAt(idx, { ...src, on_error: next });
	};

	return (
		<div className="space-y-2">
			{actions.map((action, idx) => {
				const expanded = action.id === expandedId;
				const problems = validateAction(action);
				const hasProblems = problems.length > 0;
				const onError: OnError = action.on_error ?? "abort";

				return (
					<div
						key={action.id}
						className={cn(
							"overflow-hidden rounded-xl border bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04)]",
							expanded
								? "border-[#c7d2fe]"
								: hasProblems
									? "border-amber-300"
									: "border-[#e6e9ef]",
						)}
					>
						{/* Header row */}
						<div className="flex items-center gap-1 px-2.5 py-2">
							<button
								type="button"
								onClick={() => setExpandedId(expanded ? null : action.id)}
								className="flex flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-[#f5f8fc]"
								aria-expanded={expanded}
							>
								{expanded ? (
									<ChevronDown className="size-3.5 text-[#64748b]" />
								) : (
									<ChevronRight className="size-3.5 text-[#64748b]" />
								)}
								<span className="rounded-md bg-[#eef4ff] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#4f46e5]">
									{idx + 1}
								</span>
								<span className="flex-1 truncate text-[12px] text-[#353a44]">
									<span className="font-medium">
										{summarizeAction(action)}
									</span>
								</span>
								{hasProblems ? (
									<span
										title={problems.map((p) => p.message).join("\n")}
										className="text-[10px] font-medium text-amber-600"
									>
										needs attention
									</span>
								) : null}
							</button>

							<select
								value={onError}
								onChange={(e) => setOnError(idx, e.target.value as OnError)}
								className="h-7 rounded-md border border-[#d9dde6] bg-white px-1 text-[11px] text-[#475569]"
								title="Action-level error behaviour"
							>
								<option value="abort">Abort</option>
								<option value="continue">Continue</option>
							</select>

							<RowMenu
								open={openMenuId === action.id}
								setOpen={(open) =>
									setOpenMenuId(open ? action.id : null)
								}
								canMoveUp={idx > 0}
								canMoveDown={idx < actions.length - 1}
								onDuplicate={() => {
									duplicate(idx);
									setOpenMenuId(null);
								}}
								onMoveUp={() => {
									move(idx, idx - 1);
									setOpenMenuId(null);
								}}
								onMoveDown={() => {
									move(idx, idx + 1);
									setOpenMenuId(null);
								}}
								onDelete={() => {
									removeAt(idx);
									setOpenMenuId(null);
								}}
							/>
						</div>

						{/* Expanded form */}
						{expanded ? (
							<div className="border-t border-[#eef2f7] bg-[#fbfcfe] p-3">
								<ActionForm
									action={action}
									onChange={(next) => updateAt(idx, next)}
								/>
							</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Row menu (⋯) — Duplicate / Move up / Move down / Delete
// ---------------------------------------------------------------------------

function RowMenu({
	open,
	setOpen,
	canMoveUp,
	canMoveDown,
	onDuplicate,
	onMoveUp,
	onMoveDown,
	onDelete,
}: {
	open: boolean;
	setOpen(open: boolean): void;
	canMoveUp: boolean;
	canMoveDown: boolean;
	onDuplicate(): void;
	onMoveUp(): void;
	onMoveDown(): void;
	onDelete(): void;
}) {
	return (
		<div className="relative">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="rounded p-1 text-[#94a3b8] hover:bg-[#f5f8fc] hover:text-[#334155]"
				aria-label="Row menu"
			>
				<MoreHorizontal className="size-3.5" />
			</button>
			{open ? (
				<div
					className="absolute right-0 z-10 mt-1 w-[160px] rounded-lg border border-[#e6e9ef] bg-white p-1 shadow-lg"
					onMouseLeave={() => setOpen(false)}
				>
					<MenuItem
						icon={<Copy className="size-3" />}
						label="Duplicate"
						onClick={onDuplicate}
					/>
					<MenuItem
						icon={<ArrowUp className="size-3" />}
						label="Move up"
						disabled={!canMoveUp}
						onClick={onMoveUp}
					/>
					<MenuItem
						icon={<ArrowDown className="size-3" />}
						label="Move down"
						disabled={!canMoveDown}
						onClick={onMoveDown}
					/>
					<div className="my-1 h-px bg-[#eef2f7]" />
					<MenuItem
						icon={<Trash2 className="size-3 text-destructive" />}
						label="Delete"
						destructive
						onClick={onDelete}
					/>
				</div>
			) : null}
		</div>
	);
}

function MenuItem({
	icon,
	label,
	onClick,
	disabled,
	destructive,
}: {
	icon: React.ReactNode;
	label: string;
	onClick(): void;
	disabled?: boolean;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px]",
				disabled
					? "cursor-not-allowed opacity-40"
					: destructive
						? "text-destructive hover:bg-destructive/10"
						: "text-[#334155] hover:bg-[#f5f8fc]",
			)}
		>
			{icon}
			{label}
		</button>
	);
}
