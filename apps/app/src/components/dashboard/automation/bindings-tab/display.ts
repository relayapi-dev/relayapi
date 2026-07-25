// Shared display helpers for bindings, reused by the per-account Connections
// tabs, the canvas trigger "When…" node, and the canvas binding detail panel.
//
// Pure (no JSX) so they can be imported anywhere without pulling in React.

import { BINDING_TABS, type BindingType, bindingTypeToTabKey } from "./types";

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
	/** Responses stay open-ended so unsupported legacy rows can be removed. */
	binding_type: string;
	automation_id: string;
	config: Record<string, unknown> | null;
	status: string;
	desired_active?: boolean;
	delete_after_sync?: boolean;
	sync_revision?: number;
	last_synced_revision?: number;
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
export function isSupportedBindingType(type: string): type is BindingType {
	return BINDING_TABS.some((tab) => tab.bindingType === type);
}

export function bindingLabel(type: string): string {
	return (
		BINDING_TABS.find((tab) => tab.bindingType === type)?.label ??
		`Legacy binding (${type})`
	);
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
	if (!isSupportedBindingType(binding.binding_type)) {
		return `/app/connections/${binding.social_account_id}`;
	}
	return `/app/connections/${binding.social_account_id}?tab=${bindingTabSlug(
		binding.binding_type,
	)}`;
}

/** Tailwind classes + label for a binding status pill. */
export function bindingStatusBadge(status: string): {
	label: string;
	cls: string;
} {
	// Monochrome pills — the label carries the state.
	const neutral = "border-[#e6e9ef] bg-[#f4f5f7] text-[#5a6373]";
	switch (status) {
		case "active":
			return { label: "active", cls: neutral };
		case "paused":
			return { label: "paused", cls: neutral };
		case "pending_sync":
			return { label: "syncing", cls: neutral };
		case "sync_failed":
			return { label: "sync failed", cls: neutral };
		default:
			return { label: status.replace(/_/g, " "), cls: neutral };
	}
}
