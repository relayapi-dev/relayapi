export type HydratedContactContext = {
	contact: Record<string, unknown> | null;
	tags: string[];
	fields: Record<string, string>;
};

/**
 * Preserve durable run state while replacing contact-derived values with the
 * latest authoritative snapshot. Runtime keys, captured inputs, and trigger
 * payloads remain intact across the refresh.
 */
export function mergeRefreshedContactContext(
	existing: Record<string, unknown>,
	fresh: HydratedContactContext,
): Record<string, unknown> {
	return {
		...existing,
		contact: fresh.contact,
		tags: fresh.tags,
		fields: fresh.fields,
	};
}
