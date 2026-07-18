import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import resources from "../../production-resources.json";
import {
	assertBucket,
	assertDurableBucketLifecycle,
	assertHyperdriveConfig,
	assertMediaLifecycle,
	assertMediaNotifications,
	assertQueueConfiguration,
	assertQueuePrerequisites,
	assertQueueRescueLifecycle,
	assertRequiredSecrets,
	assertWorkerBindings,
	type QueueConfiguration,
	safeVerificationErrorMessage,
	validateCloudflareCredentials,
	verificationMode,
} from "../../scripts/verify-cloudflare-production";

function validQueues(): QueueConfiguration[] {
	const producers = new Set(resources.queueProducers);
	return resources.queueConsumers.map((expected, index) => ({
		queue_id: `queue-${index}`,
		queue_name: expected.queue,
		settings: { delivery_paused: false },
		producers: producers.has(expected.queue)
			? [{ type: "worker", script: resources.workerName }]
			: [],
		consumers: [
			{
				type: "worker",
				script_name: resources.workerName,
				dead_letter_queue: expected.deadLetterQueue ?? "",
				settings: {
					batch_size: expected.batchSize,
					max_retries: expected.maxRetries,
					max_wait_time_ms:
						"maxWaitTimeMs" in expected ? expected.maxWaitTimeMs : undefined,
					max_concurrency:
						"maxConcurrency" in expected ? expected.maxConcurrency : undefined,
				},
			},
		],
	}));
}

function expectInOrder(source: string, snippets: string[]): void {
	let cursor = 0;
	for (const snippet of snippets) {
		const index = source.indexOf(snippet, cursor);
		expect(index).toBeGreaterThanOrEqual(cursor);
		cursor = index + snippet.length;
	}
}

describe("production Cloudflare configuration policy", () => {
	it("requires cache-disabled Hyperdrive", () => {
		expect(() =>
			assertHyperdriveConfig({
				id: "11180e4939824902a75753084dc6a8e9",
				caching: { disabled: true },
				origin: {
					service_id: "vpc-service-id",
					user: "relayapi_runtime",
					scheme: "postgresql",
				},
			}),
		).not.toThrow();
		expect(() =>
			assertHyperdriveConfig({
				id: "11180e4939824902a75753084dc6a8e9",
				caching: { disabled: false },
				origin: {
					service_id: "vpc-service-id",
					user: "relayapi_runtime",
					scheme: "postgresql",
				},
			}),
		).toThrow();
		expect(() =>
			assertHyperdriveConfig({
				id: "11180e4939824902a75753084dc6a8e9",
				caching: { disabled: true },
				origin: {
					host: "public-db.example.com",
					user: "relayapi_runtime",
					scheme: "postgresql",
				},
			}),
		).toThrow();
		expect(() =>
			assertHyperdriveConfig({
				id: "11180e4939824902a75753084dc6a8e9",
				caching: { disabled: true },
				origin: {
					service_id: "vpc-service-id",
					user: "relayapi_migrator",
					scheme: "postgresql",
				},
			}),
		).toThrow();
	});

	it("requires exact finite retention and protects durable buckets", () => {
		expect(() =>
			assertMediaLifecycle({
				rules: [
					{
						id: "expire-originals",
						enabled: true,
						conditions: { prefix: "" },
						deleteObjectsTransition: {
							condition: { type: "Age", maxAge: 2_592_000 },
						},
					},
				],
			}),
		).not.toThrow();
		expect(() =>
			assertQueueRescueLifecycle({
				rules: [
					{
						id: "expire-rescue-ledger",
						enabled: true,
						conditions: { prefix: "" },
						deleteObjectsTransition: {
							condition: { type: "Age", maxAge: 2_592_000 },
						},
					},
				],
			}),
		).not.toThrow();
		expect(() => assertQueueRescueLifecycle({ rules: [] })).toThrow();
		expect(() =>
			assertDurableBucketLifecycle(resources.avatarBucket, { rules: [] }),
		).not.toThrow();
		expect(() =>
			assertDurableBucketLifecycle(resources.avatarBucket, {
				rules: [
					{
						id: "dangerous-delete",
						enabled: true,
						deleteObjectsTransition: {
							condition: { type: "Age", maxAge: 86_400 },
						},
					},
				],
			}),
		).toThrow();
	});

	it("requires the exact unfiltered media notification coverage", () => {
		expect(() =>
			assertMediaNotifications({
				bucketName: "relayapi-media",
				queues: [
					{
						queueName: "relayapi-media-cleanup",
						rules: [
							{
								actions: [
									"PutObject",
									"CopyObject",
									"DeleteObject",
									"CompleteMultipartUpload",
									"LifecycleDeletion",
								],
							},
						],
					},
				],
			}),
		).not.toThrow();
		expect(() =>
			assertMediaNotifications({
				bucketName: "unexpected",
				queues: [],
			}),
		).toThrow();
		expect(() =>
			assertMediaNotifications({
				bucketName: "relayapi-media",
				queues: [
					{
						queueName: "relayapi-media-cleanup",
						rules: [
							{ actions: [...resources.mediaEventActions] },
							{ actions: ["DeleteObject", "LifecycleDeletion"] },
						],
					},
				],
			}),
		).toThrow();
	});

	it("requires all four reviewed R2 buckets to exist", () => {
		for (const bucket of [
			resources.mediaBucket,
			resources.avatarBucket,
			resources.thumbnailBucket,
			resources.queueRescueBucket,
		]) {
			expect(() => assertBucket(bucket, { name: bucket })).not.toThrow();
		}
		expect(() =>
			assertBucket(resources.mediaBucket, { name: "wrong-bucket" }),
		).toThrow();
	});

	it("requires every producer, consumer, DLQ, and rescue policy", () => {
		const queues = validQueues();
		expect(() => assertQueueConfiguration(queues)).not.toThrow();

		expect(() => assertQueueConfiguration(queues.slice(1))).toThrow();
		const retryDrift = structuredClone(queues);
		if (retryDrift[0]?.consumers?.[0]?.settings) {
			retryDrift[0].consumers[0].settings.max_retries = 999;
		}
		expect(() => assertQueueConfiguration(retryDrift)).toThrow();

		const producerDrift = structuredClone(queues);
		const publish = producerDrift.find(
			(queue) => queue.queue_name === "relayapi-publish",
		);
		if (publish) publish.producers = [];
		expect(() => assertQueueConfiguration(producerDrift)).toThrow();
	});

	it("checks static Queue prerequisites without requiring future Worker bindings", () => {
		const prerequisites = validQueues().map(
			({ queue_id, queue_name, settings }) => ({
				queue_id,
				queue_name,
				settings,
			}),
		);
		expect(() => assertQueuePrerequisites(prerequisites)).not.toThrow();
		expect(() => assertQueuePrerequisites(prerequisites.slice(1))).toThrow();

		const paused = structuredClone(prerequisites);
		if (paused[0]?.settings) paused[0].settings.delivery_paused = true;
		expect(() => assertQueuePrerequisites(paused)).toThrow();
	});

	it("selects strict full and predeploy verification modes", () => {
		expect(verificationMode([])).toBe("full");
		expect(verificationMode(["--predeploy"])).toBe("predeploy");
		expect(() => verificationMode(["--external-only"])).toThrow();
	});

	it("requires baseline secrets and rejects partially configured providers", () => {
		const baseline = resources.requiredSecrets.map((name) => ({
			name,
			type: "secret_text",
		}));
		expect(() => assertRequiredSecrets(baseline)).not.toThrow();
		expect(() => assertRequiredSecrets(baseline.slice(1))).toThrow();
		expect(() =>
			assertRequiredSecrets([
				...baseline,
				{ name: "TELEGRAM_BOT_TOKEN", type: "secret_text" },
			]),
		).toThrow();
	});

	it("requires the active Worker version to expose every reviewed binding", () => {
		const bindings = resources.requiredBindings.map((name) => ({
			name,
			type: "test",
		}));
		expect(() =>
			assertWorkerBindings({ resources: { bindings } }),
		).not.toThrow();
		expect(() =>
			assertWorkerBindings({ resources: { bindings: bindings.slice(1) } }),
		).toThrow();
	});

	it("rejects malformed Cloudflare credentials without echoing token material", () => {
		const sentinel = "not-a-real-token with-whitespace";
		let message = "";
		try {
			validateCloudflareCredentials(sentinel, resources.accountId);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("without whitespace");
		expect(message).not.toContain(sentinel);

		const validShapeSentinel = "not-a-real-token-value";
		const redacted = safeVerificationErrorMessage(
			new Error(`Invalid Authorization: Bearer ${validShapeSentinel}`),
			validShapeSentinel,
		);
		expect(redacted).toContain("[REDACTED]");
		expect(redacted).not.toContain(validShapeSentinel);
	});

	it("keeps the resource manifest and SSRF runtime flag wired", () => {
		const config = readFileSync(
			new URL("../../wrangler.jsonc", import.meta.url),
			"utf8",
		);
		expect(config).toContain('"global_fetch_strictly_public"');
		for (const expected of resources.queueConsumers) {
			expect(config).toContain(`"queue": "${expected.queue}"`);
		}
		for (const binding of resources.requiredBindings) {
			expect(config).toContain(`"${binding}"`);
		}
	});

	it("gates production migration, deployment smoke, and Worker rollback", () => {
		const workflow = readFileSync(
			new URL("../../../../.github/workflows/deploy-api.yml", import.meta.url),
			"utf8",
		);
		const migrationGateStart = workflow.indexOf("  migration-gate:");
		const deployStart = workflow.indexOf("  deploy:");
		expect(migrationGateStart).toBeGreaterThan(0);
		expect(deployStart).toBeGreaterThan(migrationGateStart);

		const migrationGate = workflow.slice(migrationGateStart, deployStart);
		const deploy = workflow.slice(deployStart);
		expect(workflow.slice(0, deployStart)).not.toContain(
			"secrets.PRODUCTION_DATABASE_URL",
		);
		expect(deploy).toContain("name: production");
		expect(deploy).toContain(
			"needs: [test, platform-tests, contracts, migration-gate]",
		);
		expect(deploy).toContain("secrets.PRODUCTION_DATABASE_URL");
		expect(workflow).not.toContain("backup_restore_confirmed");
		expect(deploy).toContain("PRODUCTION_DATABASE_ACCESS_CLIENT_ID");
		expect(deploy).toContain("PRODUCTION_DATABASE_ACCESS_CLIENT_SECRET");
		expect(deploy).toContain("cloudflare/cloudflared:2026.6.0");
		expect(deploy).toContain("access tcp");
		expect(deploy).toContain('sslmode") !== "verify-full"');
		expect(migrationGate).toContain("postgres:18-alpine");

		expectInOrder(migrationGate, [
			"db:migration-manifest",
			"db:migrate",
			"db:migrate",
			"db:verify",
			"db:migration-history:current",
		]);
		expectInOrder(deploy, [
			"Start Access-protected production database tunnel",
			"cloudflare:verify-prerequisites",
			"db:migration-manifest",
			"db:migration-history",
			"wrangler deployments status --json",
			"db:migrate",
			"db:verify",
			"db:migration-history:current",
			"wrangler deploy --keep-vars --strict",
			"wrangler deployments status --json",
			"cloudflare:smoke-production",
			"cloudflare:verify-production",
			"wrangler rollback",
		]);
		expect(deploy).toContain("EXPECTED_WORKER_VERSION_ID");
		expect(deploy).toContain("steps.previous_worker.outputs.version_id");
		expect(deploy).toContain("if: ${{ failure()");
		expect(deploy).toContain('--message "Automated rollback');
		expect(deploy).toContain("--yes");
		expect(workflow).not.toContain("db:prepare-online-indexes");

		const packageJson = readFileSync(
			new URL("../../package.json", import.meta.url),
			"utf8",
		);
		expect(packageJson).toContain("--env-interface=ApiWorkerEnv");
		expect(packageJson).toContain(
			'"cloudflare:verify-prerequisites": "bun scripts/verify-cloudflare-production.ts --predeploy"',
		);
		expect(packageJson).not.toContain("--include-env=false");
	});
});
