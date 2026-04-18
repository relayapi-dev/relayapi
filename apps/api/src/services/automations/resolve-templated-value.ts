import { applyMergeTags } from "./merge-tags";

interface TemplateContext {
	contact?: Record<string, unknown> | null;
	state?: Record<string, unknown>;
}

/**
 * Recursively resolves merge-tag templates inside JSON-like config values.
 * This lets nodes interpolate `{{contact.*}}` / `{{state.*}}` in strings,
 * nested objects, arrays, headers, and request/webhook payloads.
 */
export function resolveTemplatedValue(
	value: unknown,
	ctx: TemplateContext,
): unknown {
	if (typeof value === "string") {
		return applyMergeTags(value, ctx);
	}
	if (Array.isArray(value)) {
		return value.map((entry) => resolveTemplatedValue(entry, ctx));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				resolveTemplatedValue(entry, ctx),
			]),
		);
	}
	return value;
}
