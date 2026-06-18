/**
 * Evaluates filter predicates against contact + state.
 * Used by ConditionNode and trigger_filters.
 */

interface Predicate {
	field: string;
	op: string;
	value?: unknown;
}

export interface FilterGroup {
	all?: Predicate[];
	any?: Predicate[];
	none?: Predicate[];
}

export function evaluateFilterGroup(
	group: FilterGroup,
	subject: {
		contact?: Record<string, unknown> | null;
		state?: Record<string, unknown>;
		tags?: string[];
		fields?: Record<string, unknown>;
	},
): boolean {
	const all = group.all ?? [];
	const any = group.any ?? [];
	const none = group.none ?? [];

	for (const p of all) if (!evalPredicate(p, subject)) return false;
	if (any.length > 0 && !any.some((p) => evalPredicate(p, subject)))
		return false;
	for (const p of none) if (evalPredicate(p, subject)) return false;

	return true;
}

function evalPredicate(
	pred: Predicate,
	subject: {
		contact?: Record<string, unknown> | null;
		state?: Record<string, unknown>;
		tags?: string[];
		fields?: Record<string, unknown>;
	},
): boolean {
	const actual = resolveField(pred.field, subject);
	switch (pred.op) {
		case "eq":
			// Custom field values hydrate as strings (the custom_field_values.value
			// text column), so a numeric JSON predicate value (e.g. 30) would never
			// strict-equal the stored "30". Fall back to a numeric comparison when
			// both sides parse as numbers; otherwise compare as-is.
			if (actual === pred.value) return true;
			return looseNumericEquals(actual, pred.value);
		case "neq":
			if (actual === pred.value) return false;
			return !looseNumericEquals(actual, pred.value);
		case "contains":
			if (Array.isArray(actual))
				return actual.includes(pred.value as never);
			return typeof actual === "string" && actual.includes(String(pred.value));
		case "not_contains":
			if (Array.isArray(actual))
				return !actual.includes(pred.value as never);
			return typeof actual === "string" && !actual.includes(String(pred.value));
		case "starts_with":
			return (
				typeof actual === "string" && actual.startsWith(String(pred.value))
			);
		case "ends_with":
			return typeof actual === "string" && actual.endsWith(String(pred.value));
		case "gt": {
			// Coerce `actual` to a number — custom fields hydrate as strings, so a
			// strict `typeof actual === "number"` guard rejected every stored field
			// value and the comparison always evaluated false.
			const a = toFiniteNumber(actual);
			return a !== null && a > Number(pred.value);
		}
		case "gte": {
			const a = toFiniteNumber(actual);
			return a !== null && a >= Number(pred.value);
		}
		case "lt": {
			const a = toFiniteNumber(actual);
			return a !== null && a < Number(pred.value);
		}
		case "lte": {
			const a = toFiniteNumber(actual);
			return a !== null && a <= Number(pred.value);
		}
		case "in":
			return (
				Array.isArray(pred.value) && pred.value.includes(actual as never)
			);
		case "not_in":
			return (
				Array.isArray(pred.value) && !pred.value.includes(actual as never)
			);
		case "exists":
			return actual !== undefined && actual !== null;
		case "not_exists":
			return actual === undefined || actual === null;
		default:
			return false;
	}
}

/**
 * Coerces a value to a finite number, returning null when it can't be parsed.
 * Used by the numeric comparison operators so string-stored custom field values
 * (e.g. "18") compare correctly against numeric predicate values. Rejects
 * empty strings, booleans, and Infinity/NaN.
 */
function toFiniteNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) return null;
		const n = Number(trimmed);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/**
 * True when both operands parse as finite numbers and are numerically equal.
 * Lets `eq`/`neq` match a numeric predicate value against a string-stored field.
 */
function looseNumericEquals(actual: unknown, expected: unknown): boolean {
	const a = toFiniteNumber(actual);
	const b = toFiniteNumber(expected);
	return a !== null && b !== null && a === b;
}

function resolveField(
	field: string,
	subject: {
		contact?: Record<string, unknown> | null;
		state?: Record<string, unknown>;
		tags?: string[];
		fields?: Record<string, unknown>;
	},
): unknown {
	// Shortcuts: 'tags', 'fields.X', 'state.X', 'contact.X'
	if (field === "tags") return subject.tags ?? [];
	if (field.startsWith("fields.")) {
		return subject.fields?.[field.slice(7)];
	}
	if (field.startsWith("state.")) {
		return resolveDotPath(subject.state, field.slice(6));
	}
	if (field.startsWith("contact.")) {
		return resolveDotPath(subject.contact, field.slice(8));
	}
	// Default: contact first, then state
	return (
		resolveDotPath(subject.contact, field) ??
		resolveDotPath(subject.state, field)
	);
}

function resolveDotPath(obj: unknown, path: string): unknown {
	if (!obj || typeof obj !== "object") return undefined;
	let cur: unknown = obj;
	for (const key of path.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

export function matchesTriggerFilters(
	filters: Record<string, unknown>,
	subject: {
		tags?: string[];
		fields?: Record<string, unknown>;
		contact?: Record<string, unknown> | null;
	},
): boolean {
	const tagsAny = filters.tags_any as string[] | undefined;
	const tagsAll = filters.tags_all as string[] | undefined;
	const tagsNone = filters.tags_none as string[] | undefined;
	const tags = subject.tags ?? [];

	if (tagsAny && !tagsAny.some((t) => tags.includes(t))) return false;
	if (tagsAll && !tagsAll.every((t) => tags.includes(t))) return false;
	if (tagsNone?.some((t) => tags.includes(t))) return false;

	const predicates = filters.predicates as FilterGroup | undefined;
	if (predicates && !evaluateFilterGroup(predicates, subject)) return false;

	return true;
}
