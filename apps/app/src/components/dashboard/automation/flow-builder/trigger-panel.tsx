// Trigger panel (Plan 8 — UI restoration).
//
// Right-side panel that renders when the canvas's synthetic trigger card is
// selected. Has two modes:
//
//   - List mode  (selectedEntrypointId = null): shows all entrypoints, plus a
//     "+ New Trigger" kind picker that mirrors the one inside the canvas card.
//   - Detail mode (selectedEntrypointId = <id>): inline editor for a single
//     entrypoint (account, kind-specific config, filters, reentry, status).
//
// Mutations go through the dashboard's Astro proxies:
//   - POST    /api/automations/{id}/entrypoints
//   - PATCH   /api/automation-entrypoints/{id}
//   - DELETE  /api/automation-entrypoints/{id}
//
// This component replaces the deleted `entrypoint-panel.tsx` left sidebar from
// Plan 2. Data shapes are unchanged — we consume the same `AutomationEntrypoint`
// records fetched by the parent detail page.

import { useCallback, useMemo, type ChangeEvent } from "react";
import {
	ChevronRight,
	Link2,
	Loader2,
	Plus,
	Trash2,
	Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import { PostSearchCombobox } from "@/components/dashboard/post-search-combobox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useMutation } from "@/hooks/use-api";
import {
	useAutomationCatalog,
	type CatalogBindingType,
	type CatalogEntrypointKind,
} from "./use-catalog";
import {
	bindingAccountHandle,
	bindingLabel,
	bindingStatusBadge,
	type CanvasBindingRow,
} from "../bindings-tab/display";
import type { AutomationEntrypoint } from "./guided-flow";
import { FilterGroupEditor, type FilterGroup } from "./filter-group-editor";
import { INPUT_CLS } from "./field-styles";
import { PANEL_BODY_CLS, PANEL_SHELL_CLS, PanelHeader } from "./panel-styles";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
	automationId: string;
	channel: string;
	entrypoints: AutomationEntrypoint[];
	selectedEntrypointId: string | null;
	onSelectEntrypoint: (entrypointId: string | null) => void;
	onClose: () => void;
	onEntrypointsChanged: () => void;
	readOnly?: boolean;
	// Connection bindings (welcome_message, default_reply, menu surfaces) this
	// automation is attached to. Listed alongside entrypoints so the panel
	// mirrors the canvas trigger node. Selecting/adding one is handled by the
	// host page (opens the BindingDetailPanel), so this panel only renders rows.
	bindings: CanvasBindingRow[];
	onSelectBinding: (bindingId: string) => void;
	onAddBinding: (bindingType: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANEL_WIDTH_CLS = "w-[360px] xl:w-[392px]";

function humanizeKind(kind: string): string {
	return kind
		.split("_")
		.filter(Boolean)
		.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
		.join(" ");
}

// ---------------------------------------------------------------------------
// Main panel — dispatches list vs. detail
// ---------------------------------------------------------------------------

export function TriggerPanel({
	automationId,
	channel,
	entrypoints,
	selectedEntrypointId,
	onSelectEntrypoint,
	onClose,
	onEntrypointsChanged,
	readOnly,
	bindings,
	onSelectBinding,
	onAddBinding,
}: Props) {
	const catalog = useAutomationCatalog();

	const availableKinds = useMemo(() => {
		if (!catalog.data) return [];
		return catalog.data.entrypoint_kinds.filter((k) => {
			const channels = Array.isArray(k.channels) ? k.channels : [];
			if (channels.length === 0) return true;
			return channels.includes(channel);
		});
	}, [catalog.data, channel]);

	// Binding types available for this channel — the "Conversation entry points"
	// group of the "+ New Trigger" dropdown. Mirrors the canvas node's logic.
	const availableBindingTypes = useMemo(() => {
		if (!catalog.data) return [] as CatalogBindingType[];
		return catalog.data.binding_types.filter((b) => {
			const channels = Array.isArray(b.channels) ? b.channels : [];
			if (channels.length === 0) return true;
			return channels.includes(channel);
		});
	}, [catalog.data, channel]);

	const createEntrypoint = useMutation<AutomationEntrypoint>(
		`automations/${automationId}/entrypoints`,
		"POST",
	);

	const handleCreate = useCallback(
		async (kind: string) => {
			const created = await createEntrypoint.mutate({
				channel,
				kind,
			});
			if (created) {
				onEntrypointsChanged();
				onSelectEntrypoint(created.id);
			}
		},
		[channel, createEntrypoint, onEntrypointsChanged, onSelectEntrypoint],
	);

	const handleUpdate = useCallback(
		async (id: string, patch: Record<string, unknown>) => {
			const res = await fetch(`/api/automation-entrypoints/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			if (res.ok) {
				onEntrypointsChanged();
			}
		},
		[onEntrypointsChanged],
	);

	const handleDelete = useCallback(
		async (id: string) => {
			if (!confirm("Delete this entrypoint?")) return;
			const res = await fetch(`/api/automation-entrypoints/${id}`, {
				method: "DELETE",
			});
			if (res.ok || res.status === 204) {
				onEntrypointsChanged();
				if (selectedEntrypointId === id) onSelectEntrypoint(null);
			}
		},
		[onEntrypointsChanged, onSelectEntrypoint, selectedEntrypointId],
	);

	const selected = useMemo(
		() =>
			selectedEntrypointId
				? (entrypoints.find((e) => e.id === selectedEntrypointId) ?? null)
				: null,
		[entrypoints, selectedEntrypointId],
	);

	// Stabilise the detail-mode callbacks so children whose deps include them
	// (AccountSearchCombobox's fetchAccounts, etc.) don't see a fresh identity
	// on every parent render.
	const handleDetailBack = useCallback(
		() => onSelectEntrypoint(null),
		[onSelectEntrypoint],
	);
	const handleDetailUpdate = useCallback(
		(patch: Record<string, unknown>) => {
			if (!selected) return;
			return handleUpdate(selected.id, patch);
		},
		[handleUpdate, selected],
	);
	const handleDetailDelete = useCallback(() => {
		if (!selected) return;
		void handleDelete(selected.id);
	}, [handleDelete, selected]);

	if (selected) {
		return (
			<TriggerDetailMode
				channel={channel}
				entrypoint={selected}
				onBack={handleDetailBack}
				onUpdate={handleDetailUpdate}
				onDelete={handleDetailDelete}
				readOnly={readOnly}
			/>
		);
	}

	return (
		<TriggerListMode
			channel={channel}
			entrypoints={entrypoints}
			availableKinds={availableKinds}
			onSelectEntrypoint={onSelectEntrypoint}
			onAddEntrypoint={handleCreate}
			onClose={onClose}
			readOnly={readOnly}
			creating={createEntrypoint.loading}
			createError={createEntrypoint.error}
			bindings={bindings}
			availableBindingTypes={availableBindingTypes}
			onSelectBinding={onSelectBinding}
			onAddBinding={onAddBinding}
		/>
	);
}

// ---------------------------------------------------------------------------
// List mode
// ---------------------------------------------------------------------------

function TriggerListMode({
	channel,
	entrypoints,
	availableKinds,
	onSelectEntrypoint,
	onAddEntrypoint,
	onClose,
	readOnly,
	creating,
	createError,
	bindings,
	availableBindingTypes,
	onSelectBinding,
	onAddBinding,
}: {
	channel: string;
	entrypoints: AutomationEntrypoint[];
	availableKinds: CatalogEntrypointKind[];
	onSelectEntrypoint: (id: string | null) => void;
	onAddEntrypoint: (kind: string) => void;
	onClose: () => void;
	readOnly?: boolean;
	creating?: boolean;
	createError?: string | null;
	bindings: CanvasBindingRow[];
	availableBindingTypes: CatalogBindingType[];
	onSelectBinding: (bindingId: string) => void;
	onAddBinding: (bindingType: string) => void;
}) {
	return (
		<div className={cn(PANEL_SHELL_CLS, PANEL_WIDTH_CLS)}>
			<PanelHeader
				icon={<Zap className="size-[18px]" />}
				title="When..."
				subtitle="Triggers that start this automation."
				onClose={onClose}
			/>

			{createError && (
				<div className="mx-3 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
					{createError}
				</div>
			)}

			<ScrollArea className={PANEL_BODY_CLS}>
				<div className="space-y-3 px-4 py-4">
					{entrypoints.length === 0 && bindings.length === 0 ? (
						<div className="rounded-[16px] border border-dashed border-[#d9dde6] bg-white px-4 py-6 text-center text-[13px] text-[#7e8695]">
							{readOnly
								? "No triggers configured."
								: "Add a trigger to start your automation."}
						</div>
					) : (
						entrypoints.map((ep) => (
							<button
								key={ep.id}
								type="button"
								onClick={() => onSelectEntrypoint(ep.id)}
								className="flex w-full items-center gap-3 rounded-[16px] border border-[#e6e9ef] bg-white px-4 py-3 text-left transition hover:border-[#9aa3b2] hover:bg-[#f7f8fa]"
							>
								<div className="flex size-10 items-center justify-center rounded-full bg-[#f1f3f6] text-[#5a6373]">
									<Zap className="size-4" />
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5">
										<span className="truncate text-[13px] font-medium text-[#353a44]">
											{humanizeKind(ep.kind)}
										</span>
										<span
											className={cn(
												"text-[10px]",
												ep.status === "active"
													? "text-[#353a44]"
													: "text-[#8b92a0]",
											)}
										>
											· {ep.status}
										</span>
									</div>
									<div className="mt-0.5 truncate text-[11px] text-[#7e8695]">
										{summarizeEntrypoint(ep)}
									</div>
								</div>
								<ChevronRight className="size-3.5 shrink-0 text-[#bfc6d3]" />
							</button>
						))
					)}

					{/* Connection bindings — an alternate way the flow starts, on a
						specific account. Blue link bubble distinguishes them from the
						grey event entrypoints above, mirroring the canvas node.
						Selecting one hands off to the host page's BindingDetailPanel. */}
					{bindings.map((binding) => {
						const badge = bindingStatusBadge(binding.status);
						return (
							<button
								key={binding.id}
								type="button"
								onClick={() => onSelectBinding(binding.id)}
								className="flex w-full items-center gap-3 rounded-[16px] border border-[#e6e9ef] bg-[#f4f5f8] px-4 py-3 text-left transition hover:border-[#9aa3b2] hover:bg-[#eef0f3]"
							>
								<div className="flex size-10 items-center justify-center rounded-full bg-[#eceff3] text-[#5a6373]">
									<Link2 className="size-4" />
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-1.5">
										<span className="truncate text-[13px] font-medium text-[#353a44]">
											{bindingLabel(binding.binding_type)}
										</span>
										<span
											className={cn(
												"shrink-0 rounded-full border px-1.5 py-0 text-[9px] font-medium",
												badge.cls,
											)}
										>
											{badge.label}
										</span>
									</div>
									<div className="mt-0.5 truncate text-[11px] text-[#7e8695]">
										{bindingAccountHandle(binding)}
									</div>
								</div>
								<ChevronRight className="size-3.5 shrink-0 text-[#bfc6d3]" />
							</button>
						);
					})}

					{!readOnly && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									disabled={
										(availableKinds.length === 0 &&
											availableBindingTypes.length === 0) ||
										creating
									}
									className="mt-2 flex h-11 w-full items-center justify-center gap-1.5 rounded-[14px] border border-dashed border-[#d9dde6] text-[14px] font-semibold text-[#5a6373] transition hover:border-[#9aa3b2] hover:bg-[#f4f5f8] disabled:cursor-not-allowed disabled:opacity-60"
									title={
										availableKinds.length === 0 &&
										availableBindingTypes.length === 0
											? `No triggers available for ${channel}`
											: undefined
									}
								>
									{creating ? (
										<Loader2 className="size-3.5 animate-spin" />
									) : (
										<Plus className="size-3.5" />
									)}
									New Trigger
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="center" sideOffset={8} className="w-[320px]">
								{availableKinds.length > 0 && (
									<DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
										Events
									</DropdownMenuLabel>
								)}
								{availableKinds.map((k) => (
									<DropdownMenuItem
										key={k.kind}
										onSelect={(event) => {
											event.preventDefault();
											onAddEntrypoint(k.kind);
										}}
									>
										<span className="text-[13px] font-medium text-foreground">
											{typeof k.label === "string" ? k.label : humanizeKind(k.kind)}
										</span>
									</DropdownMenuItem>
								))}
								{availableBindingTypes.length > 0 && (
									<>
										{availableKinds.length > 0 && <DropdownMenuSeparator />}
										<DropdownMenuLabel className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
											Conversation entry points
										</DropdownMenuLabel>
										{availableBindingTypes.map((b) => (
											<DropdownMenuItem
												key={b.type}
												onSelect={(event) => {
													event.preventDefault();
													onAddBinding(b.type);
												}}
											>
												<span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
													<Link2 className="size-3.5 text-[#5a6373]" />
													{b.label}
													{b.v1_status === "stubbed" && (
														<span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[9px] font-medium text-amber-600">
															v1.1
														</span>
													)}
												</span>
											</DropdownMenuItem>
										))}
									</>
								)}
								{availableKinds.length === 0 &&
									availableBindingTypes.length === 0 && (
										<div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
											No triggers available.
										</div>
									)}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}

function summarizeEntrypoint(ep: AutomationEntrypoint): string {
	const config = (ep.config ?? {}) as Record<string, unknown>;
	const parts: string[] = [];
	const keywords = config.keywords ?? config.keyword_filter;
	if (Array.isArray(keywords) && keywords.length > 0) {
		parts.push(
			`"${(keywords as string[]).slice(0, 2).join('", "')}"${
				keywords.length > 2 ? "…" : ""
			}`,
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
// Detail mode
// ---------------------------------------------------------------------------

function TriggerDetailMode({
	channel,
	entrypoint,
	onBack,
	onUpdate,
	onDelete,
	readOnly,
}: {
	channel: string;
	entrypoint: AutomationEntrypoint;
	onBack: () => void;
	onUpdate: (patch: Record<string, unknown>) => void | Promise<void>;
	onDelete: () => void;
	readOnly?: boolean;
}) {
	const config = useMemo(
		() => (entrypoint.config ?? {}) as Record<string, unknown>,
		[entrypoint.config],
	);
	const filters = useMemo(
		() =>
			(entrypoint.filters ?? {}) as {
				predicates?: FilterGroup;
			},
		[entrypoint.filters],
	);

	// Memoise the `platforms` array we hand to `AccountSearchCombobox`. Without
	// this, every parent render produces a fresh `[channel]` literal which
	// shifts the combobox's internal `fetchAccounts` identity and (worse)
	// causes any downstream effect that takes `platforms` in its deps to
	// re-fire. Freezing it on `channel` keeps the child memo keys stable.
	const accountPlatforms = useMemo<string[] | undefined>(
		() => (channel === "multi" ? undefined : [channel]),
		[channel],
	);

	const setConfig = useCallback(
		(patch: Record<string, unknown>) => {
			const next = { ...config, ...patch };
			void onUpdate({ config: next });
		},
		[config, onUpdate],
	);

	const setSocialAccount = useCallback(
		(accountId: string | null) => {
			void onUpdate({ social_account_id: accountId });
		},
		[onUpdate],
	);

	const setPredicates = useCallback(
		(next: FilterGroup | undefined) => {
			const nextFilters: Record<string, unknown> = { ...filters };
			if (next) nextFilters.predicates = next;
			else delete nextFilters.predicates;
			void onUpdate({ filters: nextFilters });
		},
		[filters, onUpdate],
	);

	const togglePause = useCallback(() => {
		const nextStatus = entrypoint.status === "active" ? "paused" : "active";
		void onUpdate({ status: nextStatus });
	}, [entrypoint.status, onUpdate]);

	const handleReentryToggle = useCallback(
		(e: ChangeEvent<HTMLInputElement>) => {
			void onUpdate({ allow_reentry: e.target.checked });
		},
		[onUpdate],
	);

	const handleCooldownChange = useCallback(
		(e: ChangeEvent<HTMLInputElement>) => {
			void onUpdate({
				reentry_cooldown_min: Number(e.target.value) || 0,
			});
		},
		[onUpdate],
	);

	return (
		<div className={cn(PANEL_SHELL_CLS, PANEL_WIDTH_CLS)}>
			<PanelHeader
				onBack={onBack}
				title={humanizeKind(entrypoint.kind)}
				subtitle={<span className="capitalize">{entrypoint.status}</span>}
			/>

			<ScrollArea className={PANEL_BODY_CLS}>
				<div className="space-y-4 px-3 py-4">
					<div className="rounded-[16px] border border-[#e6e9ef] bg-white p-3">
						<div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
							Account
						</div>
						<AccountSearchCombobox
							value={entrypoint.social_account_id ?? null}
							onSelect={setSocialAccount}
							platforms={accountPlatforms}
							showAllOption={false}
							placeholder="Any connected account"
							variant="input"
						/>
					</div>

					<KindSpecificConfig
						kind={entrypoint.kind}
						config={config}
						socialAccountId={entrypoint.social_account_id}
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
								onChange={handleReentryToggle}
							/>
							Allow the same contact to re-enter
						</label>
						<div className="mt-3">
							<label
								htmlFor="trigger-reentry-cooldown"
								className="mb-1 block text-[11px] font-medium text-[#7e8695]"
							>
								Reentry cooldown (minutes)
							</label>
							<input
								id="trigger-reentry-cooldown"
								type="number"
								min={0}
								value={entrypoint.reentry_cooldown_min}
								disabled={readOnly}
								onChange={handleCooldownChange}
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
								<Trash2 className="size-3.5" />
								Delete trigger
							</Button>
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Per-kind config editors
// ---------------------------------------------------------------------------

function KindSpecificConfig({
	kind,
	config,
	socialAccountId,
	readOnly,
	onChange,
}: {
	kind: string;
	config: Record<string, unknown>;
	socialAccountId: string | null;
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
				<CommentConfig
					config={config}
					socialAccountId={socialAccountId}
					readOnly={readOnly}
					onChange={onChange}
				/>
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
				<label
					htmlFor="trigger-match-mode"
					className="mb-1 block text-[11px] font-medium text-[#7e8695]"
				>
					Match mode
				</label>
				<select
					id="trigger-match-mode"
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
	socialAccountId,
	readOnly,
	onChange,
}: {
	config: Record<string, unknown>;
	socialAccountId: string | null;
	readOnly?: boolean;
	onChange: (patch: Record<string, unknown>) => void;
}) {
	const postIds = Array.isArray(config.post_ids)
		? (config.post_ids as string[])
		: [];
	const includeReplies = config.include_replies === true;
	const keywordFilter = Array.isArray(config.keywords)
		? (config.keywords as string[])
		: Array.isArray(config.keyword_filter)
			? (config.keyword_filter as string[])
			: [];
	const selectedPostId = postIds[0] ?? null;

	return (
		<div className="rounded-[16px] border border-[#e6e9ef] bg-white p-3">
			<div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
				Comment filter
			</div>
			<span className="mb-1 block text-[11px] font-medium text-[#7e8695]">
				Post (leave empty to match all)
			</span>
			<div className={cn(readOnly && "pointer-events-none opacity-60")}>
				<PostSearchCombobox
					value={selectedPostId}
					onSelect={(postId) =>
						onChange({ post_ids: postId ? [postId] : null })
					}
					accountId={socialAccountId}
					showAllOption={true}
					placeholder="All posts"
					variant="input"
				/>
			</div>
			<div className="mt-3">
				<label
					htmlFor="trigger-keyword-filter"
					className="mb-1 block text-[11px] font-medium text-[#7e8695]"
				>
					Keyword filter (optional)
				</label>
				<input
					id="trigger-keyword-filter"
					type="text"
					disabled={readOnly}
					defaultValue={keywordFilter.join(", ")}
					onBlur={(e) => {
						const next = e.currentTarget.value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
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
			<label
				htmlFor="trigger-webhook-slug"
				className="mb-1 block text-[11px] font-medium text-[#7e8695]"
			>
				Slug
			</label>
			<input
				id="trigger-webhook-slug"
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
