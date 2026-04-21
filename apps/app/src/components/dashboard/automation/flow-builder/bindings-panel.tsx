// Bindings panel (Plan 3 — Unit C1, Task R4).
//
// Informational only. Lists the per-account bindings this automation is
// attached to. Editing bindings happens on the per-account Connections page
// (Unit C3). If zero bindings, shows a friendly empty state.

import { ExternalLink, Link2, Loader2, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApi } from "@/hooks/use-api";

// ---------------------------------------------------------------------------
// Types — mirror SDK AutomationBindingResponse
// ---------------------------------------------------------------------------

type AutomationBindingType =
	| "default_reply"
	| "welcome_message"
	| "conversation_starter"
	| "main_menu"
	| "ice_breaker";

interface BindingRow {
	id: string;
	organization_id: string;
	workspace_id: string | null;
	social_account_id: string;
	channel: string;
	binding_type: AutomationBindingType;
	automation_id: string;
	config: Record<string, unknown> | null;
	status: string;
	last_synced_at: string | null;
	sync_error: string | null;
	created_at: string;
	updated_at: string;
	// Optional hydration — not guaranteed, surfaced if the API includes it.
	social_account?: {
		id: string;
		handle?: string | null;
		display_name?: string | null;
	} | null;
}

interface BindingListResponse {
	data: BindingRow[];
}

interface Props {
	automationId: string;
	onClose: () => void;
}

const BINDING_LABELS: Record<AutomationBindingType, string> = {
	default_reply: "Default reply",
	welcome_message: "Welcome message",
	conversation_starter: "Conversation starter",
	main_menu: "Main menu",
	ice_breaker: "Ice breaker",
};

function bindingTabSlug(type: AutomationBindingType): string {
	return type.replace(/_/g, "-");
}

function accountHandle(row: BindingRow): string {
	const handle = row.social_account?.handle;
	if (handle) return handle.startsWith("@") ? handle : `@${handle}`;
	const display = row.social_account?.display_name;
	if (display) return display;
	// Fall back to last 6 chars of the id.
	return row.social_account_id.slice(-6);
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

export function BindingsPanel({ automationId, onClose }: Props) {
	const { data, loading, error } = useApi<BindingListResponse>(
		"automation-bindings",
		{ query: { automation_id: automationId } },
	);

	const rows = data?.data ?? [];

	return (
		<div className="w-80 border-l border-border bg-card/30 flex flex-col overflow-hidden">
			<div className="px-3 py-2 border-b border-border flex items-center justify-between">
				<div>
					<h3 className="text-xs font-medium flex items-center gap-1.5">
						<Link2 className="size-3.5" />
						Bindings
					</h3>
					<p className="text-[10px] text-muted-foreground mt-0.5">
						Accounts where this automation is attached
					</p>
				</div>
				<button
					type="button"
					onClick={onClose}
					className="text-muted-foreground hover:text-foreground"
				>
					<X className="size-3.5" />
				</button>
			</div>

			<ScrollArea className="flex-1">
				<div className="px-3 py-3 space-y-2">
					{loading ? (
						<div className="flex justify-center py-8">
							<Loader2 className="size-4 animate-spin text-muted-foreground" />
						</div>
					) : error ? (
						<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
							{error}
						</div>
					) : rows.length === 0 ? (
						<div className="rounded-md border border-border/60 bg-card/50 px-3 py-4 text-[11px] text-muted-foreground">
							This automation is not bound to any account yet. Bindings are
							configured per-account on the Connections page.
						</div>
					) : (
						rows.map((row) => {
							const badge = statusBadge(row.status);
							return (
								<div
									key={row.id}
									className="rounded-md border border-border bg-background/80 px-3 py-2 space-y-2"
								>
									<div className="flex items-start justify-between gap-2">
										<div className="min-w-0">
											<div className="text-[11px] font-medium">
												{BINDING_LABELS[row.binding_type] ??
													row.binding_type}
											</div>
											<div className="text-[10px] text-muted-foreground truncate">
												{row.channel} · {accountHandle(row)}
											</div>
										</div>
										<span
											className={`shrink-0 rounded-full border px-1.5 py-0 text-[9px] font-medium ${badge.cls}`}
										>
											{badge.label}
										</span>
									</div>
									<a
										href={`/app/connections/${row.social_account_id}?tab=${bindingTabSlug(row.binding_type)}`}
										className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-foreground hover:bg-accent"
									>
										<ExternalLink className="size-3" />
										Manage in account
									</a>
									{row.sync_error && (
										<div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
											{row.sync_error}
										</div>
									)}
								</div>
							);
						})
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
