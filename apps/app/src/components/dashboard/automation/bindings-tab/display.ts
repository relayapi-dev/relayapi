// Shared display helpers for bindings, reused by the per-account Connections
// tabs, the canvas trigger "When…" node, and the canvas binding detail panel.
//
// Pure (no JSX) so they can be imported anywhere without pulling in React.

import { BINDING_TABS, bindingTypeToTabKey, type BindingType } from "./types";

/**
 * The binding shape both canvas surfaces consume. Mirrors the API/SDK
 * `AutomationBindingResponse`, including the optional `social_account`
 * hydration the list/retrieve endpoints now return.
 */
export interface CanvasBindingRow {
	id: string;
	organization_id?: string;
	workspace_id?: string | null;
	social_account_id: string;
	channel: string;
	binding_type: BindingType;
	automation_id: string;
	config: Record<string, unknown> | null;
	status: string;
	last_synced_at?: string | null;
	sync_error: string | null;
	created_at?: string;
	updated_at: string;
	social_account?: {
		id: string;
		handle: string | null;
		display_name: string | null;
		avatar_url: string | null;
	} | null;
}

/** Canonical, title-cased label for a binding type (e.g. "Welcome Message"). */
export function bindingLabel(type: BindingType): string {
	return BINDING_TABS.find((t) => t.bindingType === type)?.label ?? type;
}

/** Hyphenated URL slug for the per-account Connections tab of a binding type. */
export function bindingTabSlug(type: BindingType): string {
	return bindingTypeToTabKey(type);
}

/**
 * Best-effort human handle for the account a binding targets. Prefers the
 * hydrated `@handle`, then the display name, and finally a short id suffix.
 */
export function bindingAccountHandle(
	binding: Pick<CanvasBindingRow, "social_account_id" | "social_account">,
): string {
	const handle = binding.social_account?.handle;
	if (handle) return handle.startsWith("@") ? handle : `@${handle}`;
	const display = binding.social_account?.display_name;
	if (display) return display;
	return binding.social_account_id.slice(-6);
}

/** Deep-link to the per-account Connections page tab for a binding. */
export function bindingConnectionHref(binding: CanvasBindingRow): string {
	return `/app/connections/${binding.social_account_id}?tab=${bindingTabSlug(
		binding.binding_type,
	)}`;
}

/** Tailwind classes + label for a binding status pill. */
export function bindingStatusBadge(status: string): {
	label: string;
	cls: string;
} {
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
