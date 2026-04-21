// Channel capability matrix (Plan 2 — Unit B3, Phase N).
//
// Mirrors `apps/api/src/routes/_automation-catalog.ts` so the composer can
// render correct block-type availability and warnings even when the catalog
// hasn't finished loading. Prefer reading live values from
// `use-catalog.ts` → `channel_capabilities` at runtime; this constant is the
// fallback and the source of truth when the catalog is unavailable.
//
// Spec §11.7.

export type ChannelId =
	| "instagram"
	| "facebook"
	| "whatsapp"
	| "telegram"
	| "tiktok";

export type BlockType =
	| "text"
	| "image"
	| "video"
	| "audio"
	| "file"
	| "card"
	| "gallery"
	| "delay";

export interface ChannelCapabilitySet {
	buttons: boolean;
	buttons_max?: number;
	quick_replies: boolean;
	quick_replies_max?: number;
	card: boolean;
	gallery: boolean;
	gallery_max?: number;
	image: boolean;
	video: boolean;
	audio: boolean;
	file: boolean;
	delay: boolean;
}

export const CHANNEL_CAPABILITIES_FALLBACK: Record<
	string,
	ChannelCapabilitySet
> = {
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

const DEFAULT_CAPS: ChannelCapabilitySet = {
	buttons: true,
	quick_replies: true,
	card: true,
	gallery: true,
	image: true,
	video: true,
	audio: true,
	file: true,
	delay: true,
};

/** Look up a channel's capability set, falling back gracefully. */
export function capabilitiesFor(
	channel: string | undefined,
	live?: Record<string, Record<string, boolean | number>> | undefined,
): ChannelCapabilitySet {
	if (!channel) return DEFAULT_CAPS;
	const lower = channel.toLowerCase();
	if (live && lower in live) {
		// Normalise live catalog entry through DEFAULT_CAPS so missing keys
		// don't turn into `undefined` (treated as "unsupported").
		const entry = live[lower] ?? {};
		return {
			...DEFAULT_CAPS,
			...(entry as Partial<ChannelCapabilitySet>),
		} as ChannelCapabilitySet;
	}
	return CHANNEL_CAPABILITIES_FALLBACK[lower] ?? DEFAULT_CAPS;
}

/** Returns true when the given block type is supported on the channel. */
export function channelSupportsBlock(
	channel: string | undefined,
	block: BlockType,
	live?: Record<string, Record<string, boolean | number>> | undefined,
): boolean {
	const caps = capabilitiesFor(channel, live);
	if (block === "text") return true;
	return !!caps[block];
}

/** Returns true when the given channel renders interactive buttons. */
export function channelSupportsButtons(
	channel: string | undefined,
	live?: Record<string, Record<string, boolean | number>> | undefined,
): boolean {
	return capabilitiesFor(channel, live).buttons === true;
}

/** Returns true when the given channel renders quick replies. */
export function channelSupportsQuickReplies(
	channel: string | undefined,
	live?: Record<string, Record<string, boolean | number>> | undefined,
): boolean {
	return capabilitiesFor(channel, live).quick_replies === true;
}

/** Human-readable channel name for warnings / preview headers. */
export function channelDisplayName(channel: string | undefined): string {
	switch ((channel ?? "").toLowerCase()) {
		case "instagram":
			return "Instagram";
		case "facebook":
			return "Facebook Messenger";
		case "whatsapp":
			return "WhatsApp";
		case "telegram":
			return "Telegram";
		case "tiktok":
			return "TikTok";
		default:
			return channel ?? "this channel";
	}
}
