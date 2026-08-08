import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	accountRevocationJobs,
	adAccounts,
	adCreationOperations,
	billingOperations,
	stripeEvents,
	tenantDeletionJobs,
	tokenRefreshOperations,
	whatsappPhoneNumbers,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { stableOperationJson } from "../lib/durable-operation";
import {
	adProviderCorrelationMarker,
	buildAdOperationCampaignProjection,
	classifyAdCreationReplayState,
	correlatedAdProviderName,
	remainingAdCreationPhases,
} from "../services/ad-creation-operations";
import { findOwnedPhoneNumber, orderNumber } from "../services/telnyx";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function uniqueColumns(
	table: Parameters<typeof getTableConfig>[0],
): string[][] {
	return getTableConfig(table)
		.indexes.filter((index) => index.config.unique)
		.map((index) =>
			index.config.columns.flatMap((column) => {
				const name = (column as { name?: unknown }).name;
				return typeof name === "string" ? [name] : [];
			}),
		);
}

describe("durable external-operation identities", () => {
	it("canonicalizes request objects before hashing", () => {
		expect(
			stableOperationJson({ z: 1, nested: { b: 2, a: 1 }, omitted: undefined }),
		).toBe('{"nested":{"a":1,"b":2},"z":1}');
	});

	it("uses one stable, idempotently-appended provider correlation marker", () => {
		const marker = adProviderCorrelationMarker("adop_123");
		const once = correlatedAdProviderName("Launch", "adop_123");
		expect(marker).toBe("[relay:adop_123]");
		expect(once).toBe("Launch [relay:adop_123]");
		expect(correlatedAdProviderName(once, "adop_123")).toBe(once);
	});

	it("takes over a sync-raced campaign with the canonical operation projection", () => {
		const projection = buildAdOperationCampaignProjection({
			kind: "boost_post",
			workspaceId: "ws_1",
			name: "Launch",
			platformAdSetId: "adset_1",
			objective: "engagement",
			dailyBudgetCents: 2_500,
			currency: "USD",
		});

		expect(projection).toEqual({
			workspaceId: "ws_1",
			name: "Launch",
			objective: "engagement",
			status: "active",
			dailyBudgetCents: 2_500,
			lifetimeBudgetCents: null,
			currency: "USD",
			isExternal: false,
			metadata: { platformAdSetId: "adset_1" },
		});
		expect(projection.name).not.toContain("[relay:");

		expect(
			buildAdOperationCampaignProjection({
				kind: "create_campaign",
				workspaceId: null,
				name: "Scheduled launch",
				platformAdSetId: "adset_2",
				objective: "traffic",
				startDate: "2026-08-03T09:00:00.000Z",
				endDate: "2026-08-10T09:00:00.000Z",
			}),
		).toMatchObject({
			status: "paused",
			isExternal: false,
			startDate: new Date("2026-08-03T09:00:00.000Z"),
			endDate: new Date("2026-08-10T09:00:00.000Z"),
		});
	});

	it("validates targeting before staging a paid-object operation", async () => {
		const source = await Bun.file(
			new URL("../services/ad-service.ts", import.meta.url),
		).text();
		const createAdStart = source.indexOf("export async function createAd(");
		const boostStart = source.indexOf("export async function boostPost(");
		const updateStart = source.indexOf("export async function updateAd(");
		const createAdSource = source.slice(createAdStart, boostStart);
		const boostSource = source.slice(boostStart, updateStart);

		for (const operationSource of [createAdSource, boostSource]) {
			const validation = operationSource.indexOf(
				"adapter.canonicalizeTargeting(",
			);
			const durableBoundary = operationSource.indexOf(
				"beginAdCreationOperation({",
			);
			expect(validation).toBeGreaterThan(-1);
			expect(durableBoundary).toBeGreaterThan(validation);
		}
	});
});

describe("paid-operation Queue replay fencing", () => {
	const base = {
		leaseExpiresAt: null,
		requestMayHaveBeenSentAt: null,
		platformCampaignId: null,
		platformAdSetId: null,
		platformCreativeId: null,
		platformAdId: null,
	};

	it("permits only not-started, failed, or expired pre-boundary work", () => {
		const now = new Date("2026-07-13T12:00:00.000Z");
		expect(classifyAdCreationReplayState(undefined, now)).toBe("not_started");
		expect(
			classifyAdCreationReplayState({ ...base, status: "failed" }, now),
		).toBe("safe");
		expect(
			classifyAdCreationReplayState(
				{
					...base,
					status: "processing",
					leaseExpiresAt: new Date("2026-07-13T11:59:00.000Z"),
				},
				now,
			),
		).toBe("safe");
		expect(
			classifyAdCreationReplayState(
				{
					...base,
					status: "processing",
					leaseExpiresAt: new Date("2026-07-13T11:59:00.000Z"),
					kind: "create_ad",
					requestPayload: { campaignId: "campaign_local" },
					platformCampaignId: "campaign_provider",
					platformAdSetId: "adset_provider",
				},
				now,
			),
		).toBe("safe");
	});

	it("blocks active and provider-boundary operations", () => {
		const now = new Date("2026-07-13T12:00:00.000Z");
		expect(
			classifyAdCreationReplayState(
				{
					...base,
					status: "processing",
					leaseExpiresAt: new Date("2026-07-13T12:01:00.000Z"),
				},
				now,
			),
		).toBe("lease_active");
		expect(
			classifyAdCreationReplayState(
				{
					...base,
					status: "request_may_have_been_sent",
					requestMayHaveBeenSentAt: now,
				},
				now,
			),
		).toBe("unsafe");
		expect(
			classifyAdCreationReplayState({ ...base, status: "completed" }, now),
		).toBe("completed");
		expect(
			classifyAdCreationReplayState(
				{ ...base, status: "processing", platformCreativeId: "creative_1" },
				now,
			),
		).toBe("unsafe");
	});
});

describe("paid-operation provider phase recovery", () => {
	const empty = {
		phase: "campaign" as const,
		requestMayHaveBeenSentAt: null,
		platformCampaignId: null,
		platformAdSetId: null,
		platformCreativeId: null,
		platformAdId: null,
	};

	it("resumes campaign creation after each confirmed object", () => {
		expect(
			remainingAdCreationPhases({
				...empty,
				kind: "create_campaign",
				usesExistingCampaign: false,
			}),
		).toEqual(["campaign", "ad_set"]);
		expect(
			remainingAdCreationPhases({
				...empty,
				kind: "create_campaign",
				usesExistingCampaign: false,
				platformCampaignId: "campaign_1",
			}),
		).toEqual(["ad_set"]);
		expect(
			remainingAdCreationPhases({
				...empty,
				kind: "create_campaign",
				usesExistingCampaign: false,
				platformCampaignId: "campaign_1",
				platformAdSetId: "adset_1",
			}),
		).toEqual([]);
	});

	it("skips every confirmed create-ad phase after a crash", () => {
		expect(
			remainingAdCreationPhases({
				...empty,
				kind: "create_ad",
				usesExistingCampaign: false,
			}),
		).toEqual(["campaign", "ad_set", "creative", "ad"]);
		expect(
			remainingAdCreationPhases({
				...empty,
				kind: "create_ad",
				usesExistingCampaign: false,
				platformCampaignId: "campaign_1",
				platformAdSetId: "adset_1",
				platformCreativeId: "creative_1",
			}),
		).toEqual(["ad"]);
		expect(
			remainingAdCreationPhases({
				...empty,
				kind: "create_ad",
				usesExistingCampaign: true,
			}),
		).toEqual(["creative", "ad"]);
	});

	it("keeps boost activation pending until its checkpoint is confirmed", () => {
		const created = {
			...empty,
			kind: "boost_post" as const,
			usesExistingCampaign: false,
			platformCampaignId: "campaign_1",
			platformAdSetId: "adset_1",
			platformCreativeId: "creative_1",
			platformAdId: "ad_1",
		};
		expect(remainingAdCreationPhases(created)).toEqual(["activation"]);
		expect(
			remainingAdCreationPhases({
				...created,
				phase: "activation",
				requestMayHaveBeenSentAt: new Date(),
			}),
		).toEqual(["activation"]);
		expect(
			remainingAdCreationPhases({ ...created, phase: "activation" }),
		).toEqual([]);
	});
});

describe("durable external-operation schema", () => {
	it("enforces unique paid-operation and phone-provider identities", () => {
		expect(uniqueColumns(adCreationOperations)).toContainEqual([
			"organization_id",
			"kind",
			"operation_key_hash",
		]);
		expect(uniqueColumns(whatsappPhoneProvisioningOperations)).toContainEqual([
			"organization_id",
			"idempotency_key_hash",
		]);
		expect(uniqueColumns(whatsappPhoneNumbers)).toContainEqual([
			"provider_number_id",
		]);
	});

	it("retains lease fences and explicit non-terminal outcomes", () => {
		expect(adCreationOperations.leaseToken).toBeDefined();
		expect(adCreationOperations.requestMayHaveBeenSentAt).toBeDefined();
		expect(adCreationOperations.platformCreativeId).toBeDefined();
		expect(adCreationOperations.phase.enumValues).toEqual([
			"campaign",
			"ad_set",
			"creative",
			"ad",
			"activation",
			"completed",
		]);
		const accountForeignKey = getTableConfig(
			adCreationOperations,
		).foreignKeys.find(
			(foreignKey) => foreignKey.reference().foreignTable === adAccounts,
		);
		expect(accountForeignKey?.onDelete).toBe("no action");
		expect(
			whatsappPhoneProvisioningOperations.provisioningLeaseToken,
		).toBeDefined();
		expect(whatsappPhoneReleaseOperations.releaseLeaseToken).toBeDefined();
		expect("provisioningState" in whatsappPhoneNumbers).toBe(false);
		expect("releaseState" in whatsappPhoneNumbers).toBe(false);
		expect(tenantDeletionJobs.leaseToken).toBeDefined();
		expect(tenantDeletionJobs.status.enumValues).toContain("waiting_external");
		expect(tenantDeletionJobs.status.enumValues).toContain("manual_review");
	});

	it("does not persist fields or indexes with no runtime consumer", () => {
		expect("sourceAccessToken" in tokenRefreshOperations).toBe(false);
		expect("sourceRefreshToken" in tokenRefreshOperations).toBe(false);
		expect("tokenExpiresAt" in accountRevocationJobs).toBe(false);
		expect(billingOperations.kind.enumValues).toEqual(["cycle", "catchup"]);
		expect("metadata" in billingOperations).toBe(false);
		expect(
			getTableConfig(stripeEvents).indexes.map((index) => index.config.name),
		).not.toContain("stripe_events_subscription_created_idx");
	});
});

describe("Telnyx correlation and resource resolution", () => {
	it("writes the durable operation ID as customer_reference", async () => {
		let request: { url: string; init?: RequestInit } | undefined;
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				request = { url: String(input), init };
				return Response.json({
					data: {
						id: "order_1",
						phone_numbers: [
							{
								id: "number_order_phone_1",
								phone_number: "+12025550123",
							},
						],
					},
				});
			}),
			{ preconnect: originalFetch.preconnect },
		);

		await orderNumber("test-key", "+12025550123", "wpo_123");

		expect(request?.url).toEndWith("/v2/number_orders");
		expect(request?.init?.method).toBe("POST");
		expect(JSON.parse(String(request?.init?.body))).toEqual({
			phone_numbers: [{ phone_number: "+12025550123" }],
			customer_reference: "wpo_123",
		});
	});

	it("resolves the owned phone_number ID instead of reusing an order-row ID", async () => {
		let requestedUrl = "";
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL) => {
				requestedUrl = String(input);
				return Response.json({
					data: [{ id: "owned_phone_1", phone_number: "+12025550123" }],
				});
			}),
			{ preconnect: originalFetch.preconnect },
		);

		const owned = await findOwnedPhoneNumber("test-key", "+12025550123");

		expect(owned).toEqual({
			id: "owned_phone_1",
			phoneNumber: "+12025550123",
		});
		expect(requestedUrl).toContain("/v2/phone_numbers/slim?");
		expect(requestedUrl).toContain("filter%5Bphone_number%5D=%2B12025550123");
	});
});
