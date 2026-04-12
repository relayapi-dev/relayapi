/**
 * Automation rule condition evaluator — pure function that evaluates
 * nested condition trees against a message context.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConditionNode {
	operator: "AND" | "OR" | "NOT";
	rules: Array<ConditionNode | ConditionLeaf>;
}

export interface ConditionLeaf {
	field: string; // "type", "platform", "text", "author.name", "direction", etc.
	op: string; // "eq", "in", "contains", "not_contains", "regex", "starts_with", "gt", "lt"
	value: unknown;
}

export interface MessageContext {
	type: string;
	platform: string;
	text?: string;
	direction: string;
	author?: { name: string; id: string };
	labels?: string[];
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isConditionNode(
	node: ConditionNode | ConditionLeaf,
): node is ConditionNode {
	return "operator" in node;
}

/**
 * Resolve a dot-notation field path from the context object.
 * e.g. "author.name" -> context.author.name
 */
function getFieldValue(context: MessageContext, field: string): unknown {
	const parts = field.split(".");
	let current: unknown = context;
	for (const part of parts) {
		if (current == null || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/**
 * Evaluate a single leaf condition against a context value.
 */
function evaluateLeaf(leaf: ConditionLeaf, context: MessageContext): boolean {
	const fieldValue = getFieldValue(context, leaf.field);

	switch (leaf.op) {
		case "eq":
			return fieldValue === leaf.value;

		case "in": {
			if (!Array.isArray(leaf.value)) return false;
			return (leaf.value as unknown[]).includes(fieldValue);
		}

		case "contains": {
			if (typeof fieldValue !== "string" || typeof leaf.value !== "string")
				return false;
			return fieldValue.toLowerCase().includes(leaf.value.toLowerCase());
		}

		case "not_contains": {
			if (typeof fieldValue !== "string" || typeof leaf.value !== "string")
				return true;
			return !fieldValue.toLowerCase().includes(leaf.value.toLowerCase());
		}

		case "regex": {
			if (typeof fieldValue !== "string" || typeof leaf.value !== "string")
				return false;
			try {
				const re = new RegExp(leaf.value, "i");
				return re.test(fieldValue);
			} catch {
				return false;
			}
		}

		case "starts_with": {
			if (typeof fieldValue !== "string" || typeof leaf.value !== "string")
				return false;
			return fieldValue
				.toLowerCase()
				.startsWith(leaf.value.toLowerCase());
		}

		case "gt": {
			if (typeof fieldValue !== "number" || typeof leaf.value !== "number")
				return false;
			return fieldValue > leaf.value;
		}

		case "lt": {
			if (typeof fieldValue !== "number" || typeof leaf.value !== "number")
				return false;
			return fieldValue < leaf.value;
		}

		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a condition tree (nested AND/OR/NOT nodes with leaf comparisons)
 * against a message context. Returns true if the conditions match.
 */
export function evaluateConditions(
	conditions: ConditionNode | ConditionLeaf,
	context: MessageContext,
): boolean {
	// Leaf node — evaluate directly
	if (!isConditionNode(conditions)) {
		return evaluateLeaf(conditions, context);
	}

	// Node — recurse into children
	const { operator, rules } = conditions;

	if (!rules || rules.length === 0) {
		return true; // Empty rule set is vacuously true
	}

	switch (operator) {
		case "AND":
			return rules.every((rule) => evaluateConditions(rule, context));

		case "OR":
			return rules.some((rule) => evaluateConditions(rule, context));

		case "NOT":
			// NOT applies to the first rule only (standard semantic)
			return !evaluateConditions(rules[0]!, context);

		default:
			return false;
	}
}
