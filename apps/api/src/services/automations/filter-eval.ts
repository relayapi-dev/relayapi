/**
 * Evaluates filter predicates against contact + state.
 * Used by ConditionNode and trigger_filters.
 */

interface Predicate {
	field: string;
	op: string;
	value?: unknown;
}

interface FilterGroup {
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
			return actual === pred.value;
		case "neq":
			return actual !== pred.value;
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
		case "gt":
			return typeof actual === "number" && actual > Number(pred.value);
		case "gte":
			return typeof actual === "number" && actual >= Number(pred.value);
		case "lt":
			return typeof actual === "number" && actual < Number(pred.value);
		case "lte":
			return typeof actual === "number" && actual <= Number(pred.value);
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
	if (tagsNone && tagsNone.some((t) => tags.includes(t))) return false;

	const predicates = filters.predicates as FilterGroup | undefined;
	if (predicates && !evaluateFilterGroup(predicates, subject)) return false;

	return true;
}
