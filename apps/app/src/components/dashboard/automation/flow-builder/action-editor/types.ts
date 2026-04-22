// Action-editor types + pure helpers (Plan 2 — Unit B4, Phase O).
//
// Client-side mirror of the backend `ActionSchema` discriminated union in
// `apps/api/src/schemas/automation-actions.ts`. Kept as plain TS types (not
// Zod) so the editor can render over in-progress, partially-filled actions
// without parse errors.

export type OnError = "abort" | "continue";

// -- 22 action types per spec §5.4 -----------------------------------------

export type ActionType =
	// Contact data
	| "tag_add"
	| "tag_remove"
	| "field_set"
	| "field_clear"
	// Segments + subscriptions
	| "segment_add"
	| "segment_remove"
	| "subscribe_list"
	| "unsubscribe_list"
	| "opt_in_channel"
	| "opt_out_channel"
	// Conversation
	| "assign_conversation"
	| "unassign_conversation"
	| "conversation_open"
	| "conversation_close"
	| "conversation_snooze"
	// External
	| "notify_admin"
	| "webhook_out"
	// Automation controls
	| "pause_automations_for_contact"
	| "resume_automations_for_contact"
	// Destructive
	| "delete_contact"
	// Conversion
	| "log_conversion_event"
	// v1.1 stubs
	| "change_main_menu";

export type SubscriptionChannel =
	| "instagram"
	| "facebook"
	| "whatsapp"
	| "telegram";

export type WebhookMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type WebhookAuthMode = "none" | "bearer" | "basic" | "hmac";

export interface WebhookAuth {
	mode: WebhookAuthMode;
	token?: string;
	username?: string;
	password?: string;
	secret?: string;
}

export type Scope = "current" | "global";

// -- Action shapes ---------------------------------------------------------

interface BaseAction {
	id: string;
	on_error?: OnError;
}

export interface TagAddAction extends BaseAction {
	type: "tag_add";
	tag: string;
}
export interface TagRemoveAction extends BaseAction {
	type: "tag_remove";
	tag: string;
}

export interface FieldSetAction extends BaseAction {
	type: "field_set";
	field: string;
	value: string;
}
export interface FieldClearAction extends BaseAction {
	type: "field_clear";
	field: string;
}

export interface SegmentAddAction extends BaseAction {
	type: "segment_add";
	segment_id: string;
}
export interface SegmentRemoveAction extends BaseAction {
	type: "segment_remove";
	segment_id: string;
}

export interface SubscribeListAction extends BaseAction {
	type: "subscribe_list";
	list_id: string;
}
export interface UnsubscribeListAction extends BaseAction {
	type: "unsubscribe_list";
	list_id: string;
}

export interface OptInChannelAction extends BaseAction {
	type: "opt_in_channel";
	channel: SubscriptionChannel;
}
export interface OptOutChannelAction extends BaseAction {
	type: "opt_out_channel";
	channel: SubscriptionChannel;
}

export interface AssignConversationAction extends BaseAction {
	type: "assign_conversation";
	user_id: string;
}
export interface UnassignConversationAction extends BaseAction {
	type: "unassign_conversation";
}
export interface ConversationOpenAction extends BaseAction {
	type: "conversation_open";
}
export interface ConversationCloseAction extends BaseAction {
	type: "conversation_close";
}
export interface ConversationSnoozeAction extends BaseAction {
	type: "conversation_snooze";
	snooze_minutes: number;
}

export interface NotifyAdminAction extends BaseAction {
	type: "notify_admin";
	title: string;
	body: string;
	link?: string;
	recipient_user_ids?: string[];
}

export interface WebhookOutAction extends BaseAction {
	type: "webhook_out";
	url: string;
	method: WebhookMethod;
	headers: Record<string, string>;
	body?: string;
	auth: WebhookAuth;
}

export interface PauseAutomationsForContactAction extends BaseAction {
	type: "pause_automations_for_contact";
	scope: Scope;
	duration_min?: number;
	reason?: string;
}
export interface ResumeAutomationsForContactAction extends BaseAction {
	type: "resume_automations_for_contact";
	scope: Scope;
}

export interface DeleteContactAction extends BaseAction {
	type: "delete_contact";
	confirm: true;
}

export interface LogConversionEventAction extends BaseAction {
	type: "log_conversion_event";
	event_name: string;
	value?: string;
	currency?: string;
}

export interface ChangeMainMenuAction extends BaseAction {
	type: "change_main_menu";
	menu_payload?: unknown;
}

export type Action =
	| TagAddAction
	| TagRemoveAction
	| FieldSetAction
	| FieldClearAction
	| SegmentAddAction
	| SegmentRemoveAction
	| SubscribeListAction
	| UnsubscribeListAction
	| OptInChannelAction
	| OptOutChannelAction
	| AssignConversationAction
	| UnassignConversationAction
	| ConversationOpenAction
	| ConversationCloseAction
	| ConversationSnoozeAction
	| NotifyAdminAction
	| WebhookOutAction
	| PauseAutomationsForContactAction
	| ResumeAutomationsForContactAction
	| DeleteContactAction
	| LogConversionEventAction
	| ChangeMainMenuAction;

export interface ActionGroupConfig {
	actions: Action[];
}

// -- Action catalog (for dropdown grouping + labels) -----------------------

export interface ActionCatalogEntry {
	type: ActionType;
	label: string;
	category: ActionCategory;
}

export type ActionCategory =
	| "contact_data"
	| "subscriptions"
	| "conversation"
	| "external"
	| "automation_controls"
	| "destructive"
	| "conversion"
	| "v1_1_stubs";

export const ACTION_CATEGORIES: Array<{
	key: ActionCategory;
	label: string;
}> = [
	{ key: "contact_data", label: "Contact data" },
	{ key: "subscriptions", label: "Subscriptions" },
	{ key: "conversation", label: "Conversation" },
	{ key: "external", label: "External" },
	{ key: "automation_controls", label: "Automation controls" },
	{ key: "conversion", label: "Conversion" },
	{ key: "destructive", label: "Destructive" },
	{ key: "v1_1_stubs", label: "Coming in v1.1" },
];

/** Hard-coded fallback when the live catalog isn't available yet. */
export const FALLBACK_ACTION_CATALOG: ActionCatalogEntry[] = [
	{ type: "tag_add", label: "Add tag", category: "contact_data" },
	{ type: "tag_remove", label: "Remove tag", category: "contact_data" },
	{ type: "field_set", label: "Set field", category: "contact_data" },
	{ type: "field_clear", label: "Clear field", category: "contact_data" },
	{ type: "segment_add", label: "Add to segment", category: "subscriptions" },
	{
		type: "segment_remove",
		label: "Remove from segment",
		category: "subscriptions",
	},
	{
		type: "subscribe_list",
		label: "Subscribe to list",
		category: "subscriptions",
	},
	{
		type: "unsubscribe_list",
		label: "Unsubscribe from list",
		category: "subscriptions",
	},
	{
		type: "opt_in_channel",
		label: "Opt in to channel",
		category: "subscriptions",
	},
	{
		type: "opt_out_channel",
		label: "Opt out of channel",
		category: "subscriptions",
	},
	{
		type: "assign_conversation",
		label: "Assign conversation",
		category: "conversation",
	},
	{
		type: "unassign_conversation",
		label: "Unassign conversation",
		category: "conversation",
	},
	{
		type: "conversation_open",
		label: "Open conversation",
		category: "conversation",
	},
	{
		type: "conversation_close",
		label: "Close conversation",
		category: "conversation",
	},
	{
		type: "conversation_snooze",
		label: "Snooze conversation",
		category: "conversation",
	},
	{ type: "notify_admin", label: "Notify admin", category: "external" },
	{ type: "webhook_out", label: "Call webhook", category: "external" },
	{
		type: "pause_automations_for_contact",
		label: "Pause contact automations",
		category: "automation_controls",
	},
	{
		type: "resume_automations_for_contact",
		label: "Resume contact automations",
		category: "automation_controls",
	},
	{
		type: "delete_contact",
		label: "Delete contact",
		category: "destructive",
	},
	{
		type: "log_conversion_event",
		label: "Log conversion event",
		category: "conversion",
	},
	{
		type: "change_main_menu",
		label: "Change main menu",
		category: "v1_1_stubs",
	},
];

// -- id factory -----------------------------------------------------------

const ID_ALPHABET =
	"23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** 8-char opaque id, matches the node-key / block-id generator style. */
export function generateActionId(): string {
	if (
		typeof globalThis.crypto !== "undefined" &&
		typeof globalThis.crypto.getRandomValues === "function"
	) {
		const buf = new Uint8Array(8);
		globalThis.crypto.getRandomValues(buf);
		let out = "";
		for (let i = 0; i < buf.length; i++) {
			out += ID_ALPHABET[buf[i]! % ID_ALPHABET.length];
		}
		return out;
	}
	return Math.random().toString(36).slice(2, 10);
}

// -- Factories -------------------------------------------------------------

/**
 * Return a sensible default action payload for the given type. The caller is
 * responsible for allocating an `id`; pass `existingId` to reuse (e.g. when
 * swapping an action's type without losing its row position).
 */
export function defaultActionFor(
	type: ActionType,
	existingId?: string,
): Action {
	const id = existingId ?? generateActionId();
	const on_error: OnError = "abort";
	switch (type) {
		case "tag_add":
		case "tag_remove":
			return { id, type, on_error, tag: "" };
		case "field_set":
			return { id, type, on_error, field: "", value: "" };
		case "field_clear":
			return { id, type, on_error, field: "" };
		case "segment_add":
		case "segment_remove":
			return { id, type, on_error, segment_id: "" };
		case "subscribe_list":
		case "unsubscribe_list":
			return { id, type, on_error, list_id: "" };
		case "opt_in_channel":
		case "opt_out_channel":
			return { id, type, on_error, channel: "instagram" };
		case "assign_conversation":
			return { id, type, on_error, user_id: "" };
		case "unassign_conversation":
		case "conversation_open":
		case "conversation_close":
			return { id, type, on_error };
		case "conversation_snooze":
			return { id, type, on_error, snooze_minutes: 60 };
		case "notify_admin":
			return {
				id,
				type,
				on_error,
				title: "",
				body: "",
			};
		case "webhook_out":
			return {
				id,
				type,
				on_error,
				url: "",
				method: "POST",
				headers: {},
				auth: { mode: "none" },
			};
		case "pause_automations_for_contact":
			return { id, type, on_error, scope: "current" };
		case "resume_automations_for_contact":
			return { id, type, on_error, scope: "current" };
		case "delete_contact":
			return { id, type, on_error, confirm: true };
		case "log_conversion_event":
			return { id, type, on_error, event_name: "" };
		case "change_main_menu":
			return { id, type, on_error };
	}
}

// -- Pure helpers ---------------------------------------------------------

/** Move an element of an array from one index to another (returns a copy). */
export function reorder<T>(list: T[], from: number, to: number): T[] {
	if (from === to || from < 0 || from >= list.length) return list;
	const bounded = Math.max(0, Math.min(list.length - 1, to));
	const copy = list.slice();
	const [item] = copy.splice(from, 1);
	if (!item) return list;
	copy.splice(bounded, 0, item);
	return copy;
}

/**
 * Short, readable summary of an action — shown in the action-list row when
 * the form is collapsed. Never throws; always returns a string.
 */
export function summarizeAction(action: Action): string {
	switch (action.type) {
		case "tag_add":
			return action.tag ? `Add tag "${action.tag}"` : "Add tag";
		case "tag_remove":
			return action.tag ? `Remove tag "${action.tag}"` : "Remove tag";
		case "field_set":
			return action.field
				? `Set ${action.field}${action.value ? ` = ${truncate(action.value, 32)}` : ""}`
				: "Set field";
		case "field_clear":
			return action.field ? `Clear ${action.field}` : "Clear field";
		case "segment_add":
			return action.segment_id
				? `Add to segment ${short(action.segment_id)}`
				: "Add to segment";
		case "segment_remove":
			return action.segment_id
				? `Remove from segment ${short(action.segment_id)}`
				: "Remove from segment";
		case "subscribe_list":
			return action.list_id
				? `Subscribe to list ${short(action.list_id)}`
				: "Subscribe to list";
		case "unsubscribe_list":
			return action.list_id
				? `Unsubscribe from list ${short(action.list_id)}`
				: "Unsubscribe from list";
		case "opt_in_channel":
			return `Opt in to ${action.channel}`;
		case "opt_out_channel":
			return `Opt out of ${action.channel}`;
		case "assign_conversation": {
			if (!action.user_id) return "Assign conversation";
			if (action.user_id === "round_robin") return "Assign round-robin";
			if (action.user_id === "unassigned") return "Unassign conversation";
			return `Assign to ${short(action.user_id)}`;
		}
		case "unassign_conversation":
			return "Unassign conversation";
		case "conversation_open":
			return "Open conversation";
		case "conversation_close":
			return "Close conversation";
		case "conversation_snooze":
			return `Snooze ${action.snooze_minutes}m`;
		case "notify_admin":
			return action.title
				? `Notify admin: ${truncate(action.title, 32)}`
				: "Notify admin";
		case "webhook_out":
			return action.url
				? `${action.method} ${truncate(action.url, 40)}`
				: "Call webhook";
		case "pause_automations_for_contact":
			return action.scope === "global"
				? "Pause all automations for contact"
				: "Pause this automation for contact";
		case "resume_automations_for_contact":
			return action.scope === "global"
				? "Resume all automations for contact"
				: "Resume this automation for contact";
		case "delete_contact":
			return "Delete contact";
		case "log_conversion_event":
			return action.event_name
				? `Log "${action.event_name}"${action.value ? ` (${action.value})` : ""}`
				: "Log conversion event";
		case "change_main_menu":
			return "Change main menu (v1.1)";
	}
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}

function short(id: string): string {
	return id.length > 10 ? id.slice(0, 8) + "…" : id;
}

// -- Validation ------------------------------------------------------------

export type ValidationProblem = { path: string; message: string };

/**
 * Pure validation for a single action. Returns an array of problems; empty
 * means valid. Mirrors the server's Zod rules but stays forgiving for
 * in-progress edits — we still surface missing required fields so the row
 * can show a "needs attention" affordance.
 */
export function validateAction(action: Action): ValidationProblem[] {
	const problems: ValidationProblem[] = [];
	switch (action.type) {
		case "tag_add":
		case "tag_remove":
			if (!action.tag.trim()) {
				problems.push({ path: "tag", message: "Tag name is required." });
			}
			break;
		case "field_set":
			if (!action.field.trim())
				problems.push({ path: "field", message: "Field key is required." });
			if (!action.value.trim())
				problems.push({ path: "value", message: "Value is required." });
			break;
		case "field_clear":
			if (!action.field.trim())
				problems.push({ path: "field", message: "Field key is required." });
			break;
		case "segment_add":
		case "segment_remove":
			if (!action.segment_id.trim())
				problems.push({ path: "segment_id", message: "Segment is required." });
			break;
		case "subscribe_list":
		case "unsubscribe_list":
			if (!action.list_id.trim())
				problems.push({ path: "list_id", message: "List is required." });
			break;
		case "assign_conversation":
			if (!action.user_id.trim())
				problems.push({
					path: "user_id",
					message: "Pick a user, round-robin, or unassigned.",
				});
			break;
		case "conversation_snooze":
			if (!Number.isFinite(action.snooze_minutes) || action.snooze_minutes < 1)
				problems.push({
					path: "snooze_minutes",
					message: "Snooze must be at least 1 minute.",
				});
			break;
		case "notify_admin":
			if (!action.title.trim())
				problems.push({ path: "title", message: "Title is required." });
			if (!action.body.trim())
				problems.push({ path: "body", message: "Body is required." });
			break;
		case "webhook_out":
			if (!action.url.trim()) {
				problems.push({ path: "url", message: "URL is required." });
			} else if (!/^https?:\/\//i.test(action.url)) {
				problems.push({
					path: "url",
					message: "URL must start with http:// or https://.",
				});
			}
			if (action.auth.mode === "bearer" && !action.auth.token?.trim())
				problems.push({
					path: "auth.token",
					message: "Bearer token is required.",
				});
			if (
				action.auth.mode === "basic" &&
				(!action.auth.username?.trim() || !action.auth.password?.trim())
			)
				problems.push({
					path: "auth",
					message: "Username and password are required for basic auth.",
				});
			if (action.auth.mode === "hmac" && !action.auth.secret?.trim())
				problems.push({
					path: "auth.secret",
					message: "HMAC secret is required.",
				});
			break;
		case "pause_automations_for_contact":
			if (
				action.duration_min !== undefined &&
				(!Number.isFinite(action.duration_min) || action.duration_min < 0)
			)
				problems.push({
					path: "duration_min",
					message: "Duration must be a positive number.",
				});
			break;
		case "log_conversion_event":
			if (!action.event_name.trim())
				problems.push({
					path: "event_name",
					message: "Event name is required.",
				});
			break;
		case "delete_contact":
			if (action.confirm !== true)
				problems.push({
					path: "confirm",
					message: "Confirmation is required.",
				});
			break;
		// No required fields — opt_*_channel / unassign / conversation_open/close /
		// resume / change_main_menu.
		default:
			break;
	}
	return problems;
}
