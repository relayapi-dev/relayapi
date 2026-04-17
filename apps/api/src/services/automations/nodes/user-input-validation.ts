/**
 * Validation rules for the `user_input_*` node family.
 *
 * The node handler parks the enrollment in `waiting` state with
 * `_pending_input_*` markers. When the next inbound message arrives,
 * `resumeFromInput()` calls `validateInput()` with the raw input + the node
 * config. The return value tells the runner what to do next:
 *
 *   kind: "ok"    — value is valid. Save it to `save_to_field` and resume
 *                   via the `captured` edge.
 *   kind: "retry" — value is invalid but the user still has attempts left.
 *                   Runner should re-send `retry_prompt` (if configured) and
 *                   keep the enrollment parked in `waiting`.
 *   kind: "fail"  — attempts exhausted. Runner should clear markers and
 *                   resume via the `no_match` edge.
 */

export interface InputFileMeta {
	mime_type?: string;
	size_bytes?: number;
}

export type UserInputNodeConfig = Record<string, unknown>;

export type ValidateInputResult =
	| { kind: "ok"; value: unknown }
	| { kind: "retry"; reason: string }
	| { kind: "fail"; reason: string };

export function validateInput(
	nodeType: string,
	config: UserInputNodeConfig,
	rawInput: unknown,
	attemptsSoFar: number,
	fileMeta?: InputFileMeta,
): ValidateInputResult {
	const maxAttempts = (config.max_attempts as number | undefined) ?? 2;

	const coreResult = validateBySubtype(nodeType, config, rawInput, fileMeta);
	if (coreResult.kind === "ok") return coreResult;

	// Invalid. attemptsSoFar counts the attempts *before* this one — so if
	// maxAttempts=2 and this is the first validation failure (attemptsSoFar=0),
	// the user still has one more try (attemptsSoFar becomes 1 after this).
	const nextAttempts = attemptsSoFar + 1;
	if (nextAttempts < maxAttempts) {
		return { kind: "retry", reason: coreResult.reason };
	}
	return { kind: "fail", reason: coreResult.reason };
}

function validateBySubtype(
	nodeType: string,
	config: UserInputNodeConfig,
	rawInput: unknown,
	fileMeta?: InputFileMeta,
):
	| { kind: "ok"; value: unknown }
	| { kind: "invalid"; reason: string } {
	const text = typeof rawInput === "string" ? rawInput.trim() : "";

	switch (nodeType) {
		case "user_input_text": {
			const min = config.min_length as number | undefined;
			const max = config.max_length as number | undefined;
			if (!text) return { kind: "invalid", reason: "empty text" };
			if (min !== undefined && text.length < min)
				return { kind: "invalid", reason: `must be at least ${min} characters` };
			if (max !== undefined && text.length > max)
				return { kind: "invalid", reason: `must be at most ${max} characters` };
			return { kind: "ok", value: text };
		}

		case "user_input_email": {
			// RFC-5322-lite: at least one char, @, at least one char with dot.
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
				return { kind: "invalid", reason: "not a valid email address" };
			return { kind: "ok", value: text.toLowerCase() };
		}

		case "user_input_phone": {
			// Strip all non-digits / plus. Accept E.164 (7–15 digits, optional +).
			const cleaned = text.replace(/[^\d+]/g, "");
			const normalized = cleaned.startsWith("+") ? cleaned : cleaned;
			const digits = normalized.replace(/\D/g, "");
			if (digits.length < 7 || digits.length > 15)
				return { kind: "invalid", reason: "not a valid phone number" };
			return { kind: "ok", value: normalized };
		}

		case "user_input_number": {
			const n = Number(text.replace(/,/g, ""));
			if (!Number.isFinite(n))
				return { kind: "invalid", reason: "not a number" };
			const min = config.min as number | undefined;
			const max = config.max as number | undefined;
			if (min !== undefined && n < min)
				return { kind: "invalid", reason: `must be ≥ ${min}` };
			if (max !== undefined && n > max)
				return { kind: "invalid", reason: `must be ≤ ${max}` };
			return { kind: "ok", value: n };
		}

		case "user_input_date": {
			const format = (config.format as string | undefined) ?? "YYYY-MM-DD";
			const regex = formatToRegex(format);
			if (!regex.test(text))
				return { kind: "invalid", reason: `expected format ${format}` };
			// Attempt a date parse to reject things like 2026-13-40.
			const iso = toIsoDate(text, format);
			if (!iso) return { kind: "invalid", reason: "not a real calendar date" };
			return { kind: "ok", value: iso };
		}

		case "user_input_choice": {
			const choices =
				(config.choices as Array<{ label: string; value: string }> | undefined) ??
				[];
			const lower = text.toLowerCase();
			// Match by value (canonical) first, then label as a friendly fallback.
			const byValue = choices.find((c) => c.value.toLowerCase() === lower);
			if (byValue) return { kind: "ok", value: byValue.value };
			const byLabel = choices.find((c) => c.label.toLowerCase() === lower);
			if (byLabel) return { kind: "ok", value: byLabel.value };
			return {
				kind: "invalid",
				reason: `reply with one of: ${choices.map((c) => c.label).join(", ")}`,
			};
		}

		case "user_input_file": {
			if (!fileMeta || (!fileMeta.mime_type && fileMeta.size_bytes === undefined)) {
				return { kind: "invalid", reason: "expected a file upload" };
			}
			const accepted = config.accepted_mime_types as string[] | undefined;
			if (accepted && accepted.length > 0 && fileMeta.mime_type) {
				const ok = accepted.some((pattern) =>
					matchMimePattern(pattern, fileMeta.mime_type ?? ""),
				);
				if (!ok)
					return {
						kind: "invalid",
						reason: `unsupported file type (accepted: ${accepted.join(", ")})`,
					};
			}
			const maxMb = (config.max_size_mb as number | undefined) ?? 16;
			if (fileMeta.size_bytes !== undefined) {
				if (fileMeta.size_bytes > maxMb * 1024 * 1024)
					return { kind: "invalid", reason: `file exceeds ${maxMb} MB` };
			}
			// The actual payload is platform-specific — we return whatever the
			// caller gave us (e.g. a media URL or a `{id,url}` object).
			return { kind: "ok", value: rawInput };
		}

		default:
			// Not a user_input node — shouldn't normally be called, but fail
			// open so the runner can decide what to do.
			return { kind: "invalid", reason: `unknown user_input type '${nodeType}'` };
	}
}

function matchMimePattern(pattern: string, mime: string): boolean {
	// Support exact match (`image/png`) and wildcard (`image/*`).
	if (pattern === mime) return true;
	if (pattern.endsWith("/*")) {
		const prefix = pattern.slice(0, -1); // "image/"
		return mime.startsWith(prefix);
	}
	return false;
}

function formatToRegex(format: string): RegExp {
	// Support YYYY / MM / DD placeholders and escape everything else.
	const escaped = format
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/YYYY/g, "(\\d{4})")
		.replace(/MM/g, "(\\d{2})")
		.replace(/DD/g, "(\\d{2})");
	return new RegExp(`^${escaped}$`);
}

function toIsoDate(input: string, format: string): string | null {
	// Reverse-map placeholder positions to capture groups so we can pull out
	// year/month/day for a sanity check.
	const positions: Record<string, number> = {};
	const scanner = /YYYY|MM|DD/g;
	let idx = 0;
	let m: RegExpExecArray | null;
	while ((m = scanner.exec(format)) !== null) {
		idx += 1;
		positions[m[0]] = idx;
	}
	const regex = formatToRegex(format);
	const match = regex.exec(input);
	if (!match) return null;
	const year = Number(match[positions.YYYY ?? 0]);
	const month = Number(match[positions.MM ?? 0]);
	const day = Number(match[positions.DD ?? 0]);
	if (!year || !month || !day) return null;
	if (month < 1 || month > 12) return null;
	const d = new Date(Date.UTC(year, month - 1, day));
	if (
		d.getUTCFullYear() !== year ||
		d.getUTCMonth() !== month - 1 ||
		d.getUTCDate() !== day
	) {
		return null;
	}
	return `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}
function pad4(n: number): string {
	return n < 1000 ? `0${pad2(Math.floor(n / 100))}${pad2(n % 100)}` : String(n);
}
