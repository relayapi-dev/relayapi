const MAX_AUTOMATION_REGEX_LENGTH = 256;
export const MAX_AUTOMATION_REGEX_INPUT_LENGTH = 4_096;
const MAX_FIXED_REPEAT = 64;

function hasUnanchoredAlternative(pattern: string): boolean {
	let escaped = false;
	let inCharacterClass = false;
	let groupDepth = 0;
	let needsStartAnchor = true;
	for (const char of pattern) {
		if (escaped) {
			if (needsStartAnchor) return true;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "[" && !inCharacterClass) inCharacterClass = true;
		if (char === "]" && inCharacterClass) inCharacterClass = false;
		if (!inCharacterClass && char === "(") groupDepth++;
		if (!inCharacterClass && char === ")") groupDepth--;
		if (needsStartAnchor) {
			if (char !== "^") return true;
			needsStartAnchor = false;
			continue;
		}
		if (char === "|" && !inCharacterClass && groupDepth === 0) {
			needsStartAnchor = true;
		}
	}
	return needsStartAnchor;
}

function hasUnboundedQuantifier(pattern: string): boolean {
	let escaped = false;
	let inCharacterClass = false;
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "[" && !inCharacterClass) {
			inCharacterClass = true;
			continue;
		}
		if (char === "]" && inCharacterClass) {
			inCharacterClass = false;
			continue;
		}
		if (
			!inCharacterClass &&
			char === "(" &&
			pattern.slice(index, index + 3) === "(?:"
		) {
			index += 2;
			continue;
		}
		if (!inCharacterClass && (char === "*" || char === "+" || char === "?")) {
			return true;
		}
	}
	return false;
}

function hasMultipleVariableQuantifiers(pattern: string): boolean {
	let escaped = false;
	let inCharacterClass = false;
	let count = 0;
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "[" && !inCharacterClass) {
			inCharacterClass = true;
			continue;
		}
		if (char === "]" && inCharacterClass) {
			inCharacterClass = false;
			continue;
		}
		if (inCharacterClass) continue;

		if (char === "(" && pattern.slice(index, index + 3) === "(?:") {
			index += 2;
			continue;
		}
		if (char === "*" || char === "+" || char === "?") {
			count++;
		} else if (char === "{") {
			const close = pattern.indexOf("}", index + 1);
			if (close === -1) continue;
			const match = pattern.slice(index + 1, close).match(/^(\d+)(?:,(\d*))?$/);
			if (match && pattern.slice(index + 1, close).includes(",")) {
				const minimum = Number(match[1]);
				const maximum =
					match[2] === "" ? Number.POSITIVE_INFINITY : Number(match[2]);
				if (minimum !== maximum) count++;
			}
			index = close;
		}
		if (count > 1) return true;
	}
	return false;
}

function hasUnsafeBacktrackingShape(pattern: string): boolean {
	let escaped = false;
	let inCharacterClass = false;
	let groupDepth = 0;
	let previousAtomWasVariable = false;
	let currentAtomFollowsVariable = false;
	const outerVariableState: boolean[] = [];
	const consumeAtom = () => {
		currentAtomFollowsVariable = previousAtomWasVariable;
		previousAtomWasVariable = false;
	};
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (escaped) {
			escaped = false;
			consumeAtom();
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "[" && !inCharacterClass) {
			inCharacterClass = true;
			continue;
		}
		if (char === "]" && inCharacterClass) {
			inCharacterClass = false;
			consumeAtom();
			continue;
		}
		if (inCharacterClass) continue;

		if (char === "(") {
			// Ordinary and non-capturing unquantified groups preserve common, safe
			// alternation. Other group extensions remain outside the supported subset.
			if (pattern[index + 1] === "?") {
				if (pattern[index + 2] !== ":") return true;
				index += 2;
			}
			outerVariableState.push(previousAtomWasVariable);
			previousAtomWasVariable = false;
			currentAtomFollowsVariable = false;
			groupDepth++;
			continue;
		}
		if (char === ")") {
			if (groupDepth === 0) return true;
			const outerVariable = outerVariableState.pop() ?? false;
			groupDepth--;
			currentAtomFollowsVariable = outerVariable;
			previousAtomWasVariable = false;
			continue;
		}
		if (char === "*" || char === "+" || char === "?") {
			// Adjacent optional/variable-width atoms are the dangerous shape in
			// patterns such as `a*a*a*b`, `.*.*X`, and repeated optionals. A
			// mandatory literal/class between quantifiers breaks that chain.
			if (currentAtomFollowsVariable) return true;
			previousAtomWasVariable = true;
			currentAtomFollowsVariable = false;
			continue;
		}
		if (char === "|" || char === "^" || char === "$") {
			previousAtomWasVariable = false;
			currentAtomFollowsVariable = false;
			continue;
		}
		if (char !== "{") {
			consumeAtom();
			continue;
		}
		const close = pattern.indexOf("}", index + 1);
		if (close === -1) return true;
		const match = pattern.slice(index + 1, close).match(/^(\d+)(?:,(\d*))?$/);
		if (!match) return true;
		const minimum = Number(match[1]);
		const hasComma = pattern.slice(index + 1, close).includes(",");
		const maximum = hasComma
			? match[2] === ""
				? Number.POSITIVE_INFINITY
				: Number(match[2])
			: minimum;
		if (
			!Number.isSafeInteger(minimum) ||
			maximum < minimum ||
			minimum > MAX_FIXED_REPEAT ||
			maximum > MAX_FIXED_REPEAT
		) {
			return true;
		}
		if (hasComma && maximum !== minimum) {
			if (currentAtomFollowsVariable) return true;
			previousAtomWasVariable = true;
			currentAtomFollowsVariable = false;
		} else if (minimum === 0) {
			previousAtomWasVariable = currentAtomFollowsVariable;
		} else {
			previousAtomWasVariable = false;
			currentAtomFollowsVariable = false;
		}
		index = close;
	}
	return inCharacterClass || escaped || groupDepth !== 0;
}

/**
 * Compile the deliberately small regular-expression subset accepted in
 * tenant-authored automation configuration. JavaScript's backtracking engine
 * has no execution budget, so constructs whose cost depends on backtracking
 * depth are rejected before they can reach a Queue consumer.
 */
export function compileSafeAutomationRegex(
	pattern: string,
	flags = "",
): RegExp | null {
	if (pattern.length === 0 || pattern.length > MAX_AUTOMATION_REGEX_LENGTH) {
		return null;
	}
	if (!/^[imsu]*$/.test(flags) || new Set(flags).size !== flags.length)
		return null;
	// A single variable quantifier can still become quadratic when the engine
	// retries it at every input position. Patterns with an unbounded quantifier
	// must start-anchor every top-level alternative, and multiline mode is
	// disallowed so `^` means one position. Literal and bounded-only patterns
	// keep the existing substring semantics used by persisted automations.
	if (
		hasUnboundedQuantifier(pattern) &&
		(flags.includes("m") || hasUnanchoredAlternative(pattern))
	) {
		return null;
	}
	// Backreferences and lookarounds make matching non-linear and are not needed
	// for the automation keyword/input use cases.
	if (/\\[1-9]|\\k<|\(\?(?:[=!]|<[=!])/.test(pattern)) return null;
	// Never allow a quantified group. This conservative rule rejects nested
	// quantifiers and ambiguous alternations such as `(a+)+` and `(a|aa)*`.
	if (/\)(?:[*+?]|\{\d+(?:,\d*)?\})/.test(pattern)) return null;
	// Reject stacked quantifiers and malformed brace quantifiers early.
	if (/(?:[*+?]|\{\d+(?:,\d*)?\})(?:[*+?]|\{)/.test(pattern)) return null;
	// Even without adjacent quantifiers, JavaScript's backtracking engine can
	// become exponential when several variable-width atoms compete for the same
	// input (for example `^.*a.*a.*ab$`). Proving arbitrary atom overlap would
	// require a complete regex parser, so the supported tenant-authored subset
	// permits one variable-width quantifier; exact `{n}` repeats remain allowed.
	if (hasMultipleVariableQuantifiers(pattern)) return null;
	if (hasUnsafeBacktrackingShape(pattern)) return null;

	try {
		return new RegExp(pattern, flags);
	} catch {
		return null;
	}
}

export function testSafeAutomationRegex(
	pattern: string,
	input: string,
	flags = "",
): boolean {
	const regex = compileSafeAutomationRegex(pattern, flags);
	if (!regex) return false;
	if (input.length > MAX_AUTOMATION_REGEX_INPUT_LENGTH) return false;
	return regex.test(input);
}
