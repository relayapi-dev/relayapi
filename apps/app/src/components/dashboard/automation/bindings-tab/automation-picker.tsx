// Automation picker for the per-account binding tabs (Plan 3 — Unit C3).
//
// Calls `/api/automations?channel={channel}&status=active&limit=50` so the
// operator picks an already-active flow that targets this account's channel.
// Pure client-side search/filter; no autocomplete server round-trip.

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BindingChannel } from "./types";

interface AutomationOption {
	id: string;
	name: string;
	status: "draft" | "active" | "paused" | "archived";
	channel: string;
}

interface ListResponse {
	data: AutomationOption[];
	has_more: boolean;
}

interface Props {
	channel: BindingChannel;
	value: string | null;
	onChange: (automationId: string | null) => void;
	/** Allow an empty "unbind" option in the list. */
	allowClear?: boolean;
	/** Pass `status=draft,active,paused` etc — defaults to active. */
	statusFilter?: string;
	disabled?: boolean;
	className?: string;
}

export function AutomationPicker({
	channel,
	value,
	onChange,
	allowClear = false,
	statusFilter = "active",
	disabled = false,
	className,
}: Props) {
	const [options, setOptions] = useState<AutomationOption[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		(async () => {
			try {
				const url = new URL("/api/automations", window.location.origin);
				url.searchParams.set("channel", channel);
				url.searchParams.set("status", statusFilter);
				url.searchParams.set("limit", "50");
				const res = await fetch(url.toString(), {
					credentials: "same-origin",
				});
				if (!res.ok) {
					const body = await res.json().catch(() => null);
					if (!cancelled)
						setError(
							body?.error?.message ||
								body?.message ||
								`Error ${res.status}`,
						);
					return;
				}
				const json = (await res.json()) as ListResponse;
				if (!cancelled) setOptions(json.data ?? []);
			} catch {
				if (!cancelled) setError("Network connection lost.");
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [channel, statusFilter]);

	// If the currently-selected automation isn't in the list (e.g. it got
	// paused / archived after binding), still render it as a placeholder so
	// the operator isn't confused that the field "reset".
	const mergedOptions = useMemo(() => {
		if (value && !options.some((o) => o.id === value)) {
			return [
				{
					id: value,
					name: "(automation not in current filter)",
					status: "draft" as const,
					channel,
				},
				...options,
			];
		}
		return options;
	}, [options, value, channel]);

	return (
		<div className={className}>
			<select
				value={value ?? ""}
				disabled={disabled || loading}
				onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
				className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
			>
				{allowClear && <option value="">— None —</option>}
				{!allowClear && !value && (
					<option value="" disabled>
						Choose an automation…
					</option>
				)}
				{mergedOptions.map((o) => (
					<option key={o.id} value={o.id}>
						{o.name}
						{o.status !== "active" ? ` (${o.status})` : ""}
					</option>
				))}
			</select>
			<div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
				{loading ? (
					<>
						<Loader2 className="size-3 animate-spin" />
						Loading automations…
					</>
				) : error ? (
					<span className="text-destructive">{error}</span>
				) : options.length === 0 ? (
					<span>
						No {statusFilter === "active" ? "active " : ""}automations on this
						channel yet. Create one first from the Automations page.
					</span>
				) : (
					<span>{options.length} available</span>
				)}
			</div>
		</div>
	);
}
