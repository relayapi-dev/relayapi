import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import {
	adCreationOperations,
	adMutationOperations,
	usageReservations,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";

type DurableSettlement = {
	reservationId: string;
	organizationId: string;
	committedUnits: number | null;
};

const settlements: DurableSettlement[] = [];

mock.module("../services/usage-meter", () => ({
	settleDurableUsageReservation: async (
		_db: unknown,
		input: DurableSettlement,
	) => {
		settlements.push({ ...input });
		return input.committedUnits === null
			? "parked"
			: input.committedUnits === 0
				? "released"
				: "committed";
	},
	settleDurableUsageReservationInTransaction: async (
		_tx: unknown,
		input: DurableSettlement,
	) => {
		settlements.push({ ...input });
		return input.committedUnits === null
			? "parked"
			: input.committedUnits === 0
				? "released"
				: "committed";
	},
}));

const { adoptDurableUsageReservation, reconcileDurableOperationUsage } =
	await import("../services/durable-operation-usage");

type Column = { name: string };
type DbRow = Record<string, unknown>;

function databaseRow(...entries: Array<[Column, unknown]>): DbRow {
	return Object.fromEntries(
		entries.map(([column, value]) => [column.name, value]),
	);
}

function createReconciliationDb(rowsByTable: Map<unknown, DbRow[]>) {
	return {
		select(fields: Record<string, Column>) {
			let sourceTable: unknown;
			let rowLimit = Number.POSITIVE_INFINITY;
			const query = {
				from(table: unknown) {
					sourceTable = table;
					return query;
				},
				innerJoin(_table: unknown, _condition: unknown) {
					return query;
				},
				where(_condition: unknown) {
					return query;
				},
				orderBy(..._columns: unknown[]) {
					return query;
				},
				limit(limit: number) {
					rowLimit = limit;
					return query;
				},
				// biome-ignore lint/suspicious/noThenProperty: deliberate Drizzle-like test thenable
				then(
					resolve: (rows: DbRow[]) => unknown,
					reject?: (error: unknown) => unknown,
				) {
					try {
						const rows = (rowsByTable.get(sourceTable) ?? [])
							.slice(0, rowLimit)
							.map((row) =>
								Object.fromEntries(
									Object.entries(fields).map(([alias, column]) => [
										alias,
										alias in row ? row[alias] : row[column.name],
									]),
								),
							);
						return Promise.resolve(resolve(rows));
					} catch (error) {
						return reject
							? Promise.resolve(reject(error))
							: Promise.reject(error);
					}
				},
			};
			return query;
		},
	};
}

function operationRows(input: {
	adCreation?: DbRow;
	adMutation?: DbRow;
	phoneProvisioning?: DbRow;
	phoneRelease?: DbRow;
}): Map<unknown, DbRow[]> {
	return new Map<unknown, DbRow[]>([
		[adCreationOperations, input.adCreation ? [input.adCreation] : []],
		[adMutationOperations, input.adMutation ? [input.adMutation] : []],
		[
			whatsappPhoneProvisioningOperations,
			input.phoneProvisioning ? [input.phoneProvisioning] : [],
		],
		[
			whatsappPhoneReleaseOperations,
			input.phoneRelease ? [input.phoneRelease] : [],
		],
		[usageReservations, [databaseRow([usageReservations.units, 1])]],
	]);
}

beforeEach(() => {
	settlements.length = 0;
});

describe("durable operation usage ownership", () => {
	it("settles already-applied route no-ops at K=0 before returning success", () => {
		const root = new URL("../../../../", import.meta.url).pathname;
		const adService = readFileSync(
			`${root}apps/api/src/services/ad-service.ts`,
			"utf8",
		);
		const cancelAd = adService.slice(
			adService.indexOf("export async function cancelAd"),
			adService.indexOf("export async function updateCampaign"),
		);
		const cancelCampaign = adService.slice(
			adService.indexOf("export async function cancelCampaign"),
		);
		for (const noOp of [cancelAd, cancelCampaign]) {
			expect(noOp).toContain('status === "cancelled"');
			expect(noOp).toContain("settleDurableUsageReservation");
			expect(noOp.indexOf("settleDurableUsageReservation")).toBeLessThan(
				noOp.indexOf("return;"),
			);
		}

		const phoneRoute = readFileSync(
			`${root}apps/api/src/routes/whatsapp-phone-provisioning.ts`,
			"utf8",
		);
		const releasedNoOp = phoneRoute.slice(
			phoneRoute.indexOf('if (row.status === "released")'),
			phoneRoute.indexOf("const releasableStatuses"),
		);
		expect(releasedNoOp).toContain("settleDurableUsageReservation");
		expect(releasedNoOp.indexOf("settleDurableUsageReservation")).toBeLessThan(
			releasedNoOp.indexOf("return c.json"),
		);
	});

	it("keeps the original reservation and terminalizes a retry reservation at K=0", async () => {
		await adoptDurableUsageReservation({} as never, "ur_original", {
			id: "ur_retry",
			bucketId: "ub_retry",
			organizationId: "org_retry",
		} as never);

		expect(settlements).toEqual([
			{
				reservationId: "ur_retry",
				organizationId: "org_retry",
				committedUnits: 0,
			},
		]);

		settlements.length = 0;
		await adoptDurableUsageReservation({} as never, "ur_original", {
			id: "ur_original",
			bucketId: "ub_original",
			organizationId: "org_retry",
		} as never);
		expect(settlements).toEqual([
			{
				reservationId: "ur_original",
				organizationId: "org_retry",
				committedUnits: null,
			},
		]);
	});

	it("maps durable provider or terminal success evidence to K=1 for every operation family", async () => {
		const rows = operationRows({
			adCreation: databaseRow(
				[adCreationOperations.organizationId, "org_create"],
				[adCreationOperations.usageReservationId, "ur_create"],
				[adCreationOperations.status, "unknown"],
				[adCreationOperations.platformCampaignId, "provider_campaign"],
				[adCreationOperations.platformAdSetId, null],
				[adCreationOperations.platformCreativeId, null],
				[adCreationOperations.platformAdId, null],
			),
			adMutation: databaseRow(
				[adMutationOperations.organizationId, "org_mutation"],
				[adMutationOperations.usageReservationId, "ur_mutation"],
				[adMutationOperations.status, "unknown"],
				[
					adMutationOperations.providerConfirmedAt,
					new Date("2026-08-02T10:00:00.000Z"),
				],
			),
			phoneProvisioning: databaseRow(
				[whatsappPhoneProvisioningOperations.organizationId, "org_provision"],
				[
					whatsappPhoneProvisioningOperations.provisioningUsageReservationId,
					"ur_provision",
				],
				[
					whatsappPhoneProvisioningOperations.provisioningState,
					"waiting_external",
				],
				[whatsappPhoneProvisioningOperations.provisioningPhase, "billing"],
				[
					whatsappPhoneProvisioningOperations.stripeCheckoutSessionId,
					"cs_provision",
				],
			),
			phoneRelease: databaseRow(
				[whatsappPhoneReleaseOperations.organizationId, "org_release"],
				[
					whatsappPhoneReleaseOperations.releaseUsageReservationId,
					"ur_release",
				],
				[whatsappPhoneReleaseOperations.releaseState, "revocation_pending"],
				[whatsappPhoneReleaseOperations.releaseMetaStatus, "confirmed"],
				[whatsappPhoneReleaseOperations.releaseStripeStatus, "pending"],
				[whatsappPhoneReleaseOperations.releaseTelnyxStatus, "pending"],
			),
		});

		expect(
			await reconcileDurableOperationUsage(
				createReconciliationDb(rows) as never,
			),
		).toBe(4);
		expect(settlements).toEqual([
			{
				reservationId: "ur_create",
				organizationId: "org_create",
				committedUnits: 1,
			},
			{
				reservationId: "ur_mutation",
				organizationId: "org_mutation",
				committedUnits: 1,
			},
			{
				reservationId: "ur_provision",
				organizationId: "org_provision",
				committedUnits: 1,
			},
			{
				reservationId: "ur_release",
				organizationId: "org_release",
				committedUnits: 1,
			},
		]);
	});

	it("releases crash-stranded reservations for authority-cancelled no-effect operations", async () => {
		const rows = operationRows({
			adCreation: databaseRow(
				[adCreationOperations.organizationId, "org_create_cancelled"],
				[adCreationOperations.usageReservationId, "ur_create_cancelled"],
				[adCreationOperations.status, "cancelled"],
				[adCreationOperations.platformCampaignId, null],
				[adCreationOperations.platformAdSetId, null],
				[adCreationOperations.platformCreativeId, null],
				[adCreationOperations.platformAdId, null],
			),
			adMutation: databaseRow(
				[adMutationOperations.organizationId, "org_mutation_cancelled"],
				[adMutationOperations.usageReservationId, "ur_mutation_cancelled"],
				[adMutationOperations.status, "cancelled"],
				[adMutationOperations.providerConfirmedAt, null],
			),
			phoneRelease: databaseRow(
				[
					whatsappPhoneReleaseOperations.organizationId,
					"org_release_cancelled",
				],
				[
					whatsappPhoneReleaseOperations.releaseUsageReservationId,
					"ur_release_cancelled",
				],
				[whatsappPhoneReleaseOperations.releaseState, "cancelled"],
				[whatsappPhoneReleaseOperations.releaseMetaStatus, "pending"],
				[whatsappPhoneReleaseOperations.releaseStripeStatus, "pending"],
				[whatsappPhoneReleaseOperations.releaseTelnyxStatus, "pending"],
			),
		});

		expect(
			await reconcileDurableOperationUsage(
				createReconciliationDb(rows) as never,
			),
		).toBe(3);
		expect(settlements).toEqual([
			{
				reservationId: "ur_create_cancelled",
				organizationId: "org_create_cancelled",
				committedUnits: 0,
			},
			{
				reservationId: "ur_mutation_cancelled",
				organizationId: "org_mutation_cancelled",
				committedUnits: 0,
			},
			{
				reservationId: "ur_release_cancelled",
				organizationId: "org_release_cancelled",
				committedUnits: 0,
			},
		]);
	});

	it("parks ambiguous evidence for all four families and releases a proven cancelled purchase at K=0", async () => {
		const ambiguousRows = operationRows({
			adCreation: databaseRow(
				[adCreationOperations.organizationId, "org_create"],
				[adCreationOperations.usageReservationId, "ur_create"],
				[adCreationOperations.status, "unknown"],
				[adCreationOperations.platformCampaignId, null],
				[adCreationOperations.platformAdSetId, null],
				[adCreationOperations.platformCreativeId, null],
				[adCreationOperations.platformAdId, null],
			),
			adMutation: databaseRow(
				[adMutationOperations.organizationId, "org_mutation"],
				[adMutationOperations.usageReservationId, "ur_mutation"],
				[adMutationOperations.status, "unknown"],
				[adMutationOperations.providerConfirmedAt, null],
			),
			phoneProvisioning: databaseRow(
				[whatsappPhoneProvisioningOperations.organizationId, "org_provision"],
				[
					whatsappPhoneProvisioningOperations.provisioningUsageReservationId,
					"ur_provision",
				],
				[whatsappPhoneProvisioningOperations.provisioningState, "unknown"],
				[whatsappPhoneProvisioningOperations.provisioningPhase, "selected"],
				[whatsappPhoneProvisioningOperations.stripeCheckoutSessionId, null],
			),
			phoneRelease: databaseRow(
				[whatsappPhoneReleaseOperations.organizationId, "org_release"],
				[
					whatsappPhoneReleaseOperations.releaseUsageReservationId,
					"ur_release",
				],
				[whatsappPhoneReleaseOperations.releaseState, "unknown"],
			),
		});

		expect(
			await reconcileDurableOperationUsage(
				createReconciliationDb(ambiguousRows) as never,
			),
		).toBe(4);
		expect(settlements.map(({ committedUnits }) => committedUnits)).toEqual([
			null,
			null,
			null,
			null,
		]);

		settlements.length = 0;
		const cancelledRows = operationRows({
			phoneProvisioning: databaseRow(
				[whatsappPhoneProvisioningOperations.organizationId, "org_cancelled"],
				[
					whatsappPhoneProvisioningOperations.provisioningUsageReservationId,
					"ur_cancelled",
				],
				[whatsappPhoneProvisioningOperations.provisioningState, "cancelled"],
				[whatsappPhoneProvisioningOperations.provisioningPhase, "selected"],
				[whatsappPhoneProvisioningOperations.stripeCheckoutSessionId, null],
			),
		});
		expect(
			await reconcileDurableOperationUsage(
				createReconciliationDb(cancelledRows) as never,
			),
		).toBe(1);
		expect(settlements).toEqual([
			{
				reservationId: "ur_cancelled",
				organizationId: "org_cancelled",
				committedUnits: 0,
			},
		]);
	});

	it("does not bill inherited existing-campaign IDs before an ad provider effect", async () => {
		const rows = operationRows({
			adCreation: databaseRow(
				[adCreationOperations.organizationId, "org_existing_campaign"],
				[adCreationOperations.usageReservationId, "ur_existing_campaign"],
				[adCreationOperations.status, "manual_review"],
				[adCreationOperations.kind, "create_ad"],
				[adCreationOperations.requestPayload, { campaignId: "campaign_local" }],
				[adCreationOperations.platformCampaignId, "campaign_provider"],
				[adCreationOperations.platformAdSetId, "adset_provider"],
				[adCreationOperations.platformCreativeId, null],
				[adCreationOperations.platformAdId, null],
			),
		});

		expect(
			await reconcileDurableOperationUsage(
				createReconciliationDb(rows) as never,
			),
		).toBe(1);
		expect(settlements).toEqual([
			{
				reservationId: "ur_existing_campaign",
				organizationId: "org_existing_campaign",
				committedUnits: null,
			},
		]);
	});

	it("maps terminal operator economic evidence to K for every operation family", async () => {
		const terminalNoEffectRows = operationRows({
			adCreation: {
				...databaseRow(
					[adCreationOperations.organizationId, "org_create"],
					[adCreationOperations.usageReservationId, "ur_create"],
					[adCreationOperations.status, "manual_review"],
					[adCreationOperations.platformCampaignId, null],
					[adCreationOperations.platformAdSetId, null],
					[adCreationOperations.platformCreativeId, null],
					[adCreationOperations.platformAdId, null],
				),
				operatorOutcome: "mark_not_applied",
			},
			adMutation: {
				...databaseRow(
					[adMutationOperations.organizationId, "org_mutation"],
					[adMutationOperations.usageReservationId, "ur_mutation"],
					[adMutationOperations.status, "manual_review"],
					[adMutationOperations.providerConfirmedAt, null],
				),
				operatorOutcome: "mark_not_applied",
			},
			phoneProvisioning: {
				...databaseRow(
					[whatsappPhoneProvisioningOperations.organizationId, "org_provision"],
					[
						whatsappPhoneProvisioningOperations.provisioningUsageReservationId,
						"ur_provision",
					],
					[
						whatsappPhoneProvisioningOperations.provisioningState,
						"manual_review",
					],
					[whatsappPhoneProvisioningOperations.provisioningPhase, "selected"],
					[whatsappPhoneProvisioningOperations.stripeCheckoutSessionId, null],
				),
				operatorOutcome: "mark_not_applied",
			},
			phoneRelease: {
				...databaseRow(
					[whatsappPhoneReleaseOperations.organizationId, "org_release"],
					[
						whatsappPhoneReleaseOperations.releaseUsageReservationId,
						"ur_release",
					],
					[whatsappPhoneReleaseOperations.releaseState, "manual_review"],
				),
				operatorOutcome: "mark_not_applied",
			},
		});

		expect(
			await reconcileDurableOperationUsage(
				createReconciliationDb(terminalNoEffectRows) as never,
			),
		).toBe(4);
		expect(settlements).toEqual([
			{
				reservationId: "ur_create",
				organizationId: "org_create",
				committedUnits: 0,
			},
			{
				reservationId: "ur_mutation",
				organizationId: "org_mutation",
				committedUnits: 0,
			},
			{
				reservationId: "ur_provision",
				organizationId: "org_provision",
				committedUnits: 0,
			},
			{
				reservationId: "ur_release",
				organizationId: "org_release",
				committedUnits: null,
			},
		]);

		settlements.length = 0;
		for (const rows of terminalNoEffectRows.values()) {
			for (const row of rows) {
				if ("operatorOutcome" in row) {
					row.operatorOutcome = "mark_succeeded";
				}
			}
		}
		expect(
			await reconcileDurableOperationUsage(
				createReconciliationDb(terminalNoEffectRows) as never,
			),
		).toBe(4);
		expect(settlements.map(({ committedUnits }) => committedUnits)).toEqual([
			1, 1, 1, 1,
		]);
	});

	it("keeps phone-release K=N monotonic across later phase decisions", () => {
		const source = readFileSync(
			new URL("../services/durable-operation-usage.ts", import.meta.url),
			"utf8",
		);
		const releaseOutcome = source.slice(
			source.indexOf("const phoneReleaseOperatorOutcome"),
			source.indexOf("const adCreationTerminalEvidence"),
		);
		expect(releaseOutcome).toContain("evidence.action = 'mark_succeeded'");
		expect(releaseOutcome).not.toContain("mark_not_applied");
	});

	it("pins linked reservations in stale recovery, write-off, and period close", () => {
		const usageSource = readFileSync(
			new URL("../services/usage-meter.ts", import.meta.url),
			"utf8",
		);
		const invoiceSource = readFileSync(
			new URL("../services/invoice-generator.ts", import.meta.url),
			"utf8",
		);
		const ownerGuard = usageSource.slice(
			usageSource.indexOf("function durableOperationUsageOwnerAbsent"),
			usageSource.indexOf("export type UsageDisposition"),
		);
		expect(ownerGuard.match(/NOT EXISTS/g)).toHaveLength(4);
		for (const table of [
			"adCreationOperations",
			"adMutationOperations",
			"whatsappPhoneProvisioningOperations",
			"whatsappPhoneReleaseOperations",
		]) {
			expect(ownerGuard).toContain(table);
		}

		const staleRecovery = usageSource.slice(
			usageSource.indexOf(
				"export async function reconcileStaleReservedUsageReservations",
			),
			usageSource.indexOf(
				"export async function writeOffExpiredParkedUsageReservations",
			),
		);
		const writeOff = usageSource.slice(
			usageSource.indexOf(
				"export async function writeOffExpiredParkedUsageReservations",
			),
			usageSource.indexOf("export function successfulMutationDisposition"),
		);
		for (const pathSource of [staleRecovery, writeOff]) {
			expect(pathSource).toContain(
				"const durableOwnerAbsent = durableOperationUsageOwnerAbsent()",
			);
			// Discovery plus both locked compare-and-set rechecks must retain the pin.
			expect(
				pathSource.match(/durableOwnerAbsent/g)?.length,
			).toBeGreaterThanOrEqual(4);
		}

		const periodClose = invoiceSource.slice(
			invoiceSource.indexOf("export async function claimBillingPeriod"),
			invoiceSource.indexOf("/**\n * Delete cached API-key authorization"),
		);
		for (const table of [
			"adCreationOperations",
			"adMutationOperations",
			"whatsappPhoneProvisioningOperations",
			"whatsappPhoneReleaseOperations",
		]) {
			expect(periodClose).toContain(table);
		}
		expect(periodClose).toContain(
			"if (bucket?.reservedUnits && bucket.reservedUnits > 0) return false",
		);
	});
});
