// Client-side merge-tag resolver (Plan 2 — Unit B3, Phase N).
//
// Mirrors `apps/api/src/services/automations/merge-tags.ts` so the composer
// preview and tests produce the same placeholder-substituted output the
// runtime would. The SDK does not currently re-export the backend helper, so
// we duplicate a small implementation here to keep the dashboard decoupled
// from raw fetches.
//
// Supported groups intentionally match the runtime contract:
//   contact.*, context.* (with state.* retained as an alias)

export interface MergeTagContext {
	contact?: Record<string, unknown> | null;
	context?: Record<string, unknown> | null;
	state?: Record<string, unknown> | null;
}

const TAG_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolveMergeTags(
	template: string,
	ctx: MergeTagContext,
): string {
	if (!template) return "";
	return template.replace(TAG_PATTERN, (_, expr: string) => {
		const path = expr.trim().split(".");
		if (path.length === 0) return "";
		let root: unknown;
		const head = path[0];
		if (head === "contact") {
			root = ctx.contact ?? null;
			path.shift();
		} else if (head === "context") {
			root = ctx.context ?? ctx.state ?? null;
			path.shift();
		} else if (head === "state") {
			root = ctx.state ?? ctx.context ?? null;
			path.shift();
		} else {
			// `{{name}}` shorthand → contact.name.
			root = ctx.contact ?? null;
		}
		let cur: unknown = root;
		for (const p of path) {
			if (cur == null || typeof cur !== "object") return "";
			cur = (cur as Record<string, unknown>)[p];
		}
		return cur == null ? "" : String(cur);
	});
}

/** Placeholder context used by the preview panel. */
export const PREVIEW_MERGE_CONTEXT: MergeTagContext = {
	contact: {
		name: "John Doe",
		email: "john@example.com",
		phone: "+15551234567",
	},
	context: {
		order_id: "order_preview",
		fields: { shirt_size: "Large" },
	},
};
