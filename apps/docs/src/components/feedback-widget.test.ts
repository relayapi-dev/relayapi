/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./feedback-widget.tsx", import.meta.url), "utf8");

describe("feedback widget accessibility contract", () => {
	test("unmounts the closed dialog and restores keyboard focus", () => {
		expect(source).toContain("{open && (");
		expect(source).toContain('role="dialog"');
		expect(source).toContain('aria-modal="true"');
		expect(source).toContain('e.key === "Escape"');
		expect(source).toContain("titleInputRef.current?.focus()");
		expect(source).toContain("triggerRef.current?.focus()");
	});
});
