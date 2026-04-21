// Shared layout for "simple" per-account bindings (default_reply,
// welcome_message) — Plan 3 Unit C3, Task T2. Stubbed bindings (main_menu,
// conversation_starter, ice_breaker) live in their own files because they
// carry rich nested-config editors.
//
// Responsibilities:
//   - Load the current binding for `(social_account_id, binding_type)` via the
//     /api/automation-bindings list proxy (filtered by both keys).
//   - Render an automation picker + status badge + "Unbind" button.
//   - Load 7d insights via /api/automation-bindings/{id}/insights?period=7d
//     and show runs + completion rate.
//
// Saves route through the create/patch/delete proxies, no SDK or direct
// /v1/* calls (dashboard rule: always use the proxy surface).

import { Loader2, Unlink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AutomationPicker } from "./automation-picker";
import type {
	BindingChannel,
	BindingStatus,
	BindingType,
} from "./types";

interface BindingRow {
	id: string;
	organization_id: string;
	workspace_id: string | null;
	social_account_id: string;
	channel: string;
	binding_type: BindingType;
	automation_id: string;
	status: string;
	last_synced_at: string | null;
	sync_error: string | null;
	created_at: string;
	updated_at: string;
	config: Record<string, unknown> | null;
}

interface ListResponse {
	data: BindingRow[];
}

interface InsightsResponse {
	totals?: {
		enrolled?: number;
		completed?: number;
		exited?: number;
		failed?: number;
	};
}

interface Props {
	socialAccountId: string;
	channel: BindingChannel;
	bindingType: Extract<BindingType, "default_reply" | "welcome_message">;
	title: string;
	subtitle: string;
}

function statusBadge(status: string): { label: string; cls: string } {
	switch (status) {
		case "active":
			return {
				label: "active",
				cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
			};
		case "paused":
			return {
				label: "paused",
				cls: "border-amber-500/30 bg-amber-500/10 text-amber-600",
			};
		case "pending_sync":
			return {
				label: "syncing",
				cls: "border-sky-500/30 bg-sky-500/10 text-sky-600",
			};
		case "sync_failed":
			return {
				label: "sync failed",
				cls: "border-destructive/30 bg-destructive/10 text-destructive",
			};
		default:
			return {
				label: status,
				cls: "border-border bg-muted text-muted-foreground",
			};
	}
}

export function SimpleAutomationBindingTab({
	socialAccountId,
	channel,
	bindingType,
	title,
	subtitle,
}: Props) {
	const [binding, setBinding] = useState<BindingRow | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [banner, setBanner] = useState<{
		type: "error" | "success";
		message: string;
	} | null>(null);
	const [saving, setSaving] = useState(false);

	// 7d insights for an existing binding
	const [insights, setInsights] = useState<InsightsResponse | null>(null);
	const [insightsLoading, setInsightsLoading] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const url = new URL(
				"/api/automation-bindings",
				window.location.origin,
			);
			url.searchParams.set("social_account_id", socialAccountId);
			url.searchParams.set("binding_type", bindingType);
			const res = await fetch(url.toString(), { credentials: "same-origin" });
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				setError(
					body?.error?.message ||
						body?.message ||
						`Error ${res.status}`,
				);
				return;
			}
			const json = (await res.json()) as ListResponse;
			const row = (json.data ?? []).find(
				(r) => r.binding_type === bindingType,
			);
			setBinding(row ?? null);
		} catch {
			setError("Network connection lost.");
		} finally {
			setLoading(false);
		}
	}, [socialAccountId, bindingType]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!binding) {
			setInsights(null);
			return;
		}
		let cancelled = false;
		setInsightsLoading(true);
		(async () => {
			try {
				const res = await fetch(
					`/api/automation-bindings/${binding.id}/insights?period=7d`,
					{ credentials: "same-origin" },
				);
				if (!res.ok) {
					if (!cancelled) setInsights(null);
					return;
				}
				const json = (await res.json()) as InsightsResponse;
				if (!cancelled) setInsights(json);
			} catch {
				if (!cancelled) setInsights(null);
			} finally {
				if (!cancelled) setInsightsLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [binding?.id]);

	const handleBind = useCallback(
		async (automationId: string | null) => {
			setBanner(null);
			if (!automationId) return;
			setSaving(true);
			try {
				if (binding) {
					// Update existing binding's automation_id.
					const res = await fetch(
						`/api/automation-bindings/${binding.id}`,
						{
							method: "PATCH",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ automation_id: automationId }),
						},
					);
					if (!res.ok) {
						const body = await res.json().catch(() => null);
						setBanner({
							type: "error",
							message:
								body?.error?.message ||
								body?.message ||
								`Error ${res.status}`,
						});
						return;
					}
					setBanner({ type: "success", message: "Binding updated" });
				} else {
					const res = await fetch("/api/automation-bindings", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							social_account_id: socialAccountId,
							channel,
							binding_type: bindingType,
							automation_id: automationId,
						}),
					});
					if (!res.ok) {
						const body = await res.json().catch(() => null);
						setBanner({
							type: "error",
							message:
								body?.error?.message ||
								body?.message ||
								`Error ${res.status}`,
						});
						return;
					}
					setBanner({ type: "success", message: "Binding created" });
				}
				await refresh();
			} catch {
				setBanner({ type: "error", message: "Network connection lost." });
			} finally {
				setSaving(false);
			}
		},
		[binding, socialAccountId, channel, bindingType, refresh],
	);

	const handleUnbind = useCallback(async () => {
		if (!binding) return;
		if (!confirm("Remove this binding? The automation will no longer fire.")) {
			return;
		}
		setBanner(null);
		setSaving(true);
		try {
			const res = await fetch(`/api/automation-bindings/${binding.id}`, {
				method: "DELETE",
			});
			if (res.ok || res.status === 204) {
				setBinding(null);
				setBanner({ type: "success", message: "Unbound" });
			} else {
				const body = await res.json().catch(() => null);
				setBanner({
					type: "error",
					message:
						body?.error?.message ||
						body?.message ||
						`Error ${res.status}`,
				});
			}
		} catch {
			setBanner({ type: "error", message: "Network connection lost." });
		} finally {
			setSaving(false);
		}
	}, [binding]);

	const togglePauseResume = useCallback(async () => {
		if (!binding) return;
		setBanner(null);
		setSaving(true);
		try {
			const nextStatus: BindingStatus =
				binding.status === "paused" ? "active" : "paused";
			const res = await fetch(`/api/automation-bindings/${binding.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: nextStatus }),
			});
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				setBanner({
					type: "error",
					message:
						body?.error?.message ||
						body?.message ||
						`Error ${res.status}`,
				});
				return;
			}
			await refresh();
		} catch {
			setBanner({ type: "error", message: "Network connection lost." });
		} finally {
			setSaving(false);
		}
	}, [binding, refresh]);

	const enrolled = insights?.totals?.enrolled ?? 0;
	const completed = insights?.totals?.completed ?? 0;
	const completionRate =
		enrolled > 0 ? Math.round((completed / enrolled) * 100) : 0;

	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-sm font-medium">{title}</h2>
				<p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
			</div>

			{banner && (
				<div
					className={`rounded-md border px-3 py-2 text-xs ${
						banner.type === "error"
							? "border-destructive/30 bg-destructive/10 text-destructive"
							: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
					}`}
				>
					{banner.message}
				</div>
			)}

			{loading ? (
				<div className="flex items-center justify-center py-8">
					<Loader2 className="size-4 animate-spin text-muted-foreground" />
				</div>
			) : error ? (
				<div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					{error}
				</div>
			) : binding ? (
				<div className="rounded-md border border-border bg-card/30 p-3 space-y-3">
					<div className="flex items-center gap-2">
						<span
							className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${
								statusBadge(binding.status).cls
							}`}
						>
							{statusBadge(binding.status).label}
						</span>
						<span className="text-[10px] text-muted-foreground">
							Updated{" "}
							{new Date(binding.updated_at).toLocaleString("en-US", {
								month: "short",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							})}
						</span>
					</div>

					<div>
						<label className="text-[11px] font-medium text-muted-foreground">
							Automation
						</label>
						<AutomationPicker
							channel={channel}
							value={binding.automation_id}
							onChange={(id) => void handleBind(id)}
							disabled={saving}
							className="mt-1"
						/>
					</div>

					<div className="grid grid-cols-2 gap-3 rounded-md border border-border/60 bg-background/50 p-3">
						<div>
							<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
								7d runs
							</div>
							<div className="mt-0.5 text-sm font-medium">
								{insightsLoading ? "…" : enrolled.toLocaleString()}
							</div>
						</div>
						<div>
							<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
								Completion
							</div>
							<div className="mt-0.5 text-sm font-medium">
								{insightsLoading
									? "…"
									: enrolled === 0
										? "—"
										: `${completionRate}%`}
							</div>
						</div>
					</div>

					<div className="flex items-center gap-2">
						<Button
							size="sm"
							variant="outline"
							className="h-7 text-xs"
							disabled={saving}
							onClick={() => void togglePauseResume()}
						>
							{binding.status === "paused" ? "Resume" : "Pause"}
						</Button>
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
						<a
							href={`/app/automation/${binding.automation_id}`}
							className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
						>
							Open automation →
						</a>
					</div>

					{binding.sync_error && (
						<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
							{binding.sync_error}
						</div>
					)}
				</div>
			) : (
				<div className="rounded-md border border-dashed border-border bg-card/30 p-4">
					<p className="text-xs text-muted-foreground">
						Not configured.
					</p>
					<div className="mt-3">
						<label className="text-[11px] font-medium text-muted-foreground">
							Bind an automation
						</label>
						<AutomationPicker
							channel={channel}
							value={null}
							onChange={(id) => void handleBind(id)}
							disabled={saving}
							className="mt-1"
						/>
					</div>
				</div>
			)}
		</div>
	);
}
