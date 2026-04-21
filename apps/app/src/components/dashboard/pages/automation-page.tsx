// Automation list page (Plan 2 — Unit B5, Task P3).
//
// Surfaces the new AutomationResponse shape:
//   - Trigger summary column (derived from per-automation entrypoints fetch)
//   - Template badge column (from `created_from_template`)
//   - 30-day run counter (lazy-fetched per row via `/insights` proxy)
//   - `created_from_template` filter dropdown
//
// [+ New automation] opens the unified CreateAutomationDialog (Task P4) —
// the dedicated `/app/automation/new` page is retired.

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
	BookOpen,
	Loader2,
	MoreHorizontal,
	Plus,
	Sparkles,
	Trash2,
	Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";
import {
	CreateAutomationDialog,
	type TemplateSlug,
} from "@/components/dashboard/automation/template-picker-dialog";
import { useAutomationCatalog } from "@/components/dashboard/automation/flow-builder/use-catalog";

const stagger = {
	hidden: {},
	visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
	hidden: { opacity: 0, y: 6 },
	visible: {
		opacity: 1,
		y: 0,
		transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const },
	},
};

// ---------------------------------------------------------------------------
// API response types (match SDK AutomationResponse)
// ---------------------------------------------------------------------------

interface AutomationRow {
	id: string;
	name: string;
	status: "draft" | "active" | "paused" | "archived";
	channel: string;
	created_from_template: string | null;
	total_enrolled: number;
	total_completed: number;
	created_at: string;
}

interface ApiEntrypoint {
	id: string;
	kind: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(status: AutomationRow["status"]) {
	const map: Record<string, { label: string; classes: string }> = {
		draft: { label: "Draft", classes: "text-neutral-400 bg-neutral-400/10" },
		active: { label: "Active", classes: "text-emerald-500 bg-emerald-500/10" },
		paused: { label: "Paused", classes: "text-amber-500 bg-amber-500/10" },
		archived: {
			label: "Archived",
			classes: "text-neutral-500 bg-neutral-500/10",
		},
	};
	const cfg = map[status] ?? map.draft!;
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
				cfg.classes,
			)}
		>
			{cfg.label}
		</span>
	);
}

function templateBadge(template: string | null) {
	if (!template) return <span className="text-xs text-muted-foreground/60">—</span>;
	// Pick one of a few stable colours based on a simple hash.
	const palette = [
		"bg-blue-500/10 text-blue-500",
		"bg-purple-500/10 text-purple-500",
		"bg-emerald-500/10 text-emerald-500",
		"bg-rose-500/10 text-rose-500",
		"bg-amber-500/10 text-amber-500",
	];
	const idx =
		template.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0) %
		palette.length;
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
				palette[idx],
			)}
		>
			{template}
		</span>
	);
}

function formatDate(dateStr: string) {
	const d = new Date(dateStr);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function humanizeKind(kind: string): string {
	return kind
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

// ---------------------------------------------------------------------------
// Per-row: trigger summary + 30d run counter
//
// These are N+1 fetches — we accept that in v1 to keep the list endpoint
// simple. Each row fires its own `useEffect` and caches the response locally;
// the paginated list hook refreshes cleared cache on filter change.
// ---------------------------------------------------------------------------

function useTriggerSummary(automationId: string): string {
	const [summary, setSummary] = useState<string>("…");
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(
					`/api/automations/${automationId}/entrypoints`,
					{ credentials: "same-origin" },
				);
				if (!res.ok) {
					if (!cancelled) setSummary("—");
					return;
				}
				const json = (await res.json()) as { data: ApiEntrypoint[] };
				if (cancelled) return;
				const entries = json.data ?? [];
				if (entries.length === 0) {
					setSummary("No entrypoints");
				} else if (entries.length === 1) {
					setSummary(humanizeKind(entries[0]!.kind));
				} else {
					const uniqueKinds = new Set(entries.map((e) => e.kind));
					if (uniqueKinds.size === 1) {
						setSummary(`${humanizeKind(entries[0]!.kind)} ×${entries.length}`);
					} else {
						setSummary(`${entries.length} entrypoints`);
					}
				}
			} catch {
				if (!cancelled) setSummary("—");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [automationId]);
	return summary;
}

function useRunCount30d(automationId: string): number | null {
	const [runs, setRuns] = useState<number | null>(null);
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(
					`/api/automations/${automationId}/insights?period=30d`,
					{ credentials: "same-origin" },
				);
				if (!res.ok) {
					if (!cancelled) setRuns(0);
					return;
				}
				const json = (await res.json()) as {
					totals?: { enrolled?: number };
				};
				if (cancelled) return;
				setRuns(json?.totals?.enrolled ?? 0);
			} catch {
				if (!cancelled) setRuns(0);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [automationId]);
	return runs;
}

function AutomationRowCells({ a }: { a: AutomationRow }) {
	const triggers = useTriggerSummary(a.id);
	const runs = useRunCount30d(a.id);
	return (
		<>
			<td className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">
				{triggers}
			</td>
			<td className="hidden px-4 py-3 text-xs md:table-cell">
				{templateBadge(a.created_from_template)}
			</td>
			<td className="hidden px-4 py-3 text-right text-xs text-muted-foreground md:table-cell">
				{runs === null ? "…" : runs.toLocaleString()}
			</td>
		</>
	);
}

// ---------------------------------------------------------------------------
// Quick-start cards
// ---------------------------------------------------------------------------

const QUICK_STARTS: Array<{
	slug: TemplateSlug;
	title: string;
	description: string;
}> = [
	{
		slug: "comment_to_dm",
		title: "Comment to DM",
		description: "Reply to comments with a DM — the Manychat classic.",
	},
	{
		slug: "story_leads",
		title: "Story leads",
		description: "Capture leads when people reply to your IG story.",
	},
	{
		slug: "follower_growth",
		title: "Follower growth",
		description: "Run a contest that grows followers via comments.",
	},
	{
		slug: "follow_to_dm",
		title: "Follow to DM",
		description: "DM new followers automatically.",
	},
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AutomationPage() {
	const catalog = useAutomationCatalog();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [initialTemplate, setInitialTemplate] = useState<TemplateSlug | null>(
		null,
	);

	// Auto-open the dialog when the page lands with `?new=1` (legacy
	// /app/automation/new route redirects here).
	useEffect(() => {
		if (typeof window === "undefined") return;
		const params = new URLSearchParams(window.location.search);
		if (params.get("new") === "1") {
			setDialogOpen(true);
			// Strip the query so reloads don't re-open.
			const url = new URL(window.location.href);
			url.searchParams.delete("new");
			window.history.replaceState({}, "", url.toString());
		}
	}, []);
	const [deleteTarget, setDeleteTarget] = useState<AutomationRow | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [templateFilter, setTemplateFilter] = useState<string>("");

	const query = useMemo<Record<string, string | undefined>>(() => {
		return {
			created_from_template: templateFilter || undefined,
		};
	}, [templateFilter]);

	const {
		data: automations,
		loading,
		error,
		hasMore,
		loadMore,
		loadingMore,
		refetch,
		setData,
	} = usePaginatedApi<AutomationRow>("automations", { query });

	const templateOptions = useMemo(() => {
		if (!catalog.data) return [];
		return catalog.data.template_kinds ?? [];
	}, [catalog.data]);

	const openDialog = (template: TemplateSlug | null = null) => {
		setInitialTemplate(template);
		setDialogOpen(true);
	};

	const handleDelete = async () => {
		if (!deleteTarget) return;
		setDeleting(true);
		setDeleteError(null);
		try {
			const res = await fetch(`/api/automations/${deleteTarget.id}`, {
				method: "DELETE",
			});
			if (res.ok || res.status === 204) {
				setData((prev) => prev.filter((a) => a.id !== deleteTarget.id));
				setDeleteTarget(null);
			} else {
				const body = await res.json().catch(() => null);
				setDeleteError(
					body?.error?.message || body?.message || `Error ${res.status}`,
				);
			}
		} catch {
			setDeleteError("Network connection lost.");
		} finally {
			setDeleting(false);
		}
	};

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<h1 className="text-lg font-medium">Automations</h1>
					<a
						href="https://docs.relayapi.dev/guides/automations"
						target="_blank"
						rel="noopener noreferrer"
						className="text-muted-foreground hover:text-foreground transition-colors"
					>
						<BookOpen className="size-3.5" />
					</a>
				</div>
				<div className="flex items-center gap-1.5">
					<Button
						size="sm"
						className="h-7 gap-1.5 text-xs"
						onClick={() => openDialog()}
					>
						<Plus className="size-3.5" />
						New automation
					</Button>
				</div>
			</div>

			{/* Filter bar */}
			<div className="flex items-center gap-2">
				<label className="text-xs text-muted-foreground">Template:</label>
				<select
					value={templateFilter}
					onChange={(e) => setTemplateFilter(e.target.value)}
					className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
				>
					<option value="">All</option>
					{templateOptions.map((t) => (
						<option key={t} value={t}>
							{t}
						</option>
					))}
				</select>
				{templateFilter && (
					<button
						type="button"
						onClick={() => setTemplateFilter("")}
						className="text-[11px] text-muted-foreground hover:text-foreground"
					>
						Clear
					</button>
				)}
			</div>

			{/* Quick starts */}
			<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
				{QUICK_STARTS.map((item) => (
					<button
						key={item.slug}
						type="button"
						onClick={() => openDialog(item.slug)}
						className="rounded-xl border border-border bg-card/50 p-4 text-left transition-colors hover:border-foreground/20 hover:bg-accent/20"
					>
						<div className="flex items-start justify-between gap-3">
							<div className="rounded-lg bg-accent/40 p-2">
								<Sparkles className="size-4 text-foreground" />
							</div>
							<span className="rounded-full bg-accent/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
								Quick start
							</span>
						</div>
						<div className="mt-3 text-sm font-medium text-foreground">
							{item.title}
						</div>
						<p className="mt-1 text-xs leading-5 text-muted-foreground">
							{item.description}
						</p>
					</button>
				))}
			</div>

			{error && (
				<div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
					{error}
				</div>
			)}

			{loading ? (
				<div className="flex items-center justify-center py-20">
					<Loader2 className="size-5 animate-spin text-muted-foreground" />
				</div>
			) : automations.length === 0 ? (
				<div className="rounded-md border border-dashed border-border p-12 text-center">
					<Workflow className="mx-auto mb-2 size-8 text-muted-foreground/40" />
					<p className="text-sm text-muted-foreground">No automations yet</p>
					<p className="mt-1 text-xs text-muted-foreground">
						Start from a template or build from scratch
					</p>
					<div className="mt-4 flex items-center justify-center gap-2">
						<Button
							size="sm"
							className="h-7 gap-1.5 text-xs"
							onClick={() => openDialog()}
						>
							<Plus className="size-3.5" />
							New automation
						</Button>
					</div>
				</div>
			) : (
				<>
					<motion.div
						className="overflow-hidden rounded-md border border-border"
						variants={stagger}
						initial="hidden"
						animate="visible"
					>
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border bg-accent/10 text-xs font-medium text-muted-foreground">
									<th className="px-4 py-2.5 text-left">Name</th>
									<th className="hidden px-4 py-2.5 text-left md:table-cell">
										Channel
									</th>
									<th className="hidden px-4 py-2.5 text-left lg:table-cell">
										Trigger
									</th>
									<th className="hidden px-4 py-2.5 text-left md:table-cell">
										Template
									</th>
									<th className="px-4 py-2.5 text-left">Status</th>
									<th className="hidden px-4 py-2.5 text-right md:table-cell">
										30d runs
									</th>
									<th className="hidden px-4 py-2.5 text-right sm:table-cell">
										Created
									</th>
									<th className="w-8 px-4 py-2.5" />
								</tr>
							</thead>
							<tbody>
								{automations.map((a, i) => (
									<motion.tr
										key={a.id}
										variants={fadeUp}
										onClick={() => {
											window.location.href = `/app/automation/${a.id}`;
										}}
										className={cn(
											"cursor-pointer transition-colors hover:bg-accent/30",
											i !== automations.length - 1 && "border-b border-border",
										)}
									>
										<td className="px-4 py-3 text-[13px] font-medium">
											{a.name}
										</td>
										<td className="hidden px-4 py-3 text-xs capitalize text-muted-foreground md:table-cell">
											{a.channel}
										</td>
										<AutomationRowCells a={a} />
										<td className="px-4 py-3">{statusBadge(a.status)}</td>
										<td className="hidden px-4 py-3 text-right text-xs text-muted-foreground sm:table-cell">
											{formatDate(a.created_at)}
										</td>
										<td
											className="px-2 py-3 text-right"
											onClick={(e) => e.stopPropagation()}
										>
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<button
														type="button"
														className="rounded-md p-1.5 transition-colors hover:bg-accent/50"
														aria-label="Automation actions"
													>
														<MoreHorizontal className="size-4 text-muted-foreground" />
													</button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end" className="w-36">
													<DropdownMenuItem
														className="text-destructive focus:text-destructive"
														onClick={() => {
															setDeleteError(null);
															setDeleteTarget(a);
														}}
													>
														<Trash2 className="mr-2 size-3.5" />
														Delete
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</td>
									</motion.tr>
								))}
							</tbody>
						</table>
					</motion.div>
					<LoadMore
						hasMore={hasMore}
						loading={loadingMore}
						onLoadMore={loadMore}
						count={automations.length}
					/>
				</>
			)}

			<CreateAutomationDialog
				open={dialogOpen}
				onOpenChange={(open) => {
					setDialogOpen(open);
					if (!open) setInitialTemplate(null);
				}}
				onCreated={refetch}
				initialTemplate={initialTemplate}
			/>

			<Dialog
				open={!!deleteTarget}
				onOpenChange={(open) => {
					if (!open) {
						setDeleteTarget(null);
						setDeleteError(null);
					}
				}}
			>
				<DialogContent showCloseButton={false} className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle className="text-base">Delete automation</DialogTitle>
						<DialogDescription>
							Are you sure you want to delete{" "}
							<span className="font-medium text-foreground">
								{deleteTarget?.name || "this automation"}
							</span>
							? This action cannot be undone.
						</DialogDescription>
					</DialogHeader>
					{deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline" size="sm">
								Cancel
							</Button>
						</DialogClose>
						<Button
							variant="destructive"
							size="sm"
							disabled={deleting}
							onClick={handleDelete}
						>
							{deleting ? <Loader2 className="size-3.5 animate-spin" /> : "Delete"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
