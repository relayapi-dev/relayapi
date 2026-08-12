import { describe, expect, test } from "bun:test";
import type { Database } from "@relayapi/db";
import {
	automationInternalEventOccurrenceId,
	MAX_INTERNAL_EVENT_DEPTH,
	parseDurableInternalEventPayload,
	stageInternalEvent,
} from "../services/automations/internal-events";
import { automationDeferredEnrollmentOccurrenceId } from "../services/automations/runner";
import type { InboundEvent } from "../services/automations/trigger-matcher";
import type { RunContext } from "../services/automations/types";

describe("durable automation internal events", () => {
	test("validates the versioned tag/field payload and depth bound", () => {
		expect(
			parseDurableInternalEventPayload({
				version: 1,
				kind: "tag_applied",
				action_id: "add-vip",
				event_depth: 1,
				tag_id: "vip",
			}),
		).toEqual({
			version: 1,
			kind: "tag_applied",
			action_id: "add-vip",
			event_depth: 1,
			tag_id: "vip",
		});
		expect(
			parseDurableInternalEventPayload({
				version: 1,
				kind: "field_changed",
				action_id: "set-tier",
				event_depth: MAX_INTERNAL_EVENT_DEPTH,
				field_key: "tier",
				field_value_before: null,
				field_value_after: "gold",
			}),
		).not.toBeNull();
		expect(
			parseDurableInternalEventPayload({
				version: 1,
				kind: "tag_removed",
				action_id: "remove-vip",
				event_depth: MAX_INTERNAL_EVENT_DEPTH + 1,
				tag_id: "vip",
			}),
		).toBeNull();
		expect(
			parseDurableInternalEventPayload({
				version: 1,
				kind: "field_changed",
				action_id: "clear-tier",
				event_depth: 2,
				field_key: "tier",
				field_value_before: "gold",
			}),
		).toBeNull();
	});

	test("uses one stable occurrence for an exact action execution", () => {
		const ctx = {
			runId: "arun_source",
			effectIdempotencyKeyFor: (component: string) =>
				`node-execution:${component}`,
		};
		const first = automationInternalEventOccurrenceId(
			ctx,
			"tag_applied",
			"add-vip",
		);
		expect(
			automationInternalEventOccurrenceId(ctx, "tag_applied", "add-vip"),
		).toBe(first);
		expect(
			automationInternalEventOccurrenceId(ctx, "tag_removed", "add-vip"),
		).not.toBe(first);
	});

	test("gives each matched automation run its own deferred resume occurrence", () => {
		// Both runs may legitimately share one trigger_occurrence_id because that
		// uniqueness domain is (automation_id, trigger_occurrence_id). Resume-job
		// uniqueness must therefore derive from the created run, not the trigger.
		const first = automationDeferredEnrollmentOccurrenceId("arun_first");
		const second = automationDeferredEnrollmentOccurrenceId("arun_second");
		expect(first).toBe("initial-run:arun_first");
		expect(second).toBe("initial-run:arun_second");
		expect(second).not.toBe(first);
	});

	test("stages the incremented depth and refuses an event beyond the cap", async () => {
		const rows: Array<Record<string, unknown>> = [];
		const db = {
			insert: () => ({
				values: (row: Record<string, unknown>) => {
					rows.push(row);
					return {
						onConflictDoNothing: async () => undefined,
					};
				},
			}),
		} as unknown as Pick<Database, "insert">;
		const ctx = {
			runId: "arun_source",
			automationId: "auto_source",
			organizationId: "org_source",
			workspaceId: "ws_source",
			now: new Date("2026-07-28T00:00:00.000Z"),
			effectIdempotencyKeyFor: (component: string) =>
				`node-execution:${component}`,
		} as Pick<
			RunContext,
			| "runId"
			| "automationId"
			| "organizationId"
			| "workspaceId"
			| "now"
			| "effectIdempotencyKeyFor"
		>;
		const event = {
			kind: "tag_applied",
			channel: "instagram",
			organizationId: "org_source",
			socialAccountId: null,
			contactId: "ct_source",
			conversationId: null,
			tagId: "vip",
			payload: { _event_depth: MAX_INTERNAL_EVENT_DEPTH - 1 },
		} satisfies InboundEvent;

		expect(await stageInternalEvent(db, ctx, event, "add-vip")).toBe(true);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.jobType).toBe("internal_event");
		expect(rows[0]?.scopeKey).toBe("ws/ws_source");
		expect(rows[0]?.payload).toMatchObject({
			version: 1,
			event_depth: MAX_INTERNAL_EVENT_DEPTH,
			tag_id: "vip",
		});

		expect(
			await stageInternalEvent(
				db,
				ctx,
				{
					...event,
					payload: { _event_depth: MAX_INTERNAL_EVENT_DEPTH },
				},
				"add-vip",
			),
		).toBe(false);
		expect(rows).toHaveLength(1);
	});
});
