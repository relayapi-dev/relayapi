import { describe, expect, mock, test } from "bun:test";
import type { CloudflareClient } from "../src/cloudflare.js";
import { QUEUE_NAMES } from "../src/constants.js";
import { reconcileCloudflareResources } from "../src/reconcile.js";
import type { CloudflareResourcePlan, SelfHostConfig } from "../src/types.js";

const previousCaCertificateId = "11111111-2222-4333-8444-555555555555";
const rotatedCaCertificateId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const resources: NonNullable<SelfHostConfig["resources"]> = {
	kvNamespaceId: "kv-id",
	hyperdriveId: "hyperdrive-id",
	queues: Object.fromEntries(
		QUEUE_NAMES.map((name) => [name, `queue-${name}`]),
	) as NonNullable<SelfHostConfig["resources"]>["queues"],
};

const config: SelfHostConfig = {
	schemaVersion: 1,
	instance: "relayapi",
	cloudflare: {
		accountId: "account-id",
		zoneId: "zone-id",
		rootDomain: "example.com",
		apiHostname: "api.example.com",
		appHostname: "app.example.com",
		publicHostname: "go.example.com",
		mediaHostname: "media.example.com",
		thumbnailHostname: "thumbs.example.com",
		r2Jurisdiction: "default",
		hyperdriveCaCertificateId: previousCaCertificateId,
	},
	features: { email: false, ai: false, downloader: false },
	resources,
};

const rotationPlan: CloudflareResourcePlan = {
	kv: { name: "relayapi-selfhost-api-keys", id: "kv-id", action: "reuse" },
	buckets: [],
	queues: [],
	hyperdrive: {
		name: "relayapi-selfhost-db",
		id: "hyperdrive-id",
		currentCaCertificateId: previousCaCertificateId,
		caCertificateId: rotatedCaCertificateId,
		caCertificateAction: "rotate",
		action: "reconcile",
		visibleDrift: [],
		credentialAction: "reapply_write_only",
	},
};

function clientWithApply(
	apply: () => Promise<NonNullable<SelfHostConfig["resources"]>>,
) {
	return {
		client: {
			plan: mock(async () => rotationPlan),
			apply: mock(apply),
		} as unknown as Pick<CloudflareClient, "plan" | "apply">,
	};
}

describe("Hyperdrive CA reconciliation persistence", () => {
	test("keeps an explicit rotation plan read-only during dry-run", async () => {
		const { client } = clientWithApply(async () => resources);
		const persist = mock(async (_config: SelfHostConfig) => {});
		const result = await reconcileCloudflareResources({
			config,
			runtimeDatabaseUrl:
				"postgresql://runtime:secret@db.example.com/relay?sslmode=verify-full",
			client,
			dryRun: true,
			requestedCaCertificateId: rotatedCaCertificateId,
			persist,
		});

		expect(result.applied).toBe(false);
		expect(result.plan.hyperdrive.caCertificateAction).toBe("rotate");
		expect(result.config.cloudflare.hyperdriveCaCertificateId).toBe(
			previousCaCertificateId,
		);
		expect(client.apply).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});

	test("does not persist requested intent when Cloudflare PATCH fails", async () => {
		const { client } = clientWithApply(async () => {
			throw new Error("Cloudflare rejected Hyperdrive PATCH");
		});
		const persist = mock(async (_config: SelfHostConfig) => {});

		await expect(
			reconcileCloudflareResources({
				config,
				runtimeDatabaseUrl:
					"postgresql://runtime:secret@db.example.com/relay?sslmode=verify-full",
				client,
				dryRun: false,
				requestedCaCertificateId: rotatedCaCertificateId,
				persist,
			}),
		).rejects.toThrow("Cloudflare rejected Hyperdrive PATCH");
		expect(persist).not.toHaveBeenCalled();
	});

	test("persists rotated intent only after successful convergence", async () => {
		const events: string[] = [];
		const { client } = clientWithApply(async () => {
			events.push("apply");
			return resources;
		});
		let persisted: SelfHostConfig | undefined;
		const persist = mock(async (appliedConfig: SelfHostConfig) => {
			events.push("persist");
			persisted = appliedConfig;
		});

		const result = await reconcileCloudflareResources({
			config,
			runtimeDatabaseUrl:
				"postgresql://runtime:secret@db.example.com/relay?sslmode=verify-full",
			client,
			dryRun: false,
			requestedCaCertificateId: rotatedCaCertificateId,
			persist,
		});

		expect(events).toEqual(["apply", "persist"]);
		expect(result.applied).toBe(true);
		expect(result.config.cloudflare.hyperdriveCaCertificateId).toBe(
			rotatedCaCertificateId,
		);
		expect(persisted?.cloudflare.hyperdriveCaCertificateId).toBe(
			rotatedCaCertificateId,
		);
		expect(client.apply).toHaveBeenCalledWith(
			expect.objectContaining({
				cloudflare: expect.objectContaining({
					hyperdriveCaCertificateId: rotatedCaCertificateId,
				}),
			}),
			expect.any(String),
			{
				requestedCaCertificateId: rotatedCaCertificateId,
				expectedCurrentCaCertificateId: previousCaCertificateId,
			},
		);
	});

	test("recovers idempotently when Cloudflare already has the requested target", async () => {
		const recoveryPlan: CloudflareResourcePlan = {
			...rotationPlan,
			hyperdrive: {
				...rotationPlan.hyperdrive,
				currentCaCertificateId: rotatedCaCertificateId,
				caCertificateAction: "retain",
			},
		};
		const persist = mock(async (_config: SelfHostConfig) => {});
		const client = {
			plan: mock(async () => recoveryPlan),
			apply: mock(async () => resources),
		} as unknown as Pick<CloudflareClient, "plan" | "apply">;

		const result = await reconcileCloudflareResources({
			config,
			runtimeDatabaseUrl:
				"postgresql://runtime:secret@db.example.com/relay?sslmode=verify-full",
			client,
			dryRun: false,
			requestedCaCertificateId: rotatedCaCertificateId,
			persist,
		});

		expect(result.plan.hyperdrive.caCertificateAction).toBe("retain");
		expect(result.config.cloudflare.hyperdriveCaCertificateId).toBe(
			rotatedCaCertificateId,
		);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(client.apply).toHaveBeenCalledWith(
			expect.objectContaining({
				cloudflare: expect.objectContaining({
					hyperdriveCaCertificateId: rotatedCaCertificateId,
				}),
			}),
			expect.any(String),
			{
				requestedCaCertificateId: rotatedCaCertificateId,
				expectedCurrentCaCertificateId: previousCaCertificateId,
			},
		);
	});

	test("carries the safely observed target when a legacy exact pin is adopted", async () => {
		const legacyConfig = structuredClone(config);
		delete legacyConfig.cloudflare.hyperdriveCaCertificateId;
		const adoptionPlan: CloudflareResourcePlan = {
			...rotationPlan,
			hyperdrive: {
				...rotationPlan.hyperdrive,
				currentCaCertificateId: rotatedCaCertificateId,
				caCertificateAction: "adopt",
			},
		};
		const persist = mock(async (_config: SelfHostConfig) => {});
		const client = {
			plan: mock(async () => adoptionPlan),
			apply: mock(async () => resources),
		} as unknown as Pick<CloudflareClient, "plan" | "apply">;

		await reconcileCloudflareResources({
			config: legacyConfig,
			runtimeDatabaseUrl:
				"postgresql://runtime:secret@db.example.com/relay?sslmode=verify-full",
			client,
			dryRun: false,
			requestedCaCertificateId: rotatedCaCertificateId,
			persist,
		});

		expect(client.apply).toHaveBeenCalledWith(
			expect.objectContaining({
				cloudflare: expect.objectContaining({
					hyperdriveCaCertificateId: rotatedCaCertificateId,
				}),
			}),
			expect.any(String),
			{
				requestedCaCertificateId: rotatedCaCertificateId,
				expectedCurrentCaCertificateId: rotatedCaCertificateId,
			},
		);
	});
});
