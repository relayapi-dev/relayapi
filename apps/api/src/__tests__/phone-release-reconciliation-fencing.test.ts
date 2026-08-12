import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Database } from "@relayapi/db";
import * as dbExports from "@relayapi/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PhoneRow } from "../services/phone-number-operations";
import type { Env } from "../types";

interface CapturedUpdate {
	values: Partial<PhoneRow>;
	where: SQL;
}

let selectedRows: PhoneRow[] = [];
let selectExecutions = 0;
const updates: CapturedUpdate[] = [];
const telnyxCalls = {
	exists: 0,
	findOwned: 0,
	release: 0,
};

let fakeDb: Database;
const fakeDbImplementation = {
	select: () => {
		const builder = {
			from: (_table: unknown) => builder,
			innerJoin: (_table: unknown, _condition: unknown) => builder,
			where: (_condition: unknown) => builder,
			orderBy: (..._columns: unknown[]) => builder,
			limit: async (_limit: number) => {
				selectExecutions += 1;
				return selectedRows.map((row) => ({
					phone: row,
					provisioning: row,
					release: row,
				}));
			},
		};
		return builder;
	},
	update: (_table: unknown) => ({
		set: (values: Partial<PhoneRow>) => ({
			where: (where: SQL) => ({
				returning: async (_projection?: unknown) => {
					updates.push({ values, where });
					// Model a concurrent worker changing the durable row after the due
					// scan. The snapshot CAS must lose and return no row.
					return [];
				},
			}),
		}),
	}),
	transaction: async <T>(callback: (transaction: Database) => Promise<T>) =>
		callback(fakeDb),
};
fakeDb = fakeDbImplementation as unknown as Database;

mock.module("@relayapi/db", () => ({
	...dbExports,
	createDb: () => fakeDb,
}));

class FakeTelnyxError extends Error {
	readonly status = 500;
}

mock.module("../services/telnyx", () => ({
	findNumberOrderByCustomerReference: async () => null,
	findOwnedPhoneNumber: async () => {
		telnyxCalls.findOwned += 1;
		return null;
	},
	orderNumber: async () => {
		throw new Error("orderNumber must not be called by release reconciliation");
	},
	releaseNumber: async () => {
		telnyxCalls.release += 1;
	},
	TelnyxError: FakeTelnyxError,
	telnyxPhoneNumberExists: async () => {
		telnyxCalls.exists += 1;
		return true;
	},
}));

const { processDuePhoneReleases } = await import(
	"../services/phone-number-operations"
);

const env = {
	HYPERDRIVE: { connectionString: "postgres://unused" },
	TELNYX_API_KEY: "test_telnyx_key",
} as unknown as Env;

function phoneRow(overrides: Partial<PhoneRow>): PhoneRow {
	return {
		id: "wapn_release_1",
		organizationId: "org_1",
		phoneNumber: "+15555550123",
		releaseLeaseToken: 41,
		releaseNextAttemptAt: new Date("2026-07-13T11:00:00.000Z"),
		providerNumberId: "telnyx_number_1",
		...overrides,
	} as PhoneRow;
}

beforeEach(() => {
	selectedRows = [];
	selectExecutions = 0;
	updates.length = 0;
	telnyxCalls.exists = 0;
	telnyxCalls.findOwned = 0;
	telnyxCalls.release = 0;
});

const boundary = new Date("2026-07-13T10:55:00.000Z");
const expiredLease = new Date("2026-07-13T10:50:00.000Z");

const staleTransitions: Array<{
	name: string;
	row: PhoneRow;
	expectedState: PhoneRow["releaseState"];
	expectedTelnyxReads: number;
}> = [
	{
		name: "an expired pre-boundary processing lease",
		row: phoneRow({
			releaseState: "processing",
			releasePhase: "stripe",
			releaseLeaseExpiresAt: expiredLease,
			releaseRequestMayHaveBeenSentAt: null,
		}),
		expectedState: "failed",
		expectedTelnyxReads: 0,
	},
	{
		name: "an ambiguous Meta boundary",
		row: phoneRow({
			releaseState: "unknown",
			releasePhase: "meta",
			releaseLeaseExpiresAt: null,
			releaseRequestMayHaveBeenSentAt: boundary,
		}),
		expectedState: "manual_review",
		expectedTelnyxReads: 0,
	},
	{
		name: "an ambiguous Stripe boundary",
		row: phoneRow({
			releaseState: "request_may_have_been_sent",
			releasePhase: "stripe",
			releaseLeaseExpiresAt: expiredLease,
			releaseRequestMayHaveBeenSentAt: boundary,
		}),
		expectedState: "failed",
		expectedTelnyxReads: 0,
	},
	{
		name: "an ambiguous Telnyx boundary",
		row: phoneRow({
			releaseState: "unknown",
			releasePhase: "telnyx",
			releaseLeaseExpiresAt: null,
			releaseRequestMayHaveBeenSentAt: boundary,
		}),
		expectedState: "failed",
		expectedTelnyxReads: 1,
	},
	{
		name: "a completed provider sequence awaiting its local projection",
		row: phoneRow({
			releaseState: "unknown",
			releasePhase: "completed",
			releaseLeaseExpiresAt: null,
			releaseRequestMayHaveBeenSentAt: null,
		}),
		expectedState: "failed",
		expectedTelnyxReads: 0,
	},
];

describe("phone release reconciliation fencing", () => {
	for (const scenario of staleTransitions) {
		it(`does not apply or process ${scenario.name} after losing the snapshot CAS`, async () => {
			selectedRows = [scenario.row];

			await processDuePhoneReleases(env, { limit: 1 });

			expect(selectExecutions).toBe(1);
			expect(updates).toHaveLength(1);
			expect(updates[0]?.values.releaseState).toBe(scenario.expectedState);
			expect(telnyxCalls.exists).toBe(scenario.expectedTelnyxReads);
			expect(telnyxCalls.findOwned).toBe(0);
			expect(telnyxCalls.release).toBe(0);

			const captured = updates[0]?.where;
			if (!captured)
				throw new Error("release transition WHERE was not captured");
			const query = new PgDialect().sqlToQuery(captured);
			const normalized = query.sql.replace(/\s+/g, " ");
			expect(normalized).toContain(
				'"whatsapp_phone_release_operations"."status" =',
			);
			expect(normalized).toContain(
				'"whatsapp_phone_release_operations"."lease_token" =',
			);
			expect(normalized).toContain(
				'"whatsapp_phone_release_operations"."lease_expires_at"',
			);
			expect(normalized).toContain(
				'"whatsapp_phone_release_operations"."request_may_have_been_sent_at"',
			);
			expect(normalized).toContain(
				'"whatsapp_phone_release_operations"."phase" =',
			);
			expect(query.params).toContain(scenario.row.releaseState);
			expect(query.params).toContain(scenario.row.releaseLeaseToken);
			expect(query.params).toContain(scenario.row.releasePhase);
			if (scenario.row.releaseLeaseExpiresAt) {
				expect(query.params).toContain(
					scenario.row.releaseLeaseExpiresAt.toISOString(),
				);
			} else {
				expect(normalized).toContain(
					'"whatsapp_phone_release_operations"."lease_expires_at" is null',
				);
			}
			if (scenario.row.releaseRequestMayHaveBeenSentAt) {
				expect(query.params).toContain(
					scenario.row.releaseRequestMayHaveBeenSentAt.toISOString(),
				);
			} else {
				expect(normalized).toContain(
					'"whatsapp_phone_release_operations"."request_may_have_been_sent_at" is null',
				);
			}
		});
	}
});
