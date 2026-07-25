// Shared types and channel-filtering helpers for runtime and provider-synced
// conversation entry surfaces.

export type BindingChannel = "instagram" | "facebook" | "whatsapp" | "telegram";

export type BindingType =
	| "default_reply"
	| "welcome_message"
	| "get_started"
	| "main_menu"
	| "ice_breaker";

export type BindingStatus = "active" | "paused";

export interface BindingTabDescriptor {
	/** Stable URL slug (hyphenated). */
	key: string;
	/** Canonical binding_type for the backend. */
	bindingType: BindingType;
	/** Human-friendly tab label. */
	label: string;
	/** Channels this tab is shown on. */
	channels: readonly BindingChannel[];
}

export const BINDING_TABS: readonly BindingTabDescriptor[] = [
	{
		key: "default-reply",
		bindingType: "default_reply",
		label: "Default Reply",
		channels: ["instagram", "facebook", "whatsapp", "telegram"],
	},
	{
		key: "welcome-message",
		bindingType: "welcome_message",
		label: "Welcome Message",
		channels: ["instagram", "facebook", "whatsapp", "telegram"],
	},
	{
		key: "get-started",
		bindingType: "get_started",
		label: "Get Started",
		channels: ["facebook"],
	},
	{
		key: "main-menu",
		bindingType: "main_menu",
		label: "Main Menu",
		channels: ["instagram", "facebook"],
	},
	{
		key: "ice-breakers",
		bindingType: "ice_breaker",
		label: "Ice Breakers",
		channels: ["instagram"],
	},
];

export function bindingTabsForChannel(
	channel: BindingChannel,
): BindingTabDescriptor[] {
	return BINDING_TABS.filter((tab) => tab.channels.includes(channel));
}

export function findBindingTab(
	key: string | null | undefined,
): BindingTabDescriptor | null {
	if (!key) return null;
	return BINDING_TABS.find((tab) => tab.key === key) ?? null;
}

export function bindingTypeToTabKey(type: BindingType): string {
	const descriptor = BINDING_TABS.find((tab) => tab.bindingType === type);
	if (!descriptor) throw new Error(`Unsupported binding type: ${type}`);
	return descriptor.key;
}
