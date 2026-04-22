// Shared types + channel-filtering helpers for the per-account bindings tab
// (Plan 3 — Unit C3, Task T1). Spec §6.4 governs the channel matrix.
//
// These helpers are pure so they can be unit-tested in isolation — the UI
// components import them directly.

export type BindingChannel =
	| "instagram"
	| "facebook"
	| "whatsapp"
	| "telegram";

export type BindingType =
	| "default_reply"
	| "welcome_message"
	| "main_menu"
	| "conversation_starter"
	| "ice_breaker";

export type BindingStatus = "active" | "paused" | "pending_sync" | "sync_failed";

export interface BindingTabDescriptor {
	/** Stable URL slug (hyphenated). */
	key: string;
	/** Canonical binding_type for the backend. */
	bindingType: BindingType;
	/** Human-friendly tab label. */
	label: string;
	/** Channels this tab is shown on. */
	channels: readonly BindingChannel[];
	/** Stubbed bindings show a "Platform sync in v1.1" banner. */
	stubbed: boolean;
}

export const BINDING_TABS: readonly BindingTabDescriptor[] = [
	{
		key: "default-reply",
		bindingType: "default_reply",
		label: "Default Reply",
		channels: ["instagram", "facebook", "whatsapp", "telegram"],
		stubbed: false,
	},
	{
		key: "welcome-message",
		bindingType: "welcome_message",
		label: "Welcome Message",
		channels: ["instagram", "facebook", "whatsapp", "telegram"],
		stubbed: false,
	},
	{
		key: "main-menu",
		bindingType: "main_menu",
		label: "Main Menu",
		channels: ["facebook", "instagram"],
		stubbed: true,
	},
	{
		key: "conversation-starter",
		bindingType: "conversation_starter",
		label: "Conversation Starter",
		channels: ["facebook"],
		stubbed: true,
	},
	{
		key: "ice-breaker",
		bindingType: "ice_breaker",
		label: "Ice Breaker",
		channels: ["whatsapp"],
		stubbed: true,
	},
];

/**
 * Returns the tab descriptors that apply to a given channel, preserving the
 * canonical order defined in `BINDING_TABS`.
 */
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
	return type.replace(/_/g, "-");
}

// ---------------------------------------------------------------------------
// Validation helpers for the stubbed bindings' config payloads. Kept pure for
// straightforward unit-testing.
// ---------------------------------------------------------------------------

export const MAIN_MENU_LABEL_MAX = 30;
export const MAIN_MENU_MAX_TOP_LEVEL_ITEMS = 3;
export const MAIN_MENU_MAX_DEPTH = 3;

export const STARTER_LABEL_MAX = 30;
export const STARTER_MAX_ITEMS = 4;

export const ICE_BREAKER_QUESTION_MAX = 80;
export const ICE_BREAKER_MAX_ITEMS = 4;

export interface MainMenuItem {
	label: string;
	action: "postback" | "url";
	payload: string;
	sub_items?: MainMenuItem[];
}

/**
 * Validates a main-menu tree. Returns null on success, or the first validation
 * error message. Depth is 1-indexed (top-level items are depth 1).
 */
export function validateMainMenuItems(
	items: MainMenuItem[],
	depth = 1,
): string | null {
	if (depth === 1 && items.length > MAIN_MENU_MAX_TOP_LEVEL_ITEMS) {
		return `Main menu allows at most ${MAIN_MENU_MAX_TOP_LEVEL_ITEMS} top-level items.`;
	}
	if (depth > MAIN_MENU_MAX_DEPTH) {
		return `Main menu items cannot be nested more than ${MAIN_MENU_MAX_DEPTH} levels deep.`;
	}
	for (const item of items) {
		if (!item.label || !item.label.trim()) {
			return "Every menu item needs a label.";
		}
		if (item.label.length > MAIN_MENU_LABEL_MAX) {
			return `Menu labels must be ${MAIN_MENU_LABEL_MAX} characters or fewer.`;
		}
		if (item.action !== "postback" && item.action !== "url") {
			return "Menu item action must be postback or url.";
		}
		if (!item.payload || !item.payload.trim()) {
			return "Every menu item needs a payload.";
		}
		if (item.sub_items && item.sub_items.length > 0) {
			const nestedError = validateMainMenuItems(item.sub_items, depth + 1);
			if (nestedError) return nestedError;
		}
	}
	return null;
}

export interface ConversationStarter {
	label: string;
	payload: string;
}

export function validateConversationStarters(
	starters: ConversationStarter[],
): string | null {
	if (starters.length > STARTER_MAX_ITEMS) {
		return `Conversation starters allow at most ${STARTER_MAX_ITEMS} items.`;
	}
	for (const s of starters) {
		if (!s.label || !s.label.trim()) return "Every starter needs a label.";
		if (s.label.length > STARTER_LABEL_MAX) {
			return `Starter labels must be ${STARTER_LABEL_MAX} characters or fewer.`;
		}
		if (!s.payload || !s.payload.trim()) {
			return "Every starter needs a payload.";
		}
	}
	return null;
}

export interface IceBreakerQuestion {
	question: string;
	payload: string;
}

export function validateIceBreakers(
	questions: IceBreakerQuestion[],
): string | null {
	if (questions.length > ICE_BREAKER_MAX_ITEMS) {
		return `Ice breakers allow at most ${ICE_BREAKER_MAX_ITEMS} items.`;
	}
	for (const q of questions) {
		if (!q.question || !q.question.trim()) {
			return "Every ice breaker needs a question.";
		}
		if (q.question.length > ICE_BREAKER_QUESTION_MAX) {
			return `Ice breaker questions must be ${ICE_BREAKER_QUESTION_MAX} characters or fewer.`;
		}
		if (!q.payload || !q.payload.trim()) {
			return "Every ice breaker needs a payload.";
		}
	}
	return null;
}
