/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	OPERATOR_RESOLUTION_ACTIONS,
	OPERATOR_RESOLUTION_ACTIONS_BY_TARGET,
	OPERATOR_RESOLUTION_NOTE_RETENTION_MS,
	OPERATOR_RESOLUTION_REASON_CODES,
	OPERATOR_RESOLUTION_TARGET_TYPES,
} from "./operator-resolution-contracts";
import { getPrivacyRetentionStore } from "./privacy-retention-registry";
import {
	operatorResolutionEvidence,
	operatorResolutionNotes,
	stripeEvents,
} from "./schema";

test("operator resolution evidence has a closed target/action matrix", () => {
	const config = getTableConfig(operatorResolutionEvidence);
	const checks = config.checks.map(({ name }) => name);

	expect(
		config.columns.find(({ name }) => name === "target_type")?.enumValues,
	).toEqual([...OPERATOR_RESOLUTION_TARGET_TYPES]);
	expect(
		config.columns.find(({ name }) => name === "action")?.enumValues,
	).toEqual([...OPERATOR_RESOLUTION_ACTIONS]);
	expect(
		config.columns.find(({ name }) => name === "reason_code")?.enumValues,
	).toEqual([...OPERATOR_RESOLUTION_REASON_CODES]);
	expect(checks).toEqual(
		expect.arrayContaining([
			"operator_resolution_evidence_target_type_check",
			"operator_resolution_evidence_action_check",
			"operator_resolution_evidence_target_action_check",
			"operator_resolution_evidence_reason_check",
			"operator_resolution_evidence_state_check",
			"operator_resolution_evidence_stripe_abandon_check",
			"operator_resolution_evidence_timestamp_order_check",
		]),
	);
	expect(config.foreignKeys).toHaveLength(0);
	expect(Object.keys(OPERATOR_RESOLUTION_ACTIONS_BY_TARGET).sort()).toEqual(
		[...OPERATOR_RESOLUTION_TARGET_TYPES].sort(),
	);
	expect(
		OPERATOR_RESOLUTION_ACTIONS_BY_TARGET.customer_webhook_delivery,
	).toEqual(["mark_succeeded", "mark_not_applied", "retry", "abandon"]);
	expect(OPERATOR_RESOLUTION_ACTIONS_BY_TARGET.stripe_event).toEqual([
		"retry",
		"abandon",
	]);
	expect(getTableConfig(stripeEvents).checks.map(({ name }) => name)).toContain(
		"stripe_events_terminal_failure_check",
	);
});

test("operator prose is encrypted, independently erasable, and expires after 90 days", () => {
	const config = getTableConfig(operatorResolutionNotes);
	expect(config.columns.map(({ name }) => name)).toEqual(
		expect.arrayContaining([
			"evidence_id",
			"organization_id",
			"note_ciphertext",
			"created_at",
			"expires_at",
		]),
	);
	expect(config.checks.map(({ name }) => name)).toEqual(
		expect.arrayContaining([
			"operator_resolution_notes_ciphertext_check",
			"operator_resolution_notes_expiry_check",
		]),
	);
	expect(OPERATOR_RESOLUTION_NOTE_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1_000);
	expect(
		getPrivacyRetentionStore("postgres:public.operator_resolution_notes"),
	).toMatchObject({
		rowPolicy: "ttl_delete",
		retentionExecution: "scheduled",
		purge: "ttl",
		legalHold: "never",
		secretFields: ["token_or_payload"],
		ephemeral: true,
	});
});

test("operator evidence is a minimized retained receipt, not a purge omission", () => {
	const policy = getPrivacyRetentionStore(
		"postgres:public.operator_resolution_evidence",
	);
	expect(policy).toMatchObject({
		rowPolicy: "retained_record",
		purge: "retained_receipt",
		legalHold: "never",
		secretFields: [],
	});
});
