import type { NodeHandler } from "../types";

/**
 * Universal media/file send is not supported because every platform's media
 * contract diverges (upload first vs. URL reference, allowed mime types, size
 * caps, attachment semantics). Authors should use a platform-specific send
 * node — e.g. `instagram_send_media`, `whatsapp_send_media`, `telegram_send_media`,
 * `discord_send_attachment` — which resolves the channel upload path correctly.
 *
 * We fail loudly here instead of advancing silently so an author can't ship a
 * graph that looks successful in run logs while nothing was actually sent.
 */
export const messageMediaHandler: NodeHandler = async (ctx) => ({
	kind: "fail",
	error:
		`'${ctx.node.type}' is not supported — use a platform-specific media node ` +
		`(instagram_send_media, whatsapp_send_media, telegram_send_media, discord_send_attachment, etc.).`,
});
