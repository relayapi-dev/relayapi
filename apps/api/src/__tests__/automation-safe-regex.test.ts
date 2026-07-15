import { describe, expect, it } from "bun:test";
import {
	compileSafeAutomationRegex,
	testSafeAutomationRegex,
} from "../services/automations/safe-regex";
import { validateGraph } from "../services/automations/validator";
import { validateEntrypointConfig } from "../schemas/automation-entrypoints";

describe("tenant-authored automation regular expressions", () => {
	it("accepts bounded keyword patterns", () => {
		expect(testSafeAutomationRegex("^hello[0-9]+$", "hello42", "i")).toBe(true);
		expect(testSafeAutomationRegex("^hello[0-9]+$", "goodbye42", "i")).toBe(
			false,
		);
		expect(testSafeAutomationRegex("pizza", "order a pizza", "i")).toBe(true);
		expect(testSafeAutomationRegex("a{1,64}b", "xxaaabyy")).toBe(true);
		expect(testSafeAutomationRegex("^(hello|hi)$", "hi", "i")).toBe(true);
		expect(testSafeAutomationRegex("^(?:foo|bar)$", "bar")).toBe(true);
		expect(testSafeAutomationRegex("^hello\\s+world$", "hello world")).toBe(
			true,
		);
		expect(
			testSafeAutomationRegex("^[A-Z][a-z]{1,32}\\sApi$", "Relay Api"),
		).toBe(true);
	});

	it("rejects backtracking-prone and advanced constructs", () => {
		for (const pattern of [
			"(a+)+$",
			"(a|aa)*$",
			"(.*)+$",
			"(a)+",
			"(a)\\1",
			"(?=a)a",
			"a*a*a*a*a*a*a*a*a*b",
			".*.*.*.*X",
			"^.*a.*a.*a.*a.*a.*ab$",
			"a?a?a?a?a?a?a?a?b",
			"^hello\\s+world\\s*$",
			"a*b",
			"^literal|a*b",
		]) {
			expect(compileSafeAutomationRegex(pattern)).toBeNull();
		}
	});

	it("rejects stateful flags and oversized repeat bounds", () => {
		expect(compileSafeAutomationRegex("hello", "g")).toBeNull();
		expect(compileSafeAutomationRegex("^a*b", "m")).toBeNull();
		expect(compileSafeAutomationRegex("a{65}")).toBeNull();
		expect(compileSafeAutomationRegex("a{1,65}")).toBeNull();
	});

	it("rejects oversized patterns and bounds tested input", () => {
		expect(compileSafeAutomationRegex("a".repeat(257))).toBeNull();
		expect(testSafeAutomationRegex("^a+$", `${"a".repeat(4_096)}b`)).toBe(
			false,
		);
	});

	it("rejects unsafe regex-mode DM keywords before persistence", () => {
		const parsed = validateEntrypointConfig("dm_received", {
			keywords: ["^hello[0-9]+$", "(a+)+$"],
			match_mode: "regex",
		});
		expect(parsed.success).toBe(false);
		if (parsed.success) throw new Error("expected regex validation to fail");
		expect(parsed.error.issues).toEqual([
			expect.objectContaining({
				path: ["keywords", 1],
				message: "Unsupported or unsafe regular expression",
			}),
		]);
	});

	it("preserves safe grouped regex-mode DM keywords", () => {
		const parsed = validateEntrypointConfig("dm_received", {
			keywords: ["^(hello|hi)$", "^(?:foo|bar)$"],
			match_mode: "regex",
		});
		expect(parsed.success).toBe(true);
	});

	it("does not apply regex validation to exact or contains DM keywords", () => {
		for (const matchMode of ["exact", "contains"] as const) {
			const parsed = validateEntrypointConfig("dm_received", {
				keywords: ["(a+)+$"],
				match_mode: matchMode,
			});
			expect(parsed.success).toBe(true);
		}
	});

	it("validates input-node patterns against the runtime-supported subset", () => {
		const graphWithPattern = (pattern: string) => ({
			schema_version: 1 as const,
			root_node_key: "message",
			nodes: [
				{
					key: "message",
					kind: "message",
					config: { blocks: [] },
					ports: [],
				},
				{
					key: "input",
					kind: "input",
					config: { validation: { pattern } },
					ports: [],
				},
			],
			edges: [
				{
					from_node: "message",
					from_port: "next",
					to_node: "input",
					to_port: "in",
				},
			],
		});

		const unsafe = validateGraph(graphWithPattern("(a+)+$"));
		expect(unsafe.errors).toContainEqual({
			code: "invalid_input_pattern",
			message:
				"input validation.pattern must be a supported safe regular expression",
			node_key: "input",
		});

		const supported = validateGraph(graphWithPattern("^(?:hello|hi)[0-9]+$"));
		expect(
			supported.errors.some((error) => error.code === "invalid_input_pattern"),
		).toBe(false);
	});
});
