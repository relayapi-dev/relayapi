import type { NodeHandler } from "../types";

/**
 * Media send — deferred to Phase 8 where per-platform media upload/send paths differ.
 * For now, log the intent and advance so authors can see their graph execute end-to-end.
 */
export const messageMediaHandler: NodeHandler = async () => ({
	kind: "next",
	state_patch: {
		_warning: "message_media is a stub until Phase 8 (per-platform media sends).",
	},
});
