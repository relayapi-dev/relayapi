/**
 * Last-line Workers Logs privacy boundary.
 *
 * Application code should still emit deliberate structured events, but this
 * wrapper ensures an accidental Error, provider body, URL, credential, or
 * arbitrary object cannot bypass that convention into persisted Workers Logs.
 */

const INSTALL_KEY = Symbol.for("relayapi.safe-console.installed");
const MAX_MESSAGE_LENGTH = 500;

const ALLOWED_STRUCTURED_KEYS = new Set([
	"event",
	"level",
	"code",
	"status",
	"method",
	"kind",
	"type",
	"queue",
	"attempt",
	"attempts",
	"count",
	"failed",
	"processed",
	"deleted",
	"redacted",
	"replayed",
	"enqueued",
	"durationMs",
	"delaySeconds",
	"organizationId",
	"workspaceId",
	"accountId",
	"operationId",
	"jobId",
	"messageId",
]);

export function sanitizeLogText(value: string): string {
	if (value.length > MAX_MESSAGE_LENGTH || /^[\s]*[[{]/.test(value)) {
		return "[redacted-detail]";
	}
	return value
		.replace(/https?:\/\/\S+/gi, "[redacted-url]")
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
		.replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[redacted-number]")
		.replace(
			/\b(bearer|token|secret|password|api[_-]?key|authorization)\s*[:=]\s*\S+/gi,
			"$1=[redacted]",
		)
		.replace(
			/\b(profile|provider|platform)[_-]?(id|url)\s*[:=]\s*\S+/gi,
			"$1_$2=[redacted]",
		)
		.slice(0, MAX_MESSAGE_LENGTH);
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "string") return sanitizeLogText(value);
	if (value instanceof Error) {
		const code = (value as Error & { code?: unknown }).code;
		return {
			error_name: value.name || "Error",
			...(typeof code === "string"
				? { error_code: sanitizeLogText(code) }
				: {}),
		};
	}
	if (Array.isArray(value)) return { item_count: value.length };
	if (typeof value !== "object" || depth >= 2) return "[redacted]";

	const safe: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		if (!ALLOWED_STRUCTURED_KEYS.has(key)) continue;
		safe[key] = sanitizeLogValue(nested, depth + 1);
	}
	return Object.keys(safe).length > 0 ? safe : { redacted: true };
}

export function installSafeConsole(): void {
	const globalState = globalThis as typeof globalThis & {
		[INSTALL_KEY]?: boolean;
	};
	if (globalState[INSTALL_KEY]) return;
	globalState[INSTALL_KEY] = true;

	for (const method of ["log", "info", "warn", "error", "debug"] as const) {
		const original = console[method].bind(console);
		console[method] = (...args: unknown[]) => {
			original(
				...args.map((value, index) =>
					index === 0 && typeof value === "string"
						? sanitizeLogText(value)
						: sanitizeLogValue(value),
				),
			);
		};
	}
}

installSafeConsole();
