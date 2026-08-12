/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { openapi, specUrl } from "./openapi";

describe("deployed OpenAPI document", () => {
	test("bundles the pinned schema instead of reading the Worker filesystem", async () => {
		const input = openapi.options.input as Record<string, unknown>;

		expect(typeof input[specUrl]).toBe("object");
		await expect(openapi.getSchema(specUrl)).resolves.toMatchObject({
			bundled: {
				info: { title: "RelayAPI", version: "1.0.0" },
			},
		});
	});
});
