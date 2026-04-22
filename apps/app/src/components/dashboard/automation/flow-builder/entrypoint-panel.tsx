// Entrypoint panel (Plan 2 — Unit B5, Task P1).
//
// Left-side panel on the automation detail page. Lists the automation's
// entrypoints and bindings, lets the user pick an entrypoint to edit inline,
// and exposes a `+ Add` dropdown filtered to the entrypoint kinds supported
// on the automation's channel.
//
// Data flow:
//   - Entrypoints: `GET /api/automations/{id}/entrypoints` via the Astro proxy
//     (which calls `client.automationEntrypoints.list(id)`).
//   - Bindings: `GET /api/automation-bindings?automation_id={id}` via the
//     Astro proxy (which calls `client.automationBindings.list(...)`).
//   - Catalog: the `useAutomationCatalog()` hook (already cached).
//
// Binding rows are informational in this unit — full binding CRUD is Plan 3's
// scope. We link the user out to `/app/connections/{social_account_id}`
// where the per-account binding UI will live.

import { useCallback, useMemo, useState } from "react";
import {
	AtSign,
	Bell,
	Bot,
	Calendar,
	ChevronLeft,
	ChevronRight,
	CornerUpLeft,
	Globe,
	Hash,
	KeyRound,
	Loader2,
	MessageCircle,
	MousePointerClick,
	Plus,
	Rss,
	Share2,
	Sparkles,
	UserPlus,
	X,
	Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useApi, useMutation } from "@/hooks/use-api";
import { useAutomationCatalog } from "./use-catalog";
import { FilterGroupEditor, type FilterGroup } from "./filter-group-editor";
import { INPUT_CLS } from "./field-styles";

// ---------------------------------------------------------------------------
// Types (align with SDK's AutomationEntrypointResponse + AutomationBindingResponse)
// ---------------------------------------------------------------------------

interface ApiEntrypoint {
	id: string;
	automation_id: string;
	channel: string;
	kind: string;
	status: string;
	social_account_id: string | null;
	config: Record<string, unknown> | null;
	filters: Record<string, unknown> | null;
	allow_reentry: boolean;
	reentry_cooldown_min: number;
	priority: number;
	specificity: number;
	created_at: string;
	updated_at: string;
}

interface ApiEntrypointListResponse {
	data: ApiEntrypoint[];
}

interface ApiBinding {
	id: string;
	social_account_id: string;
	channel: string;
	binding_type: string;
	automation_id: string;
	config: Record<string, unknown> | null;
	status: string;
}

interface ApiBindingListResponse {
	data: ApiBinding[];
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
	dm_received: MessageCircle,
	keyword: KeyRound,
	comment_created: Hash,
	story_reply: CornerUpLeft,
	story_mention: AtSign,
	live_comment: Bell,
	ad_click: MousePointerClick,
	ref_link_click: Share2,
	share_to_dm: Share2,
	follow: UserPlus,
	schedule: Calendar,
	field_changed: Rss,
	tag_applied: Rss,
	tag_removed: Rss,
	conversion_event: Rss,
	webhook_inbound: Globe,
};

const BINDING_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
	default_reply: Bot,
	welcome_message: Sparkles,
	conversation_starter: Sparkles,
	main_menu: Sparkles,
	ice_breaker: Sparkles,
};

function humanizeKind(kind: string): string {
	return kind
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
	automationId: string;
	channel: string;
	readOnly?: boolean;
	onEntrypointChange?: () => void;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function EntrypointPanel({
	automationId,
	channel,
	readOnly,
	onEntrypointChange,
}: Props) {
	const catalog = useAutomationCatalog();
	const {
		data: entrypointData,
		loading: epLoading,
		error: epError,
		refetch: refetchEntrypoints,
	} = useApi<ApiEntrypointListResponse>(
		`automations/${automationId}/entrypoints`,
	);
	const {
		data: bindingData,
		loading: bindLoading,
	} = useApi<ApiBindingListResponse>("automation-bindings", {
		query: { automation_id: automationId },
	});

	const createEntrypoint = useMutation<ApiEntrypoint>(
		`automations/${automationId}/entrypoints`,
		"POST",
	);

	const entrypoints = entrypointData?.data ?? [];
	const bindings = bindingData?.data ?? [];

	// Compute the entrypoint kinds the add-dropdown should offer.
	const availableKinds = useMemo(() => {
		if (!catalog.data) return [];
		return catalog.data.entrypoint_kinds.filter((k) => {
			const channels = Array.isArray(k.channels) ? k.channels : [];
			if (channels.length === 0) return true;
			return channels.includes(channel);
		});
	}, [catalog.data, channel]);

	const [selectedId, setSelectedId] = useState<string | null>(null);

	const selected = selectedId
		? (entrypoints.find((e) => e.id === selectedId) ?? null)
		: null;

	const handleCreate = useCallback(
		async (kind: string) => {
			const body: Record<string, unknown> = {
				channel,
				kind,
			};
			const created = await createEntrypoint.mutate(body);
			if (created) {
				refetchEntrypoints();
				onEntrypointChange?.();
				setSelectedId(created.id);
			}
		},
		[channel, createEntrypoint, onEntrypointChange, refetchEntrypoints],
	);

	const handleDelete = useCallback(
		async (id: string) => {
			if (!confirm("Delete this entrypoint?")) return;
			const res = await fetch(`/api/automation-entrypoints/${id}`, {
				method: "DELETE",
			});
			if (res.ok || res.status === 204) {
				refetchEntrypoints();
				onEntrypointChange?.();
				if (selectedId === id) setSelectedId(null);
			}
		},
		[onEntrypointChange, refetchEntrypoints, selectedId],
	);

	const handleUpdate = useCallback(
		async (id: string, patch: Record<string, unknown>) => {
			const res = await fetch(`/api/automation-entrypoints/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			if (res.ok) {
				refetchEntrypoints();
				onEntrypointChange?.();
			}
		},
		[onEntrypointChange, refetchEntrypoints],
	);

	// Detail mode
	if (selected) {
		return (
			<EntrypointDetail
				entrypoint={selected}
				channel={channel}
				readOnly={readOnly}
				onBack={() => setSelectedId(null)}
				onDelete={() => handleDelete(selected.id)}
				onUpdate={(patch) => handleUpdate(selected.id, patch)}
			/>
		);
	}

	// List mode
	return (
		<div className="flex h-full w-[320px] flex-col overflow-hidden border-r border-[#e6e9ef] bg-white">
			<div className="flex shrink-0 items-center justify-between border-b border-[#e6e9ef] bg-[#e4f5e6] px-4 py-3">
				<div className="min-w-0">
					<div className="text-[15px] font-semibold text-[#353a44]">
						Entrypoints
					</div>
					<div className="text-[11px] text-[#6f7786]">
						{epLoading ? "Loading..." : `${entrypoints.length} configured`}
					</div>
				</div>
				{!readOnly && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 gap-1 text-xs"
								disabled={availableKinds.length === 0}
								title={
									availableKinds.length === 0
										? "No entrypoint kinds available for this channel"
										: "Add entrypoint"
								}
							>
								<Plus className="size-3.5" />
								Add
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-56">
							{availableKinds.map((k) => {
								const Icon = KIND_ICON[k.kind] ?? Zap;
								return (
									<DropdownMenuItem
										key={k.kind}
										onClick={() => void handleCreate(k.kind)}
										disabled={createEntrypoint.loading}
									>
										<Icon className="mr-2 size-3.5" />
										{typeof k.label === "string" ? k.label : humanizeKind(k.kind)}
									</DropdownMenuItem>
								);
							})}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>

			{epError && (
				<div className="mx-3 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
					{epError}
				</div>
			)}
			{createEntrypoint.error && (
				<div className="mx-3 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
					{createEntrypoint.error}
				</div>
			)}

			<ScrollArea className="flex-1">
				<div className="space-y-2 px-3 py-3">
					{epLoading ? (
						<div className="flex items-center justify-center py-8">
							<Loader2 className="size-4 animate-spin text-muted-foreground" />
						</div>
					) : entrypoints.length === 0 ? (
						<div className="rounded-md border border-dashed border-[#d9dde6] px-3 py-6 text-center text-[11px] text-[#7e8695]">
							{readOnly
								? "No entrypoints configured."
								: "Click Add to create your first entrypoint."}
						</div>
					) : (
						entrypoints.map((ep) => (
							<EntrypointRow
								key={ep.id}
								entrypoint={ep}
								onSelect={() => setSelectedId(ep.id)}
							/>
						))
					)}

					<div className="pt-4">
						<div className="mb-2 flex items-center justify-between">
							<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
								Bindings
							</div>
							<span className="text-[10px] text-[#7e8695]">
								{bindLoading ? "..." : bindings.length}
							</span>
						</div>
						{bindLoading ? null : bindings.length === 0 ? (
							<div className="rounded-md border border-dashed border-[#e6e9ef] px-3 py-4 text-center text-[11px] text-[#7e8695]">
								No bindings. Set this automation as a welcome or default reply
								on the Accounts page.
							</div>
						) : (
							<div className="space-y-2">
								{bindings.map((b) => (
									<BindingRow key={b.id} binding={b} />
								))}
							</div>
						)}
					</div>
				</div>
			</ScrollArea>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Entrypoint list row
// ---------------------------------------------------------------------------

function EntrypointRow({
	entrypoint,
	onSelect,
}: {
	entrypoint: ApiEntrypoint;
	onSelect: () => void;
}) {
	const Icon = KIND_ICON[entrypoint.kind] ?? Zap;
	const summary = summarizeEntrypoint(entrypoint);
	const statusTone =
		entrypoint.status === "active"
			? "text-emerald-600"
			: entrypoint.status === "paused"
				? "text-amber-600"
				: "text-[#7e8695]";
	return (
		<button
			type="button"
			onClick={onSelect}
			className="flex w-full items-center gap-3 rounded-[14px] border border-[#e6e9ef] bg-white px-3 py-2.5 text-left transition hover:border-[#4680ff]/40 hover:bg-[#f5f8ff]"
		>
			<div className="flex size-9 items-center justify-center rounded-full bg-[#f0f4ff] text-[#4680ff]">
				<Icon className="size-4" />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="truncate text-[13px] font-medium text-[#353a44]">
						{humanizeKind(entrypoint.kind)}
					</span>
					<span className={cn("text-[10px]", statusTone)}>
						· {entrypoint.status}
					</span>
				</div>
				{summary && (
					<div className="mt-0.5 truncate text-[11px] text-[#7e8695]">
						{summary}
					</div>
				)}
			</div>
			<ChevronRight className="size-3.5 shrink-0 text-[#bfc6d3]" />
		</button>
	);
}

function summarizeEntrypoint(ep: ApiEntrypoint): string {
	const config = (ep.config ?? {}) as Record<string, unknown>;
	const parts: string[] = [];

	// API stores the filter under `keywords` (see apps/api
	// .../schemas/automation-entrypoints.ts). `keyword_filter` is the legacy
	// key kept as a read-only fallback for rows persisted before the rename.
	const keywords = config.keywords ?? config.keyword_filter;
	if (Array.isArray(keywords) && keywords.length > 0) {
		parts.push(
			`"${keywords.slice(0, 2).join('", "')}"${keywords.length > 2 ? "…" : ""}`,
		);
	}
	const postIds = config.post_ids;
	if (Array.isArray(postIds) && postIds.length > 0) {
		parts.push(`${postIds.length} post${postIds.length === 1 ? "" : "s"}`);
	}
	if (ep.kind === "webhook_inbound") {
		const slug = (config.slug ?? config.path) as string | undefined;
		if (slug) parts.push(`slug: ${slug}`);
	}
	if (ep.social_account_id) {
		parts.push(`acc ${ep.social_account_id.slice(-6)}`);
	}
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Binding row (informational link-out; per spec, full CRUD in Plan 3)
// ---------------------------------------------------------------------------

function BindingRow({ binding }: { binding: ApiBinding }) {
	const Icon = BINDING_ICON[binding.binding_type] ?? Zap;
	const href = `/app/connections`; // binding CRUD lives on the per-account page (Plan 3)
	return (
		<a
			href={href}
			className="flex items-center gap-3 rounded-[14px] border border-[#e6e9ef] bg-[#fafbfc] px-3 py-2.5 transition hover:border-[#4680ff]/40 hover:bg-[#f5f8ff]"
		>
			<div className="flex size-9 items-center justify-center rounded-full bg-[#fff4e4] text-[#cc8a2e]">
				<Icon className="size-4" />
			</div>
			<div className="min-w-0 flex-1">
				<div className="truncate text-[13px] font-medium text-[#353a44]">
					{humanizeKind(binding.binding_type)}
				</div>
				<div className="truncate text-[11px] text-[#7e8695]">
					{binding.channel} · acc {binding.social_account_id.slice(-6)}
				</div>
			</div>
			<span className="shrink-0 rounded-full bg-[#f0f4ff] px-2 py-0.5 text-[10px] text-[#4680ff]">
				Managed on Accounts
			</span>
		</a>
	);
}

// ---------------------------------------------------------------------------
// Detail mode — inline config editor per kind
// ---------------------------------------------------------------------------

function EntrypointDetail({
	entrypoint,
	channel,
	readOnly,
	onBack,
	onDelete,
	onUpdate,
}: {
	entrypoint: ApiEntrypoint;
	channel: string;
	readOnly?: boolean;
	onBack: () => void;
	onDelete: () => void;
	onUpdate: (patch: Record<string, unknown>) => void | Promise<void>;
}) {
	const config = (entrypoint.config ?? {}) as Record<string, unknown>;
	const filters = (entrypoint.filters ?? {}) as {
		predicates?: FilterGroup;
	};

	const setConfig = (patch: Record<string, unknown>) => {
		const next = { ...config, ...patch };
		void onUpdate({ config: next });
	};

	const setSocialAccount = (accountId: string | null) => {
		void onUpdate({ social_account_id: accountId });
	};

	const setPredicates = (next: FilterGroup | undefined) => {
		const nextFilters: Record<string, unknown> = { ...filters };
		if (next) nextFilters.predicates = next;
		else delete nextFilters.predicates;
		void onUpdate({ filters: nextFilters });
	};

	const togglePause = () => {
		const nextStatus = entrypoint.status === "active" ? "paused" : "active";
		void onUpdate({ status: nextStatus });
	};

	return (
		<div className="flex h-full w-[320px] flex-col overflow-hidden border-r border-[#e6e9ef] bg-white">
			<div className="flex shrink-0 items-center justify-between border-b border-[#e6e9ef] bg-[#e4f5e6] px-3 py-3">
				<div className="flex min-w-0 items-center gap-2">
					<button
						type="button"
						onClick={onBack}
						className="rounded-full p-1 text-[#6f7786] transition hover:bg-white/70 hover:text-[#353a44]"
						aria-label="Back"
					>
						<ChevronLeft className="size-4" />
					</button>
					<div className="min-w-0">
						<div className="truncate text-[14px] font-semibold text-[#353a44]">
							{humanizeKind(entrypoint.kind)}
						</div>
						<div className="text-[10px] text-[#7e8695]">{entrypoint.status}</div>
					</div>
				</div>
				<button
					type="button"
					onClick={onBack}
					className="text-[#6f7786] hover:text-[#353a44]"
					aria-label="Close"
				>
					<X className="size-3.5" />
				</button>
			</div>

			<ScrollArea className="flex-1">
				<div className="space-y-4 px-3 py-4">
					<div className="rounded-[16px] border border-[#e6e9ef] bg-white p-3">
						<div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
							Account
						</div>
						<AccountSearchCombobox
							value={entrypoint.social_account_id ?? null}
							onSelect={setSocialAccount}
							platforms={channel === "multi" ? undefined : [channel]}
							showAllOption={false}
							placeholder="Any connected account"
							variant="input"
						/>
					</div>

					<KindSpecificConfig
						kind={entrypoint.kind}
						config={config}
						readOnly={readOnly}
						onChange={setConfig}
					/>

					<div className="rounded-[16px] border border-[#e6e9ef] bg-white p-3">
						<div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
							Filters
						</div>
						<FilterGroupEditor
							value={filters.predicates}
							onChange={setPredicates}
							readOnly={readOnly}
						/>
					</div>

					<div className="rounded-[16px] border border-[#e6e9ef] bg-white p-3">
						<div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
							Reentry
						</div>
						<label className="flex items-center gap-2 text-[12px] text-[#353a44]">
							<input
								type="checkbox"
								checked={entrypoint.allow_reentry}
								disabled={readOnly}
								onChange={(e) =>
									void onUpdate({ allow_reentry: e.target.checked })
								}
							/>
							Allow the same contact to re-enter
						</label>
						<div className="mt-3">
							<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
								Reentry cooldown (minutes)
							</label>
							<input
								type="number"
								min={0}
								value={entrypoint.reentry_cooldown_min}
								disabled={readOnly}
								onChange={(e) =>
									void onUpdate({
										reentry_cooldown_min: Number(e.target.value) || 0,
									})
								}
								className={INPUT_CLS}
							/>
						</div>
					</div>

					{!readOnly && (
						<div className="space-y-2">
							<Button
								variant="outline"
								size="sm"
								className="h-8 w-full gap-1.5 text-xs"
								onClick={togglePause}
							>
								{entrypoint.status === "active" ? "Pause" : "Resume"}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="h-8 w-full gap-1.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
								onClick={onDelete}
							>
								Delete entrypoint
							</Button>
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}

// ---------------------------------------------------------------------------
// KindSpecificConfig — thin per-kind editor dispatcher
// ---------------------------------------------------------------------------

function KindSpecificConfig({
	kind,
	config,
	readOnly,
	onChange,
}: {
	kind: string;
	config: Record<string, unknown>;
	readOnly?: boolean;
	onChange: (patch: Record<string, unknown>) => void;
}) {
	switch (kind) {
		case "keyword":
			return (
				<KeywordConfig config={config} readOnly={readOnly} onChange={onChange} />
			);
		case "comment_created":
			return (
				<CommentConfig config={config} readOnly={readOnly} onChange={onChange} />
			);
		case "dm_received":
			return (
				<DmConfig config={config} readOnly={readOnly} onChange={onChange} />
			);
		case "webhook_inbound":
			return <WebhookConfig config={config} />;
		default:
			return null;
	}
}

function KeywordConfig({
	config,
	readOnly,
	onChange,
}: {
	config: Record<string, unknown>;
	readOnly?: boolean;
	onChange: (patch: Record<string, unknown>) => void;
}) {
	const keywords = Array.isArray(config.keywords)
		? (config.keywords as string[])
		: [];
	const matchMode = (config.match_mode as string | undefined) ?? "contains";
	return (
		<div className="rounded-[16px] border border-[#e6e9ef] bg-white p-3">
			<div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
				Keywords
			</div>
			<input
				type="text"
				disabled={readOnly}
				defaultValue={keywords.join(", ")}
				onBlur={(e) => {
					const next = e.currentTarget.value
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
					onChange({ keywords: next });
				}}
				placeholder="LINK, INFO, PRICE"
				className={INPUT_CLS}
			/>
			<p className="mt-1 text-[10px] text-[#7e8695]">
				Comma-separated list. Case-insensitive.
			</p>
			<div className="mt-3">
				<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
					Match mode
				</label>
				<select
					value={matchMode}
					disabled={readOnly}
					onChange={(e) => onChange({ match_mode: e.target.value })}
					className="h-9 w-full rounded-md border border-[#d9dde6] bg-white px-2 text-[13px]"
				>
					<option value="contains">Contains</option>
					<option value="exact">Exact</option>
					<option value="prefix">Starts with</option>
					<option value="suffix">Ends with</option>
				</select>
			</div>
		</div>
	);
}

function CommentConfig({
	config,
	readOnly,
	onChange,
}: {
	config: Record<string, unknown>;
	readOnly?: boolean;
	onChange: (patch: Record<string, unknown>) => void;
}) {
	const postIds = Array.isArray(config.post_ids)
		? (config.post_ids as string[])
		: [];
	const includeReplies = config.include_replies === true;
	// Prefer the new `keywords` key but fall back to the legacy
	// `keyword_filter` so pre-migration rows still render correctly.
	const keywordFilter = Array.isArray(config.keywords)
		? (config.keywords as string[])
		: Array.isArray(config.keyword_filter)
			? (config.keyword_filter as string[])
			: [];
	return (
		<div className="rounded-[16px] border border-[#e6e9ef] bg-white p-3">
			<div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
				Comment filter
			</div>
			<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
				Post IDs (comma-separated — leave empty for all posts)
			</label>
			<input
				type="text"
				disabled={readOnly}
				defaultValue={postIds.join(", ")}
				onBlur={(e) => {
					const next = e.currentTarget.value
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
					onChange({ post_ids: next.length > 0 ? next : null });
				}}
				className={INPUT_CLS}
			/>
			<div className="mt-3">
				<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
					Keyword filter (optional)
				</label>
				<input
					type="text"
					disabled={readOnly}
					defaultValue={keywordFilter.join(", ")}
					onBlur={(e) => {
						const next = e.currentTarget.value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						// Write new canonical key `keywords`; also clear the legacy
					// `keyword_filter` to avoid a stale-data ambiguity.
					onChange({ keywords: next, keyword_filter: undefined });
					}}
					placeholder="pizza, info"
					className={INPUT_CLS}
				/>
			</div>
			<label className="mt-3 flex items-center gap-2 text-[12px] text-[#353a44]">
				<input
					type="checkbox"
					disabled={readOnly}
					checked={includeReplies}
					onChange={(e) => onChange({ include_replies: e.target.checked })}
				/>
				Also match replies to comments
			</label>
		</div>
	);
}

function DmConfig({
	config,
	readOnly,
	onChange,
}: {
	config: Record<string, unknown>;
	readOnly?: boolean;
	onChange: (patch: Record<string, unknown>) => void;
}) {
	const firstOnly = config.first_message_only === true;
	return (
		<div className="rounded-[16px] border border-[#e6e9ef] bg-white p-3">
			<div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
				Direct message
			</div>
			<label className="flex items-center gap-2 text-[12px] text-[#353a44]">
				<input
					type="checkbox"
					disabled={readOnly}
					checked={firstOnly}
					onChange={(e) => onChange({ first_message_only: e.target.checked })}
				/>
				Only trigger on the first message of a conversation
			</label>
		</div>
	);
}

function WebhookConfig({
	config,
}: {
	config: Record<string, unknown>;
}) {
	const slug = (config.slug as string | undefined) ?? "";
	return (
		<div className="rounded-[16px] border border-[#e6e9ef] bg-white p-3">
			<div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
				Webhook
			</div>
			<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
				Slug
			</label>
			<input
				type="text"
				value={slug}
				readOnly
				className={cn(INPUT_CLS, "font-mono text-[12px]")}
			/>
			<p className="mt-2 text-[10px] text-[#7e8695]">
				Rotate the HMAC secret from the Accounts page.
			</p>
		</div>
	);
}
