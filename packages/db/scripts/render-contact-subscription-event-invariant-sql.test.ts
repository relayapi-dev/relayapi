/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
	CONTACT_SUBSCRIPTION_EVENT_APPEND_ONLY_CONTRACT,
	renderContactSubscriptionEventInvariantSql,
} from "./render-contact-subscription-event-invariant-sql";

test("renders append-only but privacy-drainable subscription evidence", () => {
	const sql = renderContactSubscriptionEventInvariantSql();
	expect(CONTACT_SUBSCRIPTION_EVENT_APPEND_ONLY_CONTRACT.tableName).toBe(
		"contact_subscription_events",
	);
	expect(sql).toContain("contact subscription events are append-only");
	expect(sql).toContain(
		'BEFORE UPDATE ON "public"."contact_subscription_events"',
	);
	expect(sql).not.toContain(
		'BEFORE UPDATE OR DELETE ON "public"."contact_subscription_events"',
	);
});
