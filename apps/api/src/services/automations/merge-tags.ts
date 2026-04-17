/**
 * Merge-tag substitution for message text.
 * Supports {{first_name}}, {{contact.email}}, {{state.captured_field}}.
 */

export function applyMergeTags(
	template: string,
	ctx: {
		contact?: Record<string, unknown> | null;
		state?: Record<string, unknown>;
	},
): string {
	if (!template) return "";
	return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
		const path = expr.trim().split(".");
		let root: unknown;
		if (path[0] === "contact") {
			root = ctx.contact;
			path.shift();
		} else if (path[0] === "state") {
			root = ctx.state;
			path.shift();
		} else {
			// shortcut: {{first_name}} → contact.first_name
			root = ctx.contact;
		}
		let cur: unknown = root;
		for (const p of path) {
			if (cur == null || typeof cur !== "object") return "";
			cur = (cur as Record<string, unknown>)[p];
		}
		return cur == null ? "" : String(cur);
	});
}
