// Shared shell for stubbed binding tabs (main_menu, conversation_starter,
// ice_breaker) — Plan 3 Unit C3, Tasks T3/T4/T5.
//
// Behaviour:
//   - Loads the existing binding for `(social_account_id, binding_type)`.
//   - Lets the operator pick a linked automation (payloads trigger keyword
//     entrypoints on that automation).
//   - Renders a caller-provided config editor (menu items / starters /
//     questions) and a caller-provided validator.
//   - Saves via /api/automation-bindings with `status = "pending_sync"`.
//   - Shows a sticky "Platform sync in v1.1" banner.
//
// All HTTP goes through the `/api/automation-bindings*` proxy surface per the
// dashboard-app rules.

import { AlertTriangle, Loader2, Unlink } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AutomationPicker } from "./automation-picker";
import type { BindingChannel, BindingType } from "./types";

interface BindingRow {
	id: string;
	social_account_id: string;
	channel: string;
	binding_type: BindingType;
	automation_id: string;
	status: string;
	config: Record<string, unknown> | null;
	updated_at: string;
	sync_error: string | null;
}

interface ListResponse {
	data: BindingRow[];
}

interface Props<Config> {
	socialAccountId: string;
	channel: BindingChannel;
	bindingType: Extract<
		BindingType,
		"main_menu" | "conversation_starter" | "ice_breaker"
	>;
	title: string;
	subtitle: string;
	bannerCopy: string;
	emptyConfig: Config;
	parseConfig: (raw: unknown) => Config;
	validateConfig: (config: Config) => string | null;
	renderEditor: (config: Config, setConfig: (next: Config) => void) => ReactNode;
}

export function StubbedBindingShell<Config>({
	socialAccountId,
	channel,
	bindingType,
	title,
	subtitle,
	bannerCopy,
	emptyConfig,
	parseConfig,
	validateConfig,
	renderEditor,
}: Props<Config>) {
	const [binding, setBinding] = useState<BindingRow | null>(null);
	const [config, setConfig] = useState<Config>(emptyConfig);
	const [automationId, setAutomationId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [banner, setBanner] = useState<{
		type: "error" | "success";
		message: string;
	} | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setLoadError(null);
		try {
			const url = new URL("/api/automation-bindings", window.location.origin);
			url.searchParams.set("social_account_id", socialAccountId);
			url.searchParams.set("binding_type", bindingType);
			const res = await fetch(url.toString(), { credentials: "same-origin" });
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				setLoadError(
					body?.error?.message || body?.message || `Error ${res.status}`,
				);
				return;
			}
			const json = (await res.json()) as ListResponse;
			const row = (json.data ?? []).find((r) => r.binding_type === bindingType);
			if (row) {
				setBinding(row);
				setConfig(parseConfig(row.config));
				setAutomationId(row.automation_id);
			} else {
				setBinding(null);
				setConfig(emptyConfig);
				setAutomationId(null);
			}
		} catch {
			setLoadError("Network connection lost.");
		} finally {
			setLoading(false);
		}
	}, [socialAccountId, bindingType, emptyConfig, parseConfig]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const handleSave = useCallback(async () => {
		setBanner(null);
		if (!automationId) {
			setBanner({
				type: "error",
				message: "Pick an automation to link to this binding first.",
			});
			return;
		}
		const validationError = validateConfig(config);
		if (validationError) {
			setBanner({ type: "error", message: validationError });
			return;
		}
		setSaving(true);
		try {
			if (binding) {
				const res = await fetch(
					`/api/automation-bindings/${binding.id}`,
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							automation_id: automationId,
							config,
							status: "pending_sync",
						}),
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
				setBanner({
					type: "success",
					message: "Saved — will sync to platform in v1.1.",
				});
			} else {
				const res = await fetch("/api/automation-bindings", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						social_account_id: socialAccountId,
						channel,
						binding_type: bindingType,
						automation_id: automationId,
						config,
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
				setBanner({
					type: "success",
					message: "Created — will sync to platform in v1.1.",
				});
			}
			await refresh();
		} catch {
			setBanner({ type: "error", message: "Network connection lost." });
		} finally {
			setSaving(false);
		}
	}, [
		automationId,
		binding,
		channel,
		bindingType,
		config,
		socialAccountId,
		refresh,
		validateConfig,
	]);

	const handleUnbind = useCallback(async () => {
		if (!binding) return;
		if (!confirm("Remove this binding? The configuration will be discarded.")) {
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
				setConfig(emptyConfig);
				setAutomationId(null);
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
	}, [binding, emptyConfig]);

	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-sm font-medium">{title}</h2>
				<p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
			</div>

			<div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
				<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
				<div>
					<div className="font-medium">Platform sync in v1.1</div>
					<p className="mt-0.5 leading-relaxed">{bannerCopy}</p>
				</div>
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
			) : loadError ? (
				<div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					{loadError}
				</div>
			) : (
				<>
					<div className="rounded-md border border-border bg-card/30 p-3">
						<label className="text-[11px] font-medium text-muted-foreground">
							Linked automation
						</label>
						<AutomationPicker
							channel={channel}
							value={automationId}
							onChange={setAutomationId}
							disabled={saving}
							className="mt-1"
						/>
					</div>

					<div className="rounded-md border border-border bg-card/30 p-3">
						{renderEditor(config, setConfig)}
					</div>

					<div className="flex items-center gap-2">
						<Button
							size="sm"
							className="h-7 text-xs"
							disabled={saving}
							onClick={() => void handleSave()}
						>
							{saving ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : binding ? (
								"Save changes"
							) : (
								"Create binding"
							)}
						</Button>
						{binding && (
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
						)}
						{binding && (
							<span className="ml-auto text-[10px] text-muted-foreground">
								Updated{" "}
								{new Date(binding.updated_at).toLocaleString("en-US", {
									month: "short",
									day: "numeric",
									hour: "2-digit",
									minute: "2-digit",
								})}
							</span>
						)}
					</div>

					{binding?.sync_error && (
						<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
							{binding.sync_error}
						</div>
					)}
				</>
			)}
		</div>
	);
}
