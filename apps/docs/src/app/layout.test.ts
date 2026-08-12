/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");

describe("theme bootstrap", () => {
	test("defines the OpenNext function-name helper before next-themes", () => {
		const helper = source.indexOf('globalThis["__name"] =');
		const provider = source.indexOf("<RootProvider");

		expect(helper).toBeGreaterThan(-1);
		expect(provider).toBeGreaterThan(helper);
	});
});
