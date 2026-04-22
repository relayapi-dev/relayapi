// Tests for `parseGraphSaveResponse` (Plan 6 — Task 7, F8 fix).
//
// The helper sits between the raw `fetch` response and the autosave flow.
// It must never throw — callers rely on the discriminated union to decide
// what to do next.

import { describe, expect, it } from "bun:test";
import type { AutomationGraph, AutomationValidation } from "./graph-types";
import { parseGraphSaveResponse } from "./graph-save-response";

function mockResponse(status: number, body: unknown): {
	status: number;
	ok?: boolean;
	json: () => Promise<unknown>;
} {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => body,
	};
}

function mockResponseThrows(status: number): {
	status: number;
	ok?: boolean;
	json: () => Promise<unknown>;
} {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => {
			throw new Error("not JSON");
		},
	};
}

const GRAPH: AutomationGraph = {
	schema_version: 1,
	root_node_key: "a",
	nodes: [
		{
			key: "a",
			kind: "message",
			canvas_x: 0,
			canvas_y: 0,
			config: {},
			ports: [],
		},
	],
	edges: [],
};

const VALID: AutomationValidation = {
	valid: true,
	errors: [],
	warnings: [],
};

const INVALID: AutomationValidation = {
	valid: false,
	errors: [
		{
			node_key: "a",
			code: "orphan_node",
			message: "Node has no incoming edges",
		},
	],
	warnings: [],
};

describe("parseGraphSaveResponse", () => {
	it("returns kind=saved on 200 with canonical graph + validation", async () => {
		const res = mockResponse(200, {
			graph: GRAPH,
			validation: VALID,
			automation: { status: "active", validation_errors: null },
		});
		const out = await parseGraphSaveResponse(res);
		expect(out.kind).toBe("saved");
		if (out.kind === "saved") {
			expect(out.graph).toEqual(GRAPH);
			expect(out.validation).toEqual(VALID);
			expect(out.automation_status).toBe("active");
		}
	});

	it("returns kind=saved_with_errors on 422 with canonical graph + paused status", async () => {
		const res = mockResponse(422, {
			graph: GRAPH,
			validation: INVALID,
			automation: {
				status: "paused",
				validation_errors: INVALID.errors,
			},
		});
		const out = await parseGraphSaveResponse(res);
		expect(out.kind).toBe("saved_with_errors");
		if (out.kind === "saved_with_errors") {
			expect(out.graph).toEqual(GRAPH);
			expect(out.validation).toEqual(INVALID);
			expect(out.automation_status).toBe("paused");
		}
	});

	it("returns kind=error on 500 with error message from body", async () => {
		const res = mockResponse(500, {
			error: { code: "INTERNAL", message: "Something broke" },
		});
		const out = await parseGraphSaveResponse(res);
		expect(out.kind).toBe("error");
		if (out.kind === "error") {
			expect(out.message).toBe("Something broke");
		}
	});

	it("returns kind=error on 500 with generic message when body has no error.message", async () => {
		const res = mockResponse(500, { anything: "else" });
		const out = await parseGraphSaveResponse(res);
		expect(out.kind).toBe("error");
		if (out.kind === "error") {
			expect(out.message).toMatch(/HTTP 500/);
		}
	});

	it("returns kind=error when a non-ok response has non-JSON body", async () => {
		const res = mockResponseThrows(502);
		const out = await parseGraphSaveResponse(res);
		expect(out.kind).toBe("error");
		if (out.kind === "error") {
			expect(out.message).toMatch(/HTTP 502/);
		}
	});

	it("returns kind=error when 200 body is malformed (missing graph)", async () => {
		const res = mockResponse(200, { validation: VALID });
		const out = await parseGraphSaveResponse(res);
		expect(out.kind).toBe("error");
	});

	it("returns kind=error when 422 body is missing graph (should be impossible per protocol)", async () => {
		const res = mockResponse(422, {
			error: { message: "bad request" },
		});
		const out = await parseGraphSaveResponse(res);
		expect(out.kind).toBe("error");
		if (out.kind === "error") {
			expect(out.message).toBe("bad request");
		}
	});

	it("returns kind=error when the response body cannot be parsed as JSON on 200", async () => {
		const res = mockResponseThrows(200);
		const out = await parseGraphSaveResponse(res);
		expect(out.kind).toBe("error");
	});

	it("defaults automation_status to 'paused' on 422 when body omits it", async () => {
		const res = mockResponse(422, {
			graph: GRAPH,
			validation: INVALID,
		});
		const out = await parseGraphSaveResponse(res);
		expect(out.kind).toBe("saved_with_errors");
		if (out.kind === "saved_with_errors") {
			expect(out.automation_status).toBe("paused");
		}
	});
});
