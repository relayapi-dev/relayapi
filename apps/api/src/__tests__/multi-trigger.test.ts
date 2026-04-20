import { describe, expect, it } from "bun:test";
import {
	getEnrollmentTriggerId,
	resolveEnrollmentTrigger,
	selectDirectEnrollmentTrigger,
	withStoredEnrollmentTriggerId,
	type DirectEnrollmentTrigger,
} from "../services/automations/resolve-trigger";
import type { AutomationSnapshot } from "../services/automations/types";

const directTriggers: DirectEnrollmentTrigger[] = [
	{ id: "atrg_dm", type: "instagram_dm", order_index: 1 },
	{ id: "atrg_comment", type: "instagram_comment", order_index: 0 },
];

const snapshot: AutomationSnapshot = {
	automation_id: "aut_123",
	version: 1,
	name: "Multi Trigger Test",
	channel: "instagram",
	triggers: [
		{
			id: "atrg_dm",
			type: "instagram_dm",
			account_id: "acc_dm",
			config: {},
			filters: {},
			label: "DM Trigger",
			order_index: 1,
		},
		{
			id: "atrg_comment",
			type: "instagram_comment",
			account_id: "acc_comment",
			config: {},
			filters: {},
			label: "Comment Trigger",
			order_index: 0,
		},
	],
	entry_node_key: "trigger",
	nodes: [],
	edges: [],
};

describe("multi-trigger helpers", () => {
	it("stores and recovers a trigger id from enrollment state", () => {
		const state = withStoredEnrollmentTriggerId({ source: "live_test" }, "atrg_dm");

		expect(state.source).toBe("live_test");
		expect(getEnrollmentTriggerId(null, state)).toBe("atrg_dm");
	});

	it("prefers the enrollment row trigger id over the stored fallback", () => {
		const state = withStoredEnrollmentTriggerId({}, "atrg_comment");

		expect(getEnrollmentTriggerId("atrg_dm", state)).toBe("atrg_dm");
	});

	it("selects the explicitly requested trigger for direct enrollment", () => {
		const selected = selectDirectEnrollmentTrigger(
			directTriggers,
			"atrg_dm",
		);

		expect(selected.ok).toBe(true);
		if (selected.ok) {
			expect(selected.trigger.id).toBe("atrg_dm");
		}
	});

	it("rejects direct enrollment without trigger_id when multiple triggers exist", () => {
		expect(selectDirectEnrollmentTrigger(directTriggers)).toEqual({
			ok: false,
			reason: "ambiguous_trigger",
		});
	});

	it("rejects an unknown trigger id for direct enrollment", () => {
		expect(
			selectDirectEnrollmentTrigger(directTriggers, "atrg_missing"),
		).toEqual({
			ok: false,
			reason: "invalid_trigger",
		});
	});

	it("resolves the exact snapshot trigger when the enrollment trigger id is present", () => {
		const trigger = resolveEnrollmentTrigger(snapshot, "atrg_dm");

		expect(trigger.id).toBe("atrg_dm");
		expect(trigger.account_id).toBe("acc_dm");
	});

	it("falls back to the first trigger by order when the enrollment trigger id is missing", () => {
		const trigger = resolveEnrollmentTrigger(snapshot, null);

		expect(trigger.id).toBe("atrg_comment");
		expect(trigger.account_id).toBe("acc_comment");
	});
});
