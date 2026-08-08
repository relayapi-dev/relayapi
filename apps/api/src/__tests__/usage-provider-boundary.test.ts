import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { usageReservations } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	isParkedUsageWriteOffDue,
	PARKED_USAGE_WRITE_OFF_AFTER_MS,
	persistedUsageOutcome,
	reserveMutationUsage,
	staleUsageReservationOutcome,
} from "../services/usage-meter";

describe("durable tool usage provider boundary", () => {
	it("releases a crash that occurred before the durable provider boundary", () => {
		expect(staleUsageReservationOutcome(null)).toEqual({
			state: "released",
			disposition: "pre_boundary",
			responseStatus: null,
			committedUnits: 0,
		});
	});

	it("parks after the boundary when request-local state was lost", () => {
		const boundary = new Date("2026-07-29T12:00:00.000Z");
		expect(
			persistedUsageOutcome(
				boundary,
				{
					commit: false,
					reason: "pre_boundary",
					responseStatus: 500,
				},
				1,
			),
		).toEqual({
			state: "parked",
			disposition: "unknown",
			responseStatus: null,
			committedUnits: null,
		});
	});

	it("releases a provider-armed request after a definitive 4xx rejection", () => {
		const boundary = new Date("2026-07-29T12:00:00.000Z");
		expect(
			persistedUsageOutcome(
				boundary,
				{
					commit: false,
					reason: "rejected",
					responseStatus: 422,
				},
				1,
			),
		).toEqual({
			state: "released",
			disposition: "rejected",
			responseStatus: 422,
			committedUnits: 0,
		});
	});

	it("releases an armed request only with explicit not-applied 5xx evidence", () => {
		const boundary = new Date("2026-07-29T12:00:00.000Z");
		expect(
			persistedUsageOutcome(
				boundary,
				{
					commit: false,
					reason: "proven_not_applied",
					responseStatus: 503,
				},
				1,
			),
		).toEqual({
			state: "released",
			disposition: "proven_not_applied",
			responseStatus: 503,
			committedUnits: 0,
		});
	});

	it("parks a crash after provider call start for reconciliation", () => {
		expect(
			staleUsageReservationOutcome(new Date("2026-07-29T12:00:00.000Z")),
		).toEqual({
			state: "parked",
			disposition: "unknown",
			responseStatus: null,
			committedUnits: null,
		});
	});

	it("records partial K while implicitly releasing N minus K", () => {
		expect(
			persistedUsageOutcome(
				null,
				{
					commit: true,
					reason: "settled",
					responseStatus: 200,
					committedUnits: 600,
				},
				1_000,
			),
		).toEqual({
			state: "committed",
			disposition: "settled",
			responseStatus: 200,
			committedUnits: 600,
		});
	});

	it("rejects a committed K above the immutable reservation N", () => {
		expect(() =>
			persistedUsageOutcome(
				null,
				{
					commit: true,
					reason: "settled",
					responseStatus: 200,
					committedUnits: 1_001,
				},
				1_000,
			),
		).toThrow("cannot exceed reserved units");
	});

	it("rejects reservation counts outside JavaScript's exact integer range", async () => {
		await expect(
			reserveMutationUsage(null as never, {
				organizationId: "org_test",
				idempotencyKey: "request:unsafe",
				units: Number.MAX_SAFE_INTEGER + 1,
				quotaMode: "hard",
				includedUnits: 200,
				periodStart: new Date("2026-07-01T00:00:00.000Z"),
				periodEnd: new Date("2026-08-01T00:00:00.000Z"),
			}),
		).rejects.toThrow("positive safe integer");
	});

	it("never writes off an ambiguous provider outcome before the full 30-day window", () => {
		const now = new Date("2026-07-31T12:00:00.000Z");
		const exactCutoff = new Date(
			now.getTime() - PARKED_USAGE_WRITE_OFF_AFTER_MS,
		);
		expect(isParkedUsageWriteOffDue(exactCutoff, exactCutoff, now)).toBe(true);
		const oneMillisecondTooRecent = new Date(exactCutoff.getTime() + 1);
		expect(
			isParkedUsageWriteOffDue(exactCutoff, oneMillisecondTooRecent, now),
		).toBe(false);
		expect(
			isParkedUsageWriteOffDue(
				oneMillisecondTooRecent,
				oneMillisecondTooRecent,
				now,
			),
		).toBe(false);
	});

	it("keeps boundary and disposition in the authoritative ledger", () => {
		const config = getTableConfig(usageReservations);
		expect(config.columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"committed_units",
				"disposition",
				"request_may_have_been_sent_at",
				"write_off_reason",
				"write_off_evidence",
				"written_off_at",
			]),
		);
		expect(config.checks.map((check) => check.name)).toEqual(
			expect.arrayContaining([
				"usage_reservations_finalization_check",
				"usage_reservations_boundary_timestamp_check",
			]),
		);
		expect(config.indexes.map((index) => index.config.name)).toContain(
			"usage_reservations_parked_age_idx",
		);
		expect(config.indexes.map((index) => index.config.name)).toContain(
			"usage_reservations_reserved_age_idx",
		);
	});

	it("globally converges stale reservations in due order without stealing live tool jobs", () => {
		const source = readFileSync(
			new URL("../services/usage-meter.ts", import.meta.url),
			"utf8",
		);
		const reconciliationSource = source.slice(
			source.indexOf(
				"export async function reconcileStaleReservedUsageReservations",
			),
			source.indexOf(
				"export async function writeOffExpiredParkedUsageReservations",
			),
		);
		expect(reconciliationSource).toContain(
			".orderBy(asc(usageReservations.reservedAt), asc(usageReservations.id))",
		);
		expect(reconciliationSource).toContain(".limit(limit)");
		expect(reconciliationSource).toContain(
			"live_tool_job.status IN ('pending', 'processing')",
		);
		expect(
			reconciliationSource.indexOf("const [bucket] = await tx"),
		).toBeLessThan(
			reconciliationSource.indexOf("const [reservation] = await tx"),
		);
		expect(reconciliationSource).toContain("staleUsageReservationOutcome(");
	});

	it("uses bounded due order and bucket-first fencing for automatic write-offs", () => {
		const source = readFileSync(
			new URL("../services/usage-meter.ts", import.meta.url),
			"utf8",
		);
		const writeOffSource = source.slice(
			source.indexOf(
				"export async function writeOffExpiredParkedUsageReservations",
			),
			source.indexOf("export function successfulMutationDisposition"),
		);
		expect(writeOffSource).toContain(
			".orderBy(asc(usageReservations.reservedAt), asc(usageReservations.id))",
		);
		expect(writeOffSource).toContain(".limit(limit)");
		expect(writeOffSource).toContain(
			"lte(usageReservations.reservedAt, cutoff)",
		);
		expect(writeOffSource).toContain(
			"lte(usageReservations.requestMayHaveBeenSentAt, cutoff)",
		);
		expect(writeOffSource).toContain('state: "released"');
		expect(writeOffSource).toContain('disposition: "written_off"');
		expect(writeOffSource).toContain("writtenOffAt,");
		expect(writeOffSource).toContain("finalizedAt: writtenOffAt");
		expect(writeOffSource.indexOf("const [bucket] = await tx")).toBeLessThan(
			writeOffSource.indexOf("const [reservation] = await tx"),
		);
	});

	it("does not generically reclaim a reservation owned by a live async tool job", () => {
		const usageSource = readFileSync(
			new URL("../services/usage-meter.ts", import.meta.url),
			"utf8",
		);
		const invoiceSource = readFileSync(
			new URL("../services/invoice-generator.ts", import.meta.url),
			"utf8",
		);
		for (const source of [usageSource, invoiceSource]) {
			expect(source).toContain("NOT EXISTS (");
			expect(source).toContain("live_tool_job.usage_reservation_id");
			expect(source).toContain(
				"live_tool_job.status IN ('pending', 'processing')",
			);
		}
	});
});
