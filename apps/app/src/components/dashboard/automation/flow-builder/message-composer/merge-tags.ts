// Client-side merge-tag resolver (Plan 2 — Unit B3, Phase N).
//
// Mirrors `apps/api/src/services/automations/merge-tags.ts` so the composer
// preview and tests produce the same placeholder-substituted output the
// runtime would. The SDK does not currently re-export the backend helper, so
// we duplicate a small implementation here to keep the dashboard decoupled
// from raw fetches.
//
// Accepts the extended tag groups from spec §11.9:
//   contact.*, context.*, run.*, account.*

export interface MergeTagContext {
	contact?: Record<string, unknown> | null;
	context?: Record<string, unknown> | null;
	state?: Record<string, unknown> | null;
	run?: Record<string, unknown> | null;
	account?: Record<string, unknown> | null;
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
		} else if (head === "run") {
			root = ctx.run ?? null;
			path.shift();
		} else if (head === "account") {
			root = ctx.account ?? null;
			path.shift();
		} else {
			// `{{first_name}}` shorthand → contact.first_name
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
		first_name: "John",
		last_name: "Doe",
		email: "john@example.com",
		phone: "+15551234567",
		custom_fields: {},
	},
	context: {},
	run: {
		id: "run_preview",
		started_at: new Date().toISOString(),
	},
	account: {
		name: "Your Account",
		handle: "@youraccount",
	},
};
