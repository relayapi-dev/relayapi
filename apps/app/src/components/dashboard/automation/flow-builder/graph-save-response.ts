// Graph save response parser (Plan 6 — Task 7, F8 fix).
//
// The API's `PUT /v1/automations/{id}/graph` endpoint has three meaningful
// outcomes:
//
//   1. 200 — graph was valid and saved as-is (the server still returns the
//      canonical graph so the client can pick up any normalization the API
//      did, e.g. auto-derived ports).
//   2. 422 — graph was saved anyway (the API always persists the canonical
//      form) but has fatal validation errors; if the automation was active,
//      the API force-pauses it. The client MUST absorb the returned graph +
//      validation + status rather than treating the response as a hard fail.
//   3. Anything else (500, 401, 404, network error) — a real failure; the
//      local graph state should not be mutated.
//
// Before the Round 3 fix, the client treated 422 as a throwable error and
// the canonical graph / paused status never made it back into the store.
// Now we parse once and surface a discriminated union so the caller can act
// on each case explicitly.

import type { AutomationGraph, AutomationValidation } from "./graph-types";

export type GraphSaveResult =
	| {
			kind: "saved";
			graph: AutomationGraph;
			validation: AutomationValidation;
			automation_status: string;
	  }
	| {
			kind: "saved_with_errors";
			graph: AutomationGraph;
			validation: AutomationValidation;
			automation_status: string;
	  }
	| { kind: "error"; message: string };

interface GraphUpdateBody {
	graph?: AutomationGraph;
	validation?: AutomationValidation;
	automation?: { status?: string };
	error?: { message?: string; code?: string };
}

/**
 * Parse the response from `PUT /api/automations/{id}/graph`.
 *
 * Accepts a minimal `Response`-like so tests can pass a stub without needing
 * a real `Response` constructor.
 */
export async function parseGraphSaveResponse(
	res: { status: number; ok?: boolean; json: () => Promise<unknown> },
): Promise<GraphSaveResult> {
	if (res.status === 200) {
		try {
			const body = (await res.json()) as GraphUpdateBody;
			if (!body.graph || !body.validation) {
				return {
					kind: "error",
					message: "Save succeeded but response body was missing fields",
				};
			}
			return {
				kind: "saved",
				graph: body.graph,
				validation: body.validation,
				automation_status: body.automation?.status ?? "unknown",
			};
		} catch (_err) {
			return {
				kind: "error",
				message: "Save response could not be parsed as JSON",
			};
		}
	}

	if (res.status === 422) {
		try {
			const body = (await res.json()) as GraphUpdateBody;
			if (!body.graph || !body.validation) {
				// 422 without a structured body is still an error; the server
				// protocol promises graph + validation on 422.
				return {
					kind: "error",
					message:
						body.error?.message ?? `Validation failure (HTTP ${res.status})`,
				};
			}
			return {
				kind: "saved_with_errors",
				graph: body.graph,
				validation: body.validation,
				automation_status: body.automation?.status ?? "paused",
			};
		} catch (_err) {
			return {
				kind: "error",
				message: `Validation failure (HTTP ${res.status})`,
			};
		}
	}

	// Anything else: try to extract a useful error message, fall back to HTTP
	// status.
	let message = `Failed to save graph (HTTP ${res.status})`;
	try {
		const body = (await res.json()) as GraphUpdateBody;
		if (body?.error?.message) message = body.error.message;
	} catch {
		// Non-JSON error body — fall through with the generic message.
	}
	return { kind: "error", message };
}
