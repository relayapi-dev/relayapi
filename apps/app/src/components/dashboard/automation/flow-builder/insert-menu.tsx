// Insert menu (Plan 2 — Unit B2, Task L4).
//
// Command-palette-style popover for inserting a new node onto the canvas. It
// can be opened three ways:
//   1. Dragging an output port into empty space (React Flow `onConnectEnd`).
//      In that case `sourcePort` is set and selecting a kind creates the new
//      node *and* a connecting edge in one atomic `graphStore.addNode` call.
//   2. Keyboard: `Cmd+K` or `/` while a node is selected — opens at viewport
//      centre.
//   3. Toolbar "+" button (optional).
//
// The menu groups kinds by catalog category (Content / Logic / Actions /
// Flow). Each row shows the label, a brief description, and — when the
// catalog marks the node unsupported on this channel — a small warning.
//
// Recent picks live in `localStorage` (top 5, most-recent-first) and are
// pinned above the categorised list.

import { useEffect, useMemo, useRef, useState } from "react";
import type {
	AutomationCatalog,
	CatalogNodeKind,
} from "./use-catalog";
import { cn } from "@/lib/utils";

const RECENT_STORAGE_KEY = "relayapi:automation:insert-menu:recent:v1";
const RECENT_LIMIT = 5;

export interface InsertMenuProps {
	open: boolean;
	/** Screen-coordinate position of the menu's top-left corner. */
	position: { x: number; y: number };
	/** Channel of the automation; used for capability filtering/warnings. */
	channel: string;
	catalog: AutomationCatalog | undefined;
	/** When set, the selected kind will be inserted AND connected to this port. */
	sourcePort?: { nodeKey: string; portKey: string };
	onClose(): void;
	onInsert(
		kind: string,
		position: { x: number; y: number },
		connect?: { sourceNodeKey: string; sourcePortKey: string },
	): void;
	/** Flow-coordinate position where the new node should be placed. */
	targetPosition: { x: number; y: number };
}

// ---------------------------------------------------------------------------
// Category grouping
// ---------------------------------------------------------------------------

const CATEGORY_ORDER = ["content", "logic", "actions", "flow"] as const;

const CATEGORY_LABEL: Record<string, string> = {
	content: "Content",
	logic: "Logic",
	actions: "Actions",
	flow: "Flow",
};

// ---------------------------------------------------------------------------
// Recent storage
// ---------------------------------------------------------------------------

function readRecent(): string[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((v): v is string => typeof v === "string").slice(0, RECENT_LIMIT)
			: [];
	} catch {
		return [];
	}
}

function writeRecent(kinds: string[]) {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(
			RECENT_STORAGE_KEY,
			JSON.stringify(kinds.slice(0, RECENT_LIMIT)),
		);
	} catch {
		// ignore quota / private-mode errors
	}
}

function pushRecent(kind: string): string[] {
	const current = readRecent().filter((k) => k !== kind);
	const next = [kind, ...current].slice(0, RECENT_LIMIT);
	writeRecent(next);
	return next;
}

// ---------------------------------------------------------------------------
// Filtering / search
// ---------------------------------------------------------------------------

export function filterKinds(
	kinds: CatalogNodeKind[],
	query: string,
): CatalogNodeKind[] {
	const q = query.trim().toLowerCase();
	if (!q) return kinds;
	return kinds.filter((k) => {
		const hay = `${k.label} ${k.category} ${k.description ?? ""} ${k.kind}`.toLowerCase();
		return hay.includes(q);
	});
}

// ---------------------------------------------------------------------------
// Channel capability check
// ---------------------------------------------------------------------------

function isSupported(
	catalog: AutomationCatalog | undefined,
	channel: string,
	kind: string,
): boolean {
	if (!catalog || !channel) return true;
	const caps = catalog.channel_capabilities?.[channel];
	if (!caps) return true;
	// Convention: a kind is unsupported if `capabilities[channel][kind]` is
	// explicitly `false`. Missing keys are treated as supported.
	return caps[kind] !== false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Row {
	kind: CatalogNodeKind;
	section: "recent" | string; // category key
	supported: boolean;
}

export function InsertMenu({
	open,
	position,
	channel,
	catalog,
	sourcePort,
	onClose,
	onInsert,
	targetPosition,
}: InsertMenuProps) {
	const [query, setQuery] = useState("");
	const [highlightIndex, setHighlightIndex] = useState(0);
	const [recent, setRecent] = useState<string[]>(() => readRecent());
	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	const allKinds = useMemo(() => catalog?.node_kinds ?? [], [catalog]);

	// Build ordered row list: recent (top), then each category in order.
	const rows = useMemo<Row[]>(() => {
		const filtered = filterKinds(allKinds, query);
		const byKind = new Map(filtered.map((k) => [k.kind, k]));
		const result: Row[] = [];

		// Recent section — only if no query (searching takes over).
		if (!query.trim()) {
			for (const kind of recent) {
				const entry = byKind.get(kind);
				if (entry) {
					result.push({
						kind: entry,
						section: "recent",
						supported: isSupported(catalog, channel, entry.kind),
					});
				}
			}
		}

		const usedKinds = new Set(result.map((r) => r.kind.kind));
		for (const cat of CATEGORY_ORDER) {
			for (const kind of filtered) {
				if (kind.category !== cat) continue;
				if (usedKinds.has(kind.kind)) continue;
				result.push({
					kind,
					section: cat,
					supported: isSupported(catalog, channel, kind.kind),
				});
			}
		}
		// Catch-all for kinds whose category isn't in CATEGORY_ORDER.
		const known = new Set<string>(CATEGORY_ORDER);
		for (const kind of filtered) {
			if (usedKinds.has(kind.kind)) continue;
			if (known.has(kind.category)) continue;
			result.push({
				kind,
				section: kind.category,
				supported: isSupported(catalog, channel, kind.kind),
			});
			usedKinds.add(kind.kind);
		}
		return result;
	}, [allKinds, catalog, channel, query, recent]);

	// Reset highlight when the row set changes.
	useEffect(() => {
		setHighlightIndex((prev) =>
			rows.length === 0 ? 0 : Math.min(prev, rows.length - 1),
		);
	}, [rows.length]);

	// Focus search on open, reset state on close.
	useEffect(() => {
		if (open) {
			setQuery("");
			setHighlightIndex(0);
			setRecent(readRecent());
			// Defer focus to the end of the render tick so the input is in the DOM.
			const h = requestAnimationFrame(() => inputRef.current?.focus());
			return () => cancelAnimationFrame(h);
		}
	}, [open]);

	// Keep the highlighted row scrolled into view.
	useEffect(() => {
		if (!listRef.current) return;
		const el = listRef.current.querySelector<HTMLElement>(
			`[data-row-index="${highlightIndex}"]`,
		);
		el?.scrollIntoView({ block: "nearest" });
	}, [highlightIndex]);

	if (!open) return null;

	const commit = (row: Row) => {
		const next = pushRecent(row.kind.kind);
		setRecent(next);
		onInsert(
			row.kind.kind,
			targetPosition,
			sourcePort
				? {
						sourceNodeKey: sourcePort.nodeKey,
						sourcePortKey: sourcePort.portKey,
					}
				: undefined,
		);
		onClose();
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setHighlightIndex((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setHighlightIndex((i) => Math.max(i - 1, 0));
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const row = rows[highlightIndex];
			if (row) commit(row);
		}
	};

	// Group rows by section for rendering.
	const grouped = new Map<string, Row[]>();
	for (const row of rows) {
		const existing = grouped.get(row.section) ?? [];
		existing.push(row);
		grouped.set(row.section, existing);
	}

	const sectionOrder: string[] = [];
	if (grouped.has("recent")) sectionOrder.push("recent");
	for (const cat of CATEGORY_ORDER) {
		if (grouped.has(cat)) sectionOrder.push(cat);
	}
	for (const key of grouped.keys()) {
		if (!sectionOrder.includes(key)) sectionOrder.push(key);
	}

	let runningIndex = -1;

	return (
		<div
			className="absolute z-40 w-[320px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_18px_40px_rgba(15,23,42,0.18)]"
			style={{
				left: Math.max(8, position.x),
				top: Math.max(8, position.y),
			}}
			onKeyDown={handleKeyDown}
			role="dialog"
			aria-label="Insert node"
		>
			<div className="border-b border-slate-200 p-2">
				<input
					ref={inputRef}
					type="text"
					placeholder="Search nodes…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[13px] outline-none focus:border-[#4680ff] focus:ring-1 focus:ring-[#4680ff]/20"
					data-testid="insert-menu-search"
				/>
			</div>
			<div
				ref={listRef}
				className="max-h-[360px] overflow-y-auto p-1.5"
				data-testid="insert-menu-list"
			>
				{rows.length === 0 ? (
					<div className="px-3 py-6 text-center text-[12px] text-slate-500">
						No matching nodes
					</div>
				) : (
					sectionOrder.map((section) => {
						const sectionRows = grouped.get(section) ?? [];
						if (sectionRows.length === 0) return null;
						const header =
							section === "recent"
								? "Recent"
								: (CATEGORY_LABEL[section] ?? section);
						return (
							<div key={section} className="mb-1.5 last:mb-0">
								<div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
									{header}
								</div>
								<div className="space-y-0.5">
									{sectionRows.map((row) => {
										runningIndex += 1;
										const index = runningIndex;
										const selected = index === highlightIndex;
										return (
											<button
												key={`${section}:${row.kind.kind}`}
												type="button"
												data-row-index={index}
												onMouseEnter={() => setHighlightIndex(index)}
												onClick={() => commit(row)}
												className={cn(
													"flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left",
													selected
														? "bg-[#eef3ff]"
														: "hover:bg-slate-50",
												)}
											>
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-2">
														<span className="text-[13px] font-medium text-slate-900">
															{row.kind.label}
														</span>
														{!row.supported ? (
															<span className="rounded-full bg-[#fff4de] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#a55b0d]">
																Unsupported
															</span>
														) : null}
													</div>
													{row.kind.description ? (
														<div className="mt-0.5 truncate text-[11px] text-slate-500">
															{row.kind.description}
														</div>
													) : null}
												</div>
											</button>
										);
									})}
								</div>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
