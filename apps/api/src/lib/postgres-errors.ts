/** Match postgres.js errors without coupling route handlers to its error class. */
export function hasPostgresErrorCode(
	error: unknown,
	code: "23503" | "23505",
): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 4; depth += 1) {
		if (typeof current !== "object" || current === null) return false;
		if ("code" in current && current.code === code) return true;
		current = "cause" in current ? current.cause : null;
	}
	return false;
}
