/**
 * Parse the only valid durable API-key workspace grant forms. Missing metadata
 * retains the historical all-workspaces default; malformed metadata fails
 * closed so string `.includes()` or other coercions can never authorize a row.
 */
export function parseApiKeyWorkspaceScope(
	metadata: unknown,
): "all" | string[] | null {
	if (metadata === null || metadata === undefined) return "all";
	if (typeof metadata !== "object" || Array.isArray(metadata)) return null;

	const raw = (metadata as Record<string, unknown>).workspace_scope;
	if (raw === undefined || raw === "all") return "all";
	if (
		!Array.isArray(raw) ||
		!raw.every((value) => typeof value === "string" && value.trim().length > 0)
	) {
		return null;
	}
	return [...new Set(raw.map((value) => value.trim()))];
}
