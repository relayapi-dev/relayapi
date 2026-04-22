// apps/api/src/routes/_automation-catalog.ts
//
// Static catalog payload returned from GET /v1/automations/catalog.
// Caches a single response + ETag in module scope so the route is a cheap
// map lookup + conditional-GET check (spec §9.7).

// ---------------------------------------------------------------------------
// Source data
// ---------------------------------------------------------------------------

const NODE_KINDS = [
	{
		kind: "message",
		label: "Message",
		category: "content",
		description:
			"Send a rich message with blocks and interactive elements (buttons, quick replies)",
	},
	{
		kind: "input",
		label: "Input",
		category: "content",
		description:
			"Wait for a user reply and capture it into the run context",
	},
	{
		kind: "delay",
		label: "Delay",
		category: "content",
		description: "Pause the flow for a duration before the next step",
	},
	{
		kind: "condition",
		label: "Condition",
		category: "logic",
		description:
			"Branch on a filter-group expression over contact, tags, fields, or context",
	},
	{
		kind: "randomizer",
		label: "Randomizer",
		category: "logic",
		description: "Split traffic across weighted variants for A/B tests",
	},
	{
		kind: "action_group",
		label: "Action group",
		category: "actions",
		description:
			"Run a sequence of side-effect actions (tag, field, segment, notify, webhook)",
	},
	{
		kind: "http_request",
		label: "HTTP request",
		category: "actions",
		description:
			"Call an external HTTP endpoint and capture the response into context",
	},
	{
		kind: "start_automation",
		label: "Start automation",
		category: "flow",
		description: "Enroll the current contact into another automation",
	},
	{
		kind: "goto",
		label: "Go to",
		category: "flow",
		description: "Jump back to an earlier node in the same graph",
	},
	{
		kind: "end",
		label: "End",
		category: "flow",
		description: "Terminate the run explicitly",
	},
];

const ENTRYPOINT_KINDS = [
	{
		kind: "dm_received",
		label: "DM Received",
		channels: ["instagram", "facebook", "whatsapp", "telegram", "tiktok"],
	},
	// NOTE: a dedicated `keyword` entrypoint kind was previously exposed here.
	// It was removed because `deriveInboundEventKind` never emits `"keyword"` —
	// inbound DMs always surface as `kind: "dm_received"`, so a keyword-only
	// entrypoint could never match at runtime (trigger-matcher.ts filters rows
	// by `eq(kind, event.kind)`). Operators now compose the same intent by
	// creating a `dm_received` entrypoint with `config.keywords` set; the
	// matcher's `matchesEntrypointConfig` applies keyword filtering on the
	// dm_received branch. Spec §6.2 — a keyword-mode dm_received entrypoint
	// still gets specificity=30 when `match_mode` is `exact` or `regex`.
	{
		kind: "comment_created",
		label: "Comment created",
		channels: ["instagram", "facebook"],
	},
	{
		kind: "story_reply",
		label: "Story reply",
		channels: ["instagram", "facebook"],
	},
	{
		kind: "story_mention",
		label: "Story mention",
		channels: ["instagram", "facebook"],
	},
	{
		kind: "live_comment",
		label: "Live comment",
		channels: ["instagram", "facebook"],
	},
	{
		kind: "ad_click",
		label: "Ad click",
		channels: ["instagram", "facebook"],
	},
	{
		kind: "ref_link_click",
		label: "Ref link click",
		channels: ["instagram", "facebook", "whatsapp", "telegram", "tiktok"],
	},
	{
		kind: "share_to_dm",
		label: "Share to DM",
		channels: ["instagram"],
	},
	{
		kind: "follow",
		label: "Follow",
		channels: ["instagram", "facebook", "tiktok"],
	},
	{
		kind: "schedule",
		label: "Schedule",
		channels: ["instagram", "facebook", "whatsapp", "telegram", "tiktok"],
	},
	{
		kind: "field_changed",
		label: "Field changed",
		channels: ["instagram", "facebook", "whatsapp", "telegram", "tiktok"],
	},
	{
		kind: "tag_applied",
		label: "Tag applied",
		channels: ["instagram", "facebook", "whatsapp", "telegram", "tiktok"],
	},
	{
		kind: "tag_removed",
		label: "Tag removed",
		channels: ["instagram", "facebook", "whatsapp", "telegram", "tiktok"],
	},
	{
		kind: "conversion_event",
		label: "Conversion event",
		channels: ["instagram", "facebook", "whatsapp", "telegram", "tiktok"],
	},
	{
		kind: "webhook_inbound",
		label: "Webhook inbound",
		channels: ["instagram", "facebook", "whatsapp", "telegram", "tiktok"],
	},
];

const BINDING_TYPES = [
	{
		type: "default_reply",
		label: "Default Reply",
		channels: ["instagram", "facebook", "whatsapp", "telegram", "tiktok"],
		v1_status: "wired",
	},
	{
		type: "welcome_message",
		label: "Welcome Message",
		channels: ["instagram", "facebook", "whatsapp", "telegram", "tiktok"],
		v1_status: "wired",
	},
	{
		type: "conversation_starter",
		label: "Conversation Starter",
		channels: ["facebook"],
		v1_status: "stubbed",
	},
	{
		type: "main_menu",
		label: "Main Menu",
		channels: ["facebook", "instagram"],
		v1_status: "stubbed",
	},
	{
		type: "ice_breaker",
		label: "Ice Breaker",
		channels: ["whatsapp"],
		v1_status: "stubbed",
	},
];

const ACTION_TYPES = [
	// Contact data
	{ type: "tag_add", label: "Add tag", category: "contact_data" },
	{ type: "tag_remove", label: "Remove tag", category: "contact_data" },
	{ type: "field_set", label: "Set field", category: "contact_data" },
	{ type: "field_clear", label: "Clear field", category: "contact_data" },
	// Segments + subscriptions
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
	// Conversation controls
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
	// External / notify
	{ type: "notify_admin", label: "Notify admin", category: "external" },
	{ type: "webhook_out", label: "Call webhook", category: "external" },
	// Automation controls
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
	// Destructive / conversion
	{ type: "delete_contact", label: "Delete contact", category: "destructive" },
	{
		type: "log_conversion_event",
		label: "Log conversion event",
		category: "conversion",
	},
	// v1.1 stubs
	{
		type: "change_main_menu",
		label: "Change main menu",
		category: "v1_1_stubs",
		// Blocked in the validator (spec §B10 fix) — the action handler throws
		// unconditionally because main-menu platform sync lands in v1.1. The
		// dashboard action picker should grey this out until sync is wired.
		disabled: true,
	},
];

// Channel capability matrix (spec §11.7).
const CHANNEL_CAPABILITIES: Record<string, Record<string, boolean | number>> = {
	instagram: {
		buttons: true,
		buttons_max: 3,
		quick_replies: true,
		quick_replies_max: 13,
		card: true,
		gallery: true,
		gallery_max: 10,
		image: true,
		video: true,
		audio: false,
		file: false,
		delay: true,
	},
	facebook: {
		buttons: true,
		buttons_max: 3,
		quick_replies: true,
		quick_replies_max: 13,
		card: true,
		gallery: true,
		gallery_max: 10,
		image: true,
		video: true,
		audio: true,
		file: true,
		delay: true,
	},
	whatsapp: {
		buttons: true,
		buttons_max: 3,
		quick_replies: false,
		card: false,
		gallery: false,
		image: true,
		video: true,
		audio: true,
		file: true,
		delay: true,
	},
	telegram: {
		buttons: true,
		buttons_max: 3,
		quick_replies: true,
		card: false,
		gallery: false,
		image: true,
		video: true,
		audio: true,
		file: true,
		delay: true,
	},
	tiktok: {
		buttons: false,
		quick_replies: false,
		card: false,
		gallery: false,
		image: true,
		video: true,
		audio: false,
		file: false,
		delay: true,
	},
};

const TEMPLATE_KINDS = [
	"blank",
	"welcome_flow",
	"faq_bot",
	"lead_capture",
	"comment_to_dm",
	"story_leads",
	"follower_growth",
	"follow_to_dm",
];

// ---------------------------------------------------------------------------
// Freeze once, compute a stable ETag from the payload.
// ---------------------------------------------------------------------------

export const AUTOMATION_CATALOG = Object.freeze({
	node_kinds: NODE_KINDS,
	entrypoint_kinds: ENTRYPOINT_KINDS,
	binding_types: BINDING_TYPES,
	action_types: ACTION_TYPES,
	channel_capabilities: CHANNEL_CAPABILITIES,
	template_kinds: TEMPLATE_KINDS,
});

function fnv1a(str: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

export const AUTOMATION_CATALOG_JSON = JSON.stringify(AUTOMATION_CATALOG);
export const AUTOMATION_CATALOG_ETAG = `"${fnv1a(AUTOMATION_CATALOG_JSON)}"`;
