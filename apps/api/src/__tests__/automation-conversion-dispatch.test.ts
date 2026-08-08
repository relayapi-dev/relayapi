import { describe, expect, it } from "bun:test";
import { automationConversionEvents } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { ASYNC_LIFECYCLE_REGISTRY } from "../lib/async-contract-registry";
import { allowedOperatorResolutionActions } from "../services/operator-resolution";

describe("automation conversion trigger outbox", () => {
	it("stores the reconstructable event and a fenced bounded dispatch lifecycle", () => {
		const config = getTableConfig(automationConversionEvents);
		const columns = new Set(config.columns.map(({ name }) => name));
		for (const column of [
			"channel",
			"social_account_id",
			"conversation_id",
			"event_depth",
			"dispatch_status",
			"dispatch_attempts",
			"dispatch_lease_token",
			"dispatch_lease_expires_at",
			"next_dispatch_at",
			"dispatch_deadline_at",
			"dispatched_at",
			"last_dispatch_error",
		]) {
			expect(columns.has(column)).toBe(true);
		}
		expect(config.checks.map(({ name }) => name)).toEqual(
			expect.arrayContaining([
				"automation_conversion_events_dispatch_status_check",
				"automation_conversion_events_dispatch_counters_check",
				"automation_conversion_events_dispatch_state_check",
				"automation_conversion_events_dispatch_timestamps_check",
			]),
		);
		expect(config.indexes.map(({ config: index }) => index.name)).toEqual(
			expect.arrayContaining([
				"automation_conversion_events_dispatch_due_idx",
				"automation_conversion_events_dispatch_deadline_idx",
				"automation_conversion_events_manual_review_idx",
			]),
		);
		expect(config.foreignKeys.map(({ reference }) => reference().name)).toEqual(
			["automation_conversion_events_run_auto_contact_org_scope_fk"],
		);
		expect(config.foreignKeys[0]?.onUpdate).toBe("cascade");
	});

	it("claims atomically, fences completion, defers child runs, and has a cron drain", async () => {
		const dispatchSource = await Bun.file(
			new URL("../services/automation-conversion-dispatch.ts", import.meta.url),
		).text();
		const actionSource = await Bun.file(
			new URL("../services/automations/actions/conversion.ts", import.meta.url),
		).text();
		const scheduledSource = await Bun.file(
			new URL("../scheduled/index.ts", import.meta.url),
		).text();

		expect(dispatchSource).toContain("FOR UPDATE OF event SKIP LOCKED");
		expect(dispatchSource).toContain("row_number() OVER");
		expect(dispatchSource).toContain("PARTITION BY event.organization_id");
		expect(dispatchSource).toContain("dispatch_lease_token =");
		expect(dispatchSource).toContain("event.dispatch_lease_token =");
		expect(dispatchSource).toContain("deferRun: true");
		expect(dispatchSource).toContain("dispatch_status = 'manual_review'");
		expect(dispatchSource).toContain(
			"AUTOMATION_CONVERSION_DISPATCH_MAX_ATTEMPTS",
		);
		expect(
			actionSource.indexOf(".insert(automationConversionEvents)"),
		).toBeLessThan(
			actionSource.indexOf("await processAutomationConversionDispatch"),
		);
		expect(scheduledSource).toContain("automation_conversion_dispatch");
		expect(scheduledSource).toContain(
			"processDueAutomationConversionEvents(env)",
		);
	});

	it("is classified as an outbox and exposes only the safe operator retry", () => {
		expect(
			ASYNC_LIFECYCLE_REGISTRY.find(
				({ table }) => table === "automation_conversion_events",
			),
		).toMatchObject({
			contract: "transactional_outbox",
			owner: "automations",
		});
		expect(
			allowedOperatorResolutionActions({
				targetType: "automation_conversion_event",
				status: "manual_review",
			}),
		).toEqual(["retry"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "automation_conversion_event",
				status: "succeeded",
			}),
		).toEqual([]);
	});
});
