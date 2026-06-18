// Canvas binding detail panel.
//
// The automation-canvas analogue of the per-account Connections binding tabs.
// Connections page: account is fixed, you pick an automation. Here it's the
// inverse — the automation is fixed (the one open on the canvas) and you pick
// an account. Both surfaces read/write the SAME `automation_bindings` rows via
// the `/api/automation-bindings*` proxy, so a binding created here shows up on
// the Connections page and vice-versa with no extra sync.
//
// Mounted on the right of the canvas in two modes:
//   - create: `createType` set, `binding` null → account picker + editor + Create
//   - edit:   `binding` set → account shown read-only, editor + Save/Pause/Unbind

import { ExternalLink, Link2, Loader2, Unlink, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	AccountSearchCombobox,
	type AccountOption,
} from "@/components/dashboard/account-search-combobox";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { BINDING_CONFIG_EDITORS } from "../bindings-tab/binding-editors";
import {
	bindingAccountHandle,
	bindingConnectionHref,
	bindingLabel,
	bindingStatusBadge,
	type CanvasBindingRow,
} from "../bindings-tab/display";
import type { BindingChannel, BindingType } from "../bindings-tab/types";

const PANEL_WIDTH_CLS = "w-[360px] xl:w-[392px]";

interface InsightsResponse {
	totals?: { enrolled?: number; completed?: number };
}

interface Props {
	automationId: string;
	channel: BindingChannel;
	/** Existing binding to edit, or null in create mode. */
	binding: CanvasBindingRow | null;
	/** Binding type being created, or null in edit mode. */
	createType: BindingType | null;
	onClose: () => void;
	/** Refetch the page's bindings list after any mutation. */
	onChanged: () => void;
	/** Select a binding by id (used to switch to edit mode after create). */
	onSelectBindingId: (id: string | null) => void;
	readOnly?: boolean;
}

function accountOptionLabel(account: AccountOption | null): string | null {
	if (!account) return null;
	if (account.username) {
		return account.username.startsWith("@")
			? account.username
			: `@${account.username}`;
	}
	return account.display_name ?? account.id.slice(-6);
}

export function BindingDetailPanel({
	automationId,
	channel,
	binding,
	createType,
	onClose,
	onChanged,
	onSelectBindingId,
	readOnly,
}: Props) {
	const bindingType: BindingType | null = binding?.binding_type ?? createType;
	const ed = bindingType ? BINDING_CONFIG_EDITORS[bindingType] : null;
	const isCreate = !binding;

	const [config, setConfig] = useState<unknown>(() =>
		ed ? (binding ? ed.parseConfig(binding.config) : ed.emptyConfig) : {},
	);
	const [accountId, setAccountId] = useState<string | null>(
		binding?.social_account_id ?? null,
	);
	const [accountLabel, setAccountLabel] = useState<string | null>(
		binding ? bindingAccountHandle(binding) : null,
	);
	const [saving, setSaving] = useState(false);
	const [banner, setBanner] = useState<{
		type: "error" | "success";
		message: string;
	} | null>(null);
	const [insights, setInsights] = useState<InsightsResponse | null>(null);

	// Re-initialise when the selected binding / create type changes.
	useEffect(() => {
		setBanner(null);
		setConfig(ed ? (binding ? ed.parseConfig(binding.config) : ed.emptyConfig) : {});
		setAccountId(binding?.social_account_id ?? null);
		setAccountLabel(binding ? bindingAccountHandle(binding) : null);
	}, [binding?.id, createType]);

	// Load 7d insights for an existing live binding (stubbed types never run yet).
	useEffect(() => {
		if (!binding || ed?.stubbed) {
			setInsights(null);
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(
					`/api/automation-bindings/${binding.id}/insights?period=7d`,
					{ credentials: "same-origin" },
				);
				if (res.ok) {
					const json = (await res.json()) as InsightsResponse;
					if (!cancelled) setInsights(json);
				}
			} catch {
				if (!cancelled) setInsights(null);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [binding?.id, ed?.stubbed]);

	const bannerFromResponse = useCallback(async (res: Response) => {
		const body = (await res.json().catch(() => null)) as {
			error?: { message?: string };
			message?: string;
		} | null;
		setBanner({
			type: "error",
			message: body?.error?.message || body?.message || `Error ${res.status}`,
		});
	}, []);

	// A (social_account_id, binding_type) slot is unique — look up any existing
	// row so we can reassign instead of hitting a raw 409.
	const findExistingBinding = useCallback(
		async (acct: string, type: BindingType): Promise<CanvasBindingRow | null> => {
			const url = new URL("/api/automation-bindings", window.location.origin);
			url.searchParams.set("social_account_id", acct);
			url.searchParams.set("binding_type", type);
			const res = await fetch(url.toString(), { credentials: "same-origin" });
			if (!res.ok) return null;
			const json = (await res.json()) as { data?: CanvasBindingRow[] };
			return (json.data ?? []).find((r) => r.binding_type === type) ?? null;
		},
		[],
	);

	const handleCreate = useCallback(async () => {
		if (!ed || !bindingType) return;
		setBanner(null);
		if (!accountId) {
			setBanner({ type: "error", message: "Pick an account to bind." });
			return;
		}
		const validationError = ed.validateConfig(config);
		if (validationError) {
			setBanner({ type: "error", message: validationError });
			return;
		}
		setSaving(true);
		try {
			const existing = await findExistingBinding(accountId, bindingType);
			if (existing) {
				// Same account+type slot already used. Reassign (or no-op) instead
				// of letting the unique constraint 409.
				if (existing.automation_id !== automationId) {
					const ok = window.confirm(
						`${bindingLabel(bindingType)} on ${
							accountLabel ?? "this account"
						} is already bound to another automation. Reassign it to this automation?`,
					);
					if (!ok) {
						setSaving(false);
						return;
					}
				}
				const res = await fetch(`/api/automation-bindings/${existing.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						automation_id: automationId,
						config,
						...(ed.stubbed ? { status: "pending_sync" } : {}),
					}),
				});
				if (!res.ok) {
					await bannerFromResponse(res);
					return;
				}
				setBanner({
					type: "success",
					message:
						existing.automation_id === automationId
							? "Binding updated"
							: "Binding reassigned to this automation",
				});
				onChanged();
				onSelectBindingId(existing.id);
				return;
			}

			const res = await fetch("/api/automation-bindings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					social_account_id: accountId,
					channel,
					binding_type: bindingType,
					automation_id: automationId,
					config,
				}),
			});
			if (!res.ok) {
				await bannerFromResponse(res);
				return;
			}
			const created = (await res.json()) as { id?: string };
			setBanner({ type: "success", message: "Binding created" });
			onChanged();
			if (created?.id) onSelectBindingId(created.id);
		} catch {
			setBanner({ type: "error", message: "Network connection lost." });
		} finally {
			setSaving(false);
		}
	}, [
		ed,
		bindingType,
		accountId,
		accountLabel,
		config,
		channel,
		automationId,
		findExistingBinding,
		bannerFromResponse,
		onChanged,
		onSelectBindingId,
	]);

	const handleSaveConfig = useCallback(async () => {
		if (!binding || !ed) return;
		setBanner(null);
		const validationError = ed.validateConfig(config);
		if (validationError) {
			setBanner({ type: "error", message: validationError });
			return;
		}
		setSaving(true);
		try {
			const res = await fetch(`/api/automation-bindings/${binding.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					config,
					...(ed.stubbed ? { status: "pending_sync" } : {}),
				}),
			});
			if (!res.ok) {
				await bannerFromResponse(res);
				return;
			}
			setBanner({
				type: "success",
				message: ed.stubbed
					? "Saved — will sync to platform in v1.1."
					: "Saved",
			});
			onChanged();
		} catch {
			setBanner({ type: "error", message: "Network connection lost." });
		} finally {
			setSaving(false);
		}
	}, [binding, ed, config, bannerFromResponse, onChanged]);

	const handlePauseResume = useCallback(async () => {
		if (!binding) return;
		setBanner(null);
		setSaving(true);
		try {
			const nextStatus = binding.status === "paused" ? "active" : "paused";
			const res = await fetch(`/api/automation-bindings/${binding.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: nextStatus }),
			});
			if (!res.ok) {
				await bannerFromResponse(res);
				return;
			}
			onChanged();
		} catch {
			setBanner({ type: "error", message: "Network connection lost." });
		} finally {
			setSaving(false);
		}
	}, [binding, bannerFromResponse, onChanged]);

	const handleUnbind = useCallback(async () => {
		if (!binding) return;
		if (
			!window.confirm(
				"Remove this binding? The automation will no longer fire for this surface.",
			)
		) {
			return;
		}
		setBanner(null);
		setSaving(true);
		try {
			const res = await fetch(`/api/automation-bindings/${binding.id}`, {
				method: "DELETE",
			});
			if (res.ok || res.status === 204) {
				onChanged();
				onSelectBindingId(null);
				onClose();
			} else {
				await bannerFromResponse(res);
			}
		} catch {
			setBanner({ type: "error", message: "Network connection lost." });
		} finally {
			setSaving(false);
		}
	}, [binding, bannerFromResponse, onChanged, onSelectBindingId, onClose]);

	if (!ed || !bindingType) return null;

	const enrolled = insights?.totals?.enrolled ?? 0;
	const completed = insights?.totals?.completed ?? 0;
	const completionRate =
		enrolled > 0 ? Math.round((completed / enrolled) * 100) : 0;
	const statusBadge = binding ? bindingStatusBadge(binding.status) : null;

	return (
		<div
			className={cn(
				PANEL_WIDTH_CLS,
				"flex h-full flex-col overflow-hidden border-l border-[#e6e9ef] bg-white shadow-[-12px_0_32px_rgba(15,23,42,0.03)]",
			)}
		>
			<div className="flex shrink-0 items-center justify-between border-b border-[#e6e9ef] bg-[#eef2ff] px-4 py-4">
				<div className="min-w-0 flex-1">
					<h3 className="flex items-center gap-1.5 truncate text-[16px] font-semibold text-[#353a44]">
						<Link2 className="size-4 text-[#4680ff]" />
						{isCreate ? `New ${ed.title}` : ed.title}
					</h3>
					<p className="mt-1 text-[11px] text-[#6f7786]">{ed.subtitle}</p>
				</div>
				<button
					type="button"
					onClick={onClose}
					className="rounded-full p-1 text-[#6f7786] transition hover:bg-white/70 hover:text-[#353a44]"
					aria-label="Close"
				>
					<X className="size-4" />
				</button>
			</div>

			<ScrollArea className="flex-1 bg-[#fbfcfe]">
				<div className="space-y-4 px-4 py-4">
					{banner && (
						<div
							className={cn(
								"rounded-md border px-3 py-2 text-xs",
								banner.type === "error"
									? "border-destructive/30 bg-destructive/10 text-destructive"
									: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
							)}
						>
							{banner.message}
						</div>
					)}

					{/* Account */}
					<div>
						<span className="block text-[11px] font-medium text-muted-foreground">
							Account
						</span>
						{isCreate ? (
							<AccountSearchCombobox
								value={accountId}
								onSelect={setAccountId}
								onSelectAccount={(a) => setAccountLabel(accountOptionLabel(a))}
								platforms={[channel]}
								showAllOption={false}
								placeholder="Choose an account…"
								variant="input"
								className="mt-1"
							/>
						) : (
							<div className="mt-1 flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2">
								<span className="truncate text-sm">
									{bindingAccountHandle(binding)}
								</span>
								{statusBadge && (
									<span
										className={cn(
											"shrink-0 rounded-full border px-1.5 py-0 text-[9px] font-medium",
											statusBadge.cls,
										)}
									>
										{statusBadge.label}
									</span>
								)}
							</div>
						)}
					</div>

					{/* Platform-sync caveat for the stubbed menu surfaces */}
					{ed.stubbed && ed.bannerCopy && (
						<div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
							<span className="font-medium">Platform sync in v1.1. </span>
							{ed.bannerCopy}
						</div>
					)}

					{/* Rich config editor (menu / starters / questions) */}
					{ed.renderEditor && (
						<div className="rounded-md border border-border bg-card/30 p-3">
							{ed.renderEditor(config, setConfig)}
						</div>
					)}

					{/* Insights for an existing live binding */}
					{!isCreate && !ed.stubbed && (
						<div className="grid grid-cols-2 gap-3 rounded-md border border-border/60 bg-background/50 p-3">
							<div>
								<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
									7d runs
								</div>
								<div className="mt-0.5 text-sm font-medium">
									{enrolled.toLocaleString()}
								</div>
							</div>
							<div>
								<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
									Completion
								</div>
								<div className="mt-0.5 text-sm font-medium">
									{enrolled === 0 ? "—" : `${completionRate}%`}
								</div>
							</div>
						</div>
					)}

					{/* Actions */}
					{!readOnly && (
						<div className="flex flex-wrap items-center gap-2">
							{isCreate ? (
								<Button
									size="sm"
									className="h-7 text-xs"
									disabled={saving || !accountId}
									onClick={() => void handleCreate()}
								>
									{saving ? (
										<Loader2 className="size-3.5 animate-spin" />
									) : (
										`Create ${ed.title}`
									)}
								</Button>
							) : (
								<>
									{ed.renderEditor && (
										<Button
											size="sm"
											className="h-7 text-xs"
											disabled={saving}
											onClick={() => void handleSaveConfig()}
										>
											{saving ? (
												<Loader2 className="size-3.5 animate-spin" />
											) : (
												"Save changes"
											)}
										</Button>
									)}
									{!ed.stubbed && (
										<Button
											size="sm"
											variant="outline"
											className="h-7 text-xs"
											disabled={saving}
											onClick={() => void handlePauseResume()}
										>
											{binding.status === "paused" ? "Resume" : "Pause"}
										</Button>
									)}
									<Button
										size="sm"
										variant="outline"
										className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
										disabled={saving}
										onClick={() => void handleUnbind()}
									>
										<Unlink className="size-3" />
										Unbind
									</Button>
								</>
							)}
						</div>
					)}

					{!isCreate && (
						<a
							href={bindingConnectionHref(binding)}
							className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
						>
							<ExternalLink className="size-3" />
							Open on connection page
						</a>
					)}

					{binding?.sync_error && (
						<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
							{binding.sync_error}
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
