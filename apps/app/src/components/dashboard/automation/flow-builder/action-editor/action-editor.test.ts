// Action-editor pure-helper tests (Plan 2 — Unit B4, Phase O).
//
// React Testing Library isn't installed in apps/app, so we cover only the
// pure helpers here — the default-action factory, the summariser, the
// validator, and the reorder helper. Render tests for the list + forms
// will land when RTL is wired up.

import { describe, expect, it } from "bun:test";
import {
	defaultActionFor,
	generateActionId,
	reorder,
	summarizeAction,
	validateAction,
	type Action,
	type ActionType,
} from "./types";

// ---------------------------------------------------------------------------
// defaultActionFor
// ---------------------------------------------------------------------------

describe("defaultActionFor", () => {
	it("returns a tag_add action with an empty tag", () => {
		const a = defaultActionFor("tag_add");
		expect(a.type).toBe("tag_add");
		if (a.type === "tag_add") {
			expect(a.tag).toBe("");
		}
		expect(a.on_error).toBe("abort");
		expect(a.id).toBeTruthy();
	});

	it("returns a field_set action with empty field + value", () => {
		const a = defaultActionFor("field_set");
		expect(a.type).toBe("field_set");
		if (a.type === "field_set") {
			expect(a.field).toBe("");
			expect(a.value).toBe("");
		}
	});

	it("returns a webhook_out action with POST + none auth", () => {
		const a = defaultActionFor("webhook_out");
		expect(a.type).toBe("webhook_out");
		if (a.type === "webhook_out") {
			expect(a.method).toBe("POST");
			expect(a.auth.mode).toBe("none");
			expect(a.headers).toEqual({});
		}
	});

	it("returns a conversation_snooze action with 60m default", () => {
		const a = defaultActionFor("conversation_snooze");
		expect(a.type).toBe("conversation_snooze");
		if (a.type === "conversation_snooze") {
			expect(a.snooze_minutes).toBe(60);
		}
	});

	it("returns a delete_contact action with confirm=true", () => {
		const a = defaultActionFor("delete_contact");
		expect(a.type).toBe("delete_contact");
		if (a.type === "delete_contact") {
			expect(a.confirm).toBe(true);
		}
	});

	it("returns an opt_in_channel action with instagram default", () => {
		const a = defaultActionFor("opt_in_channel");
		expect(a.type).toBe("opt_in_channel");
		if (a.type === "opt_in_channel") {
			expect(a.channel).toBe("instagram");
		}
	});

	it("preserves the existing id when passed", () => {
		const a = defaultActionFor("tag_add", "reused-id");
		expect(a.id).toBe("reused-id");
	});

	it("covers all 22 action types without throwing", () => {
		const types: ActionType[] = [
			"tag_add",
			"tag_remove",
			"field_set",
			"field_clear",
			"segment_add",
			"segment_remove",
			"subscribe_list",
			"unsubscribe_list",
			"opt_in_channel",
			"opt_out_channel",
			"assign_conversation",
			"unassign_conversation",
			"conversation_open",
			"conversation_close",
			"conversation_snooze",
			"notify_admin",
			"webhook_out",
			"pause_automations_for_contact",
			"resume_automations_for_contact",
			"delete_contact",
			"log_conversion_event",
			"change_main_menu",
		];
		expect(types).toHaveLength(22);
		for (const t of types) {
			const a = defaultActionFor(t);
			expect(a.type).toBe(t);
			expect(a.id).toBeTruthy();
		}
	});
});

// ---------------------------------------------------------------------------
// generateActionId
// ---------------------------------------------------------------------------

describe("generateActionId", () => {
	it("generates mostly-unique ids", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 50; i++) ids.add(generateActionId());
		expect(ids.size).toBeGreaterThan(40);
	});
});

// ---------------------------------------------------------------------------
// summarizeAction
// ---------------------------------------------------------------------------

describe("summarizeAction", () => {
	it("summarises tag_add with the tag name in quotes", () => {
		const a: Action = {
			id: "a1",
			type: "tag_add",
			on_error: "abort",
			tag: "lead",
		};
		expect(summarizeAction(a)).toBe('Add tag "lead"');
	});

	it("falls back to the generic label when a tag is missing", () => {
		const a: Action = {
			id: "a2",
			type: "tag_remove",
			on_error: "abort",
			tag: "",
		};
		expect(summarizeAction(a)).toBe("Remove tag");
	});

	it("summarises field_set with field = value", () => {
		const a: Action = {
			id: "a3",
			type: "field_set",
			on_error: "abort",
			field: "stage",
			value: "new",
		};
		expect(summarizeAction(a)).toBe("Set stage = new");
	});

	it("summarises webhook_out with method + url", () => {
		const a: Action = {
			id: "a4",
			type: "webhook_out",
			on_error: "abort",
			url: "https://example.com/hook",
			method: "POST",
			headers: {},
			auth: { mode: "none" },
		};
		expect(summarizeAction(a)).toBe("POST https://example.com/hook");
	});

	it("summarises conversation_snooze with minutes", () => {
		const a: Action = {
			id: "a5",
			type: "conversation_snooze",
			on_error: "abort",
			snooze_minutes: 120,
		};
		expect(summarizeAction(a)).toBe("Snooze 120m");
	});

	it("recognises round-robin assign", () => {
		const a: Action = {
			id: "a6",
			type: "assign_conversation",
			on_error: "abort",
			user_id: "round_robin",
		};
		expect(summarizeAction(a)).toBe("Assign round-robin");
	});

	it("recognises global pause scope", () => {
		const a: Action = {
			id: "a7",
			type: "pause_automations_for_contact",
			on_error: "abort",
			scope: "global",
		};
		expect(summarizeAction(a)).toBe("Pause all automations for contact");
	});

	it("labels change_main_menu with the v1.1 badge", () => {
		const a: Action = {
			id: "a8",
			type: "change_main_menu",
			on_error: "abort",
		};
		expect(summarizeAction(a)).toBe("Change main menu (v1.1)");
	});
});

// ---------------------------------------------------------------------------
// validateAction
// ---------------------------------------------------------------------------

describe("validateAction", () => {
	it("flags an empty tag as required", () => {
		const a: Action = {
			id: "a1",
			type: "tag_add",
			on_error: "abort",
			tag: "",
		};
		const problems = validateAction(a);
		expect(problems).toHaveLength(1);
		expect(problems[0]?.path).toBe("tag");
	});

	it("flags field_set missing field + value", () => {
		const a: Action = {
			id: "a2",
			type: "field_set",
			on_error: "abort",
			field: "",
			value: "",
		};
		const problems = validateAction(a);
		expect(problems.map((p) => p.path).sort()).toEqual(["field", "value"]);
	});

	it("rejects non-http urls in webhook_out", () => {
		const a: Action = {
			id: "a3",
			type: "webhook_out",
			on_error: "abort",
			url: "example.com",
			method: "POST",
			headers: {},
			auth: { mode: "none" },
		};
		const problems = validateAction(a);
		expect(problems.some((p) => p.path === "url")).toBe(true);
	});

	it("requires a bearer token when auth.mode is bearer", () => {
		const a: Action = {
			id: "a4",
			type: "webhook_out",
			on_error: "abort",
			url: "https://ex.com",
			method: "POST",
			headers: {},
			auth: { mode: "bearer" },
		};
		const problems = validateAction(a);
		expect(problems.some((p) => p.path === "auth.token")).toBe(true);
	});

	it("accepts a valid webhook_out", () => {
		const a: Action = {
			id: "a5",
			type: "webhook_out",
			on_error: "abort",
			url: "https://ex.com",
			method: "POST",
			headers: {},
			auth: { mode: "none" },
		};
		expect(validateAction(a)).toEqual([]);
	});

	it("requires confirm=true for delete_contact", () => {
		const a: Action = {
			id: "a6",
			type: "delete_contact",
			on_error: "abort",
			// Simulate an operator clearing the confirm checkbox.
			confirm: false as unknown as true,
		};
		const problems = validateAction(a);
		expect(problems.some((p) => p.path === "confirm")).toBe(true);
	});

	it("accepts conversation_open with no fields", () => {
		const a: Action = {
			id: "a7",
			type: "conversation_open",
			on_error: "abort",
		};
		expect(validateAction(a)).toEqual([]);
	});

	it("flags snooze < 1 minute", () => {
		const a: Action = {
			id: "a8",
			type: "conversation_snooze",
			on_error: "abort",
			snooze_minutes: 0,
		};
		const problems = validateAction(a);
		expect(problems.some((p) => p.path === "snooze_minutes")).toBe(true);
	});

	it("flags log_conversion_event missing name", () => {
		const a: Action = {
			id: "a9",
			type: "log_conversion_event",
			on_error: "abort",
			event_name: "",
		};
		const problems = validateAction(a);
		expect(problems.some((p) => p.path === "event_name")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// reorder
// ---------------------------------------------------------------------------

describe("reorder", () => {
	it("moves an element from one index to another", () => {
		expect(reorder(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
		expect(reorder(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
	});

	it("is a no-op when from === to", () => {
		const list = ["a", "b"];
		expect(reorder(list, 0, 0)).toBe(list);
	});

	it("clamps out-of-range destinations", () => {
		expect(reorder(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
	});

	it("returns the same reference when from is out of range", () => {
		const list = ["a", "b"];
		expect(reorder(list, 5, 0)).toBe(list);
	});
});
