import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { BASELINE_GENERATION } from "@relayapi/config";
import resources from "../../production-resources.json";
import {
	configureProductionQueueRetention,
	planQueueRetentionUpdates,
} from "../../scripts/configure-queue-retention";
import {
	assertAlwaysUseHttps,
	assertApiWorkerDomain,
	assertBucket,
	assertCronScheduleResponse,
	assertCronSchedules,
	assertDurableBucketLifecycle,
	assertHyperdriveConfig,
	assertMediaCors,
	assertMediaLifecycle,
	assertMediaNotifications,
	assertPrivateR2DevDisabled,
	assertPublicLinkWorkerDomain,
	assertQueueConfiguration,
	assertQueuePrerequisites,
	assertQueueRescueLifecycle,
	assertRequiredSecrets,
	assertStripePhoneAddonPrice,
	assertStripePortalConfiguration,
	assertStripeProPrice,
	assertStripeWebhookEndpoint,
	assertThumbnailCustomDomain,
	assertWorkerBindings,
	assertWorkerSettings,
	type QueueConfiguration,
	safeVerificationErrorMessage,
	validateCloudflareCredentials,
	verificationMode,
	type WorkerBinding,
} from "../../scripts/verify-cloudflare-production";

function validQueues(): QueueConfiguration[] {
	const producers = new Set(resources.queueProducers);
	return resources.queueConsumers.map((expected, index) => ({
		queue_id: `queue-${index}`,
		queue_name: expected.queue,
		settings: {
			delivery_paused: false,
			message_retention_period: resources.queueMessageRetentionSeconds,
		},
		producers: [
			...(producers.has(expected.queue)
				? [{ type: "worker", script: resources.workerName }]
				: []),
			...(expected.queue === resources.mediaEventQueue
				? [{ type: "r2_bucket", bucket_name: resources.mediaBucket }]
				: []),
			...(resources.queueAdditionalProducers[
				expected.queue as keyof typeof resources.queueAdditionalProducers
			] ?? []),
		],
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

function validWorkerBindings(): WorkerBinding[] {
	return Object.entries(resources.workerBindings).map(([name, binding]) => ({
		name,
		...structuredClone(binding),
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
	it("requires the active RelayAPI zone to redirect every HTTP request", () => {
		expect(() =>
			assertAlwaysUseHttps(
				[
					{
						id: "zone-id",
						name: resources.zoneName,
						status: "active",
					},
				],
				{ id: "always_use_https", value: "on", editable: true },
			),
		).not.toThrow();
		expect(() =>
			assertAlwaysUseHttps(
				[
					{
						id: "zone-id",
						name: resources.zoneName,
						status: "active",
					},
				],
				{ id: "always_use_https", value: "off", editable: true },
			),
		).toThrow("Always Use HTTPS");
	});

	it("requires cache-disabled Hyperdrive", () => {
		expect(() =>
			assertHyperdriveConfig(
				{
					id: "11180e4939824902a75753084dc6a8e9",
					caching: { disabled: true },
					origin: {
						service_id: "vpc-service-id",
						user: "relayapi_runtime",
						scheme: "postgresql",
					},
				},
				"vpc-service-id",
			),
		).not.toThrow();
		expect(() =>
			assertHyperdriveConfig(
				{
					id: "11180e4939824902a75753084dc6a8e9",
					caching: { disabled: false },
					origin: {
						service_id: "vpc-service-id",
						user: "relayapi_runtime",
						scheme: "postgresql",
					},
				},
				"vpc-service-id",
			),
		).toThrow();
		expect(() =>
			assertHyperdriveConfig(
				{
					id: "11180e4939824902a75753084dc6a8e9",
					caching: { disabled: true },
					origin: {
						host: "public-db.example.com",
						user: "relayapi_runtime",
						scheme: "postgresql",
					},
				},
				"vpc-service-id",
			),
		).toThrow();
		expect(() =>
			assertHyperdriveConfig(
				{
					id: "11180e4939824902a75753084dc6a8e9",
					caching: { disabled: true },
					origin: {
						service_id: "vpc-service-id",
						user: "relayapi_migrator",
						scheme: "postgresql",
					},
				},
				"vpc-service-id",
			),
		).toThrow();
		expect(() =>
			assertHyperdriveConfig(
				{
					id: resources.hyperdriveId,
					caching: { disabled: true },
					origin: {
						service_id: "vpc-service-id",
						user: resources.hyperdriveRuntimeUser,
						scheme: "postgresql",
					},
				},
				null,
			),
		).toThrow("not pinned");
	});

	it("requires exact finite retention and protects durable buckets", () => {
		const abortIncompleteMultipart = {
			id: "abort-incomplete-multipart",
			enabled: true,
			conditions: { prefix: "" },
			abortMultipartUploadsTransition: {
				condition: { type: "Age", maxAge: 86_400 },
			},
		};
		expect(() =>
			assertMediaLifecycle({
				rules: [
					abortIncompleteMultipart,
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
					abortIncompleteMultipart,
					{
						id: "expire-rescue-ledger",
						enabled: true,
						// Cloudflare returns an omitted prefix for newer all-prefix rules
						// and an empty string for older equivalent rules.
						conditions: {},
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
					abortIncompleteMultipart,
					{
						id: "scoped-expiry",
						enabled: true,
						conditions: { prefix: "partial/" },
						deleteObjectsTransition: {
							condition: { type: "Age", maxAge: 2_592_000 },
						},
					},
				],
			}),
		).toThrow();
		expect(() => assertQueueRescueLifecycle({ rules: [] })).toThrow();
		expect(() =>
			assertDurableBucketLifecycle(resources.avatarBucket, {
				rules: [abortIncompleteMultipart],
			}),
		).not.toThrow();
		expect(() =>
			assertDurableBucketLifecycle(resources.avatarBucket, {
				rules: [
					abortIncompleteMultipart,
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
		expect(() =>
			assertDurableBucketLifecycle(resources.avatarBucket, {
				rules: [
					{
						...abortIncompleteMultipart,
						abortMultipartUploadsTransition: {
							condition: { type: "Age", maxAge: 604_800 },
						},
					},
				],
			}),
		).toThrow("reviewed retention age");
		expect(() =>
			assertMediaNotifications({
				bucketName: "relayapi-media",
				queues: [
					{
						queueName: "relayapi-media-cleanup",
						rules: [{ actions: [...resources.mediaEventActions] }],
					},
					{ queueName: "unexpected-queue", rules: [] },
				],
			}),
		).toThrow();
	});

	it("keeps the application on single PUT uploads while lifecycle policy bounds multipart residue", async () => {
		const repoRoot = new URL("../../../../", import.meta.url).pathname;
		const multipartCreators: string[] = [];
		for await (const path of new Bun.Glob("apps/api/src/**/*.ts").scan({
			cwd: repoRoot,
		})) {
			if (path.includes("/__tests__/")) continue;
			const source = await Bun.file(`${repoRoot}${path}`).text();
			if (
				source.includes(".createMultipartUpload(") ||
				source.includes(".resumeMultipartUpload(")
			) {
				multipartCreators.push(path);
			}
		}
		expect(multipartCreators).toEqual([]);
		expect(resources.incompleteMultipartRetentionSeconds).toBe(86_400);
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

	it("requires the exact browser upload CORS policy", () => {
		expect(() =>
			assertMediaCors({
				rules: [
					{
						allowed: {
							origins: ["https://relayapi.dev"],
							methods: ["PUT"],
							headers: ["Content-Type", "If-None-Match"],
						},
						maxAgeSeconds: 3600,
					},
				],
			}),
		).not.toThrow();
		expect(() =>
			assertMediaCors({
				rules: [
					{
						allowed: {
							origins: ["*"],
							methods: ["GET", "PUT"],
							headers: ["*"],
						},
						maxAgeSeconds: 3600,
					},
				],
			}),
		).toThrow("presigned-upload policy");
	});

	it("requires all five reviewed R2 buckets in the selected jurisdiction", () => {
		for (const bucket of [
			resources.mediaBucket,
			resources.avatarBucket,
			resources.thumbnailBucket,
			resources.queueRescueBucket,
			resources.publicAssetsBucket,
		]) {
			expect(() =>
				assertBucket(bucket, {
					name: bucket,
					jurisdiction: resources.r2Jurisdiction,
				}),
			).not.toThrow();
		}
		expect(() =>
			assertBucket(resources.mediaBucket, {
				name: "wrong-bucket",
				jurisdiction: resources.r2Jurisdiction,
			}),
		).toThrow();
		expect(() =>
			assertBucket(resources.mediaBucket, {
				name: resources.mediaBucket,
				jurisdiction: "eu",
			}),
		).toThrow();
	});

	it("requires the exact active thumbnail domain and modern TLS", () => {
		const activeDomain = {
			domains: [
				{
					domain: resources.thumbnailPublicDomain.hostname,
					enabled: true,
					status: { ownership: "active", ssl: "active" },
					minTLS: "1.2",
					zoneId: "zone-id",
					zoneName: resources.thumbnailPublicDomain.zoneName,
				},
			],
		};
		expect(() => assertThumbnailCustomDomain(activeDomain)).not.toThrow();

		const strongerTls = structuredClone(activeDomain);
		if (strongerTls.domains[0]) strongerTls.domains[0].minTLS = "1.3";
		expect(() => assertThumbnailCustomDomain(strongerTls)).not.toThrow();

		const legacyTls = structuredClone(activeDomain);
		if (legacyTls.domains[0]) legacyTls.domains[0].minTLS = "1.1";
		expect(() => assertThumbnailCustomDomain(legacyTls)).toThrow(
			"active TLS policy",
		);

		const pendingSsl = structuredClone(activeDomain);
		if (pendingSsl.domains[0]) pendingSsl.domains[0].status.ssl = "pending";
		expect(() => assertThumbnailCustomDomain(pendingSsl)).toThrow(
			"active TLS policy",
		);

		const extraDomain = structuredClone(activeDomain);
		const reviewedDomain = activeDomain.domains[0];
		if (!reviewedDomain) throw new Error("missing reviewed domain fixture");
		extraDomain.domains.push({
			...structuredClone(reviewedDomain),
			domain: "unreviewed.relayapi.dev",
		});
		expect(() => assertThumbnailCustomDomain(extraDomain)).toThrow(
			"active TLS policy",
		);
	});

	it("keeps every private R2 bucket off its public r2.dev hostname", () => {
		expect([...resources.privateR2Buckets].sort()).toEqual(
			[
				resources.mediaBucket,
				resources.avatarBucket,
				resources.thumbnailBucket,
				resources.queueRescueBucket,
			].sort(),
		);
		for (const bucketName of resources.privateR2Buckets) {
			expect(() =>
				assertPrivateR2DevDisabled(bucketName, {
					bucketId: "bucket-id",
					domain: "opaque-account-domain.r2.dev",
					enabled: false,
				}),
			).not.toThrow();
			expect(() =>
				assertPrivateR2DevDisabled(bucketName, {
					bucketId: "bucket-id",
					domain: "opaque-account-domain.r2.dev",
					enabled: true,
				}),
			).toThrow("disable public r2.dev access");
		}
		expect(() =>
			assertPrivateR2DevDisabled("relayapi-public-assets", {
				bucketId: "bucket-id",
				domain: "opaque-account-domain.r2.dev",
				enabled: false,
			}),
		).toThrow("No private R2 public-access policy");
	});

	it("requires every producer, consumer, DLQ, and rescue policy", () => {
		const queues = validQueues();
		expect(() => assertQueueConfiguration(queues)).not.toThrow();
		const containedQueues = structuredClone(queues);
		for (const queue of containedQueues) {
			if (!queue.settings) throw new Error("Queue settings fixture is missing");
			queue.settings.delivery_paused = true;
		}
		expect(() =>
			assertQueueConfiguration(containedQueues, "paused"),
		).not.toThrow();
		expect(() => assertQueueConfiguration(queues, "paused")).toThrow(
			"delivery is not paused",
		);

		const liveListShape = structuredClone(queues);
		for (const queue of liveListShape) {
			for (const consumer of queue.consumers ?? []) {
				consumer.script = consumer.script_name;
				delete consumer.script_name;
			}
		}
		expect(() => assertQueueConfiguration(liveListShape)).not.toThrow();

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

		const missingReviewedAppProducer = structuredClone(queues);
		const emailWithoutApp = missingReviewedAppProducer.find(
			(queue) => queue.queue_name === "relayapi-email",
		);
		if (emailWithoutApp) {
			emailWithoutApp.producers = emailWithoutApp.producers?.filter(
				(producer) => producer.script !== "relayapi-app",
			);
		}
		expect(() => assertQueueConfiguration(missingReviewedAppProducer)).toThrow(
			"producer topology",
		);

		const extraProducer = structuredClone(queues);
		const email = extraProducer.find(
			(queue) => queue.queue_name === "relayapi-email",
		);
		email?.producers?.push({ type: "worker", script: "unreviewed-worker" });
		expect(() => assertQueueConfiguration(extraProducer)).toThrow(
			"producer topology",
		);

		const appProducerOnWrongQueue = structuredClone(queues);
		const publishWithApp = appProducerOnWrongQueue.find(
			(queue) => queue.queue_name === "relayapi-publish",
		);
		publishWithApp?.producers?.push({
			type: "worker",
			script: "relayapi-app",
		});
		expect(() => assertQueueConfiguration(appProducerOnWrongQueue)).toThrow(
			"producer topology",
		);

		const extraConsumer = structuredClone(queues);
		extraConsumer[0]?.consumers?.push({ type: "http_pull" });
		expect(() => assertQueueConfiguration(extraConsumer)).toThrow(
			"consumer topology",
		);
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
		expect(() => assertQueuePrerequisites(paused, "either")).not.toThrow();

		const extendedRetention = structuredClone(prerequisites);
		if (extendedRetention[0]?.settings) {
			extendedRetention[0].settings.message_retention_period = 345_600;
		}
		expect(() => assertQueuePrerequisites(extendedRetention)).toThrow(
			"message retention",
		);
	});

	it("converges Queue retention without changing pause state", async () => {
		const queues = validQueues();
		const drifted = structuredClone(queues);
		const firstQueue = drifted[0];
		if (
			!firstQueue?.queue_id ||
			!firstQueue.queue_name ||
			!firstQueue.settings
		) {
			throw new Error("Queue fixture is incomplete");
		}
		firstQueue.settings.delivery_paused = false;
		firstQueue.settings.message_retention_period = 345_600;
		expect(planQueueRetentionUpdates(drifted)).toEqual([
			{
				queueId: firstQueue.queue_id,
				queueName: firstQueue.queue_name,
				deliveryPaused: false,
			},
		]);

		let listCount = 0;
		const calls: Array<{ method: string; body?: unknown }> = [];
		const fetchMock = Object.assign(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				calls.push({
					method,
					...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
				});
				if (method === "GET") {
					listCount += 1;
					return Response.json({
						success: true,
						result: listCount === 1 ? drifted : queues,
						result_info: { total_pages: 1 },
					});
				}
				if (method === "PUT") {
					return Response.json({
						success: true,
						result: queues[0],
					});
				}
				throw new Error(`Unexpected method ${method}`);
			},
			{ preconnect: fetch.preconnect },
		);

		await expect(
			configureProductionQueueRetention(
				"not-a-real-token",
				resources.accountId,
				fetchMock,
			),
		).resolves.toBe(1);
		expect(calls.filter((call) => call.method === "PUT")).toEqual([
			{
				method: "PUT",
				body: {
					queue_name: queues[0]?.queue_name,
					settings: {
						message_retention_period: resources.queueMessageRetentionSeconds,
						delivery_paused: false,
					},
				},
			},
		]);
	});

	it("selects strict ordinary and contained pre-live verification modes", () => {
		expect(verificationMode([])).toBe("full");
		expect(verificationMode(["--predeploy"])).toBe("predeploy");
		expect(verificationMode(["--prelive-predeploy"])).toBe("prelive-predeploy");
		expect(verificationMode(["--prelive-contained"])).toBe("prelive-contained");
		expect(verificationMode(["--stripe-contract"])).toBe("stripe-contract");
		expect(verificationMode(["--stripe-price"])).toBe("stripe-price");
		expect(() => verificationMode(["--external-only"])).toThrow();
	});

	it("pins the canonical Stripe Pro price shape", () => {
		const valid = {
			id: "price_pro",
			active: true,
			type: "recurring",
			currency: "usd",
			unit_amount: 500,
			currency_options: null,
			recurring: {
				interval: "month",
				interval_count: 1,
				usage_type: "licensed",
			},
			billing_scheme: "per_unit",
			tax_behavior: "unspecified",
			metadata: { relayapi_managed_by: "relayapi", relayapi_role: "base" },
			product: {
				active: true,
				tax_code: null,
				metadata: {
					relayapi_managed_by: "relayapi",
					relayapi_role: "base",
				},
			},
		};
		expect(() => assertStripeProPrice(valid, "price_pro")).not.toThrow();
		for (const invalid of [
			{ ...valid, unit_amount: 501 },
			{ ...valid, currency: "eur" },
			{ ...valid, recurring: { interval: "year", interval_count: 1 } },
			{ ...valid, currency_options: { eur: {} } },
		]) {
			expect(() => assertStripeProPrice(invalid, "price_pro")).toThrow();
		}
		const phone = {
			...valid,
			id: "price_phone",
			unit_amount: 1_500,
			metadata: {
				relayapi_managed_by: "relayapi",
				relayapi_role: "phone_addon",
			},
			product: {
				active: true,
				tax_code: null,
				metadata: {
					relayapi_managed_by: "relayapi",
					relayapi_role: "phone_addon",
				},
			},
		};
		expect(() =>
			assertStripePhoneAddonPrice(phone, "price_phone"),
		).not.toThrow();
		expect(() =>
			assertStripePhoneAddonPrice({ ...phone, unit_amount: 0 }, "price_phone"),
		).toThrow();
	});

	it("pins the Stripe webhook and portal isolation contracts", () => {
		const endpoint = {
			id: "we_relayapi",
			url: `${resources.apiBaseUrl}/webhooks/stripe`,
			status: "enabled",
			api_version: "2026-06-24.dahlia",
			enabled_events: [
				"checkout.session.async_payment_failed",
				"checkout.session.async_payment_succeeded",
				"checkout.session.completed",
				"credit_note.created",
				"credit_note.updated",
				"customer.subscription.created",
				"customer.subscription.deleted",
				"customer.subscription.updated",
				"invoice.created",
				"invoice.finalization_failed",
				"invoice.finalized",
				"invoice.marked_uncollectible",
				"invoice.paid",
				"invoice.payment_failed",
				"invoice.voided",
				"charge.dispute.created",
				"charge.dispute.closed",
				"refund.created",
				"refund.failed",
				"refund.updated",
			],
		};
		expect(() => assertStripeWebhookEndpoint(endpoint)).not.toThrow();
		expect(() =>
			assertStripeWebhookEndpoint({
				...endpoint,
				enabled_events: [...endpoint.enabled_events, "*"],
			}),
		).toThrow("event manifest");

		const portal = {
			id: "bpc_relayapi",
			active: true,
			features: {
				payment_method_update: { enabled: true },
				subscription_cancel: { enabled: true, mode: "at_period_end" },
				subscription_update: {
					enabled: false,
					default_allowed_updates: [],
				},
			},
		};
		expect(() =>
			assertStripePortalConfiguration(portal, "bpc_relayapi"),
		).not.toThrow();
		expect(() =>
			assertStripePortalConfiguration(
				{
					...portal,
					features: {
						...portal.features,
						subscription_update: { enabled: true },
					},
				},
				"bpc_relayapi",
			),
		).toThrow("updates disabled");
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
		expect(() =>
			assertRequiredSecrets([
				...baseline,
				{ name: "FACEBOOK_APP_ID", type: "secret_text" },
				{ name: "FACEBOOK_APP_SECRET", type: "secret_text" },
				{ name: "FACEBOOK_WEBHOOK_VERIFY_TOKEN", type: "secret_text" },
			]),
		).not.toThrow();
		expect(() =>
			assertRequiredSecrets([
				...baseline,
				{ name: "WHATSAPP_APP_ID", type: "secret_text" },
				{ name: "WHATSAPP_APP_SECRET", type: "secret_text" },
				{ name: "WHATSAPP_CONFIG_ID", type: "secret_text" },
				{ name: "FACEBOOK_WEBHOOK_VERIFY_TOKEN", type: "secret_text" },
			]),
		).not.toThrow();
		expect(() =>
			assertRequiredSecrets([
				...baseline,
				{ name: "FACEBOOK_WEBHOOK_VERIFY_TOKEN", type: "secret_text" },
			]),
		).toThrow("without a complete provider group");
		expect(() =>
			assertRequiredSecrets([
				...baseline,
				{ name: "BETTER_AUTH_SECRET", type: "secret_text" },
			]),
		).toThrow("outside the production allowlist");
	});

	it("requires exact active Worker binding identities", () => {
		expect(resources.workerBindings.BASELINE_GENERATION.text).toBe(
			String(BASELINE_GENERATION),
		);
		const bindings = validWorkerBindings();
		const runtime = structuredClone(resources.workerRuntime);
		expect(() =>
			assertWorkerBindings({
				resources: { bindings, script_runtime: runtime },
			}),
		).not.toThrow();
		expect(() =>
			assertWorkerBindings({
				resources: { bindings: bindings.slice(1), script_runtime: runtime },
			}),
		).toThrow();

		const misbound = structuredClone(bindings);
		const media = misbound.find((binding) => binding.name === "MEDIA_BUCKET");
		if (media) media.bucket_name = "wrong-bucket";
		expect(() =>
			assertWorkerBindings({
				resources: { bindings: misbound, script_runtime: runtime },
			}),
		).toThrow("MEDIA_BUCKET points to an unexpected resource");

		expect(() =>
			assertWorkerBindings({
				resources: {
					bindings: [
						...bindings,
						{
							name: "AUTOMATION_QUEUE",
							type: "queue",
							queue_name: "relayapi-automation",
						},
					],
					script_runtime: runtime,
				},
			}),
		).toThrow("exactly match");
	});

	it("requires exact runtime, placement, observability, and cron policy", () => {
		const unsafeRuntime = structuredClone(resources.workerRuntime);
		unsafeRuntime.compatibility_flags = ["nodejs_compat"];
		expect(() =>
			assertWorkerBindings({
				resources: {
					bindings: validWorkerBindings(),
					script_runtime: unsafeRuntime,
				},
			}),
		).toThrow("compatibility flags");

		expect(() =>
			assertWorkerSettings(structuredClone(resources.workerSettings)),
		).not.toThrow();
		expect(() =>
			assertWorkerSettings({
				...structuredClone(resources.workerSettings),
				placement: { mode: "off" },
			}),
		).toThrow("placement");

		expect(() =>
			assertCronSchedules(resources.cronSchedules.map((cron) => ({ cron }))),
		).not.toThrow();
		expect(() =>
			assertCronScheduleResponse({
				schedules: resources.cronSchedules.map((cron) => ({ cron })),
			}),
		).not.toThrow();
		expect(() =>
			assertCronScheduleResponse(
				resources.cronSchedules.map((cron) => ({ cron })) as never,
			),
		).toThrow("malformed");
		expect(() =>
			assertCronSchedules(
				resources.cronSchedules.slice(1).map((cron) => ({ cron })),
			),
		).toThrow("cron");
	});

	it("rejects non-text secret bindings even when the name is required", () => {
		const bindings = resources.requiredSecrets.map((name) => ({
			name,
			type: "secret_text",
		}));
		const required = bindings.find(
			(binding) => binding.name === resources.requiredSecrets[0],
		);
		if (!required) throw new Error("missing required secret fixture");
		required.type = "secret_key";
		expect(() => assertRequiredSecrets(bindings)).toThrow(
			"unsupported Worker secret binding types",
		);
	});

	it("binds the API hostname exactly once to the reviewed Worker", () => {
		expect(() =>
			assertApiWorkerDomain([
				{
					hostname: resources.apiHostname,
					service: resources.workerName,
					zone_name: resources.zoneName,
				},
			]),
		).not.toThrow();
		expect(() =>
			assertApiWorkerDomain([
				{
					hostname: resources.apiHostname,
					service: "relayapi-app",
					zone_name: resources.zoneName,
				},
			]),
		).toThrow("not mapped exactly once");
	});

	it("binds the public-link hostname exactly once to the reviewed Worker", () => {
		expect(() =>
			assertPublicLinkWorkerDomain([
				{
					hostname: resources.publicLinkHostname,
					service: resources.workerName,
					zone_name: resources.zoneName,
				},
			]),
		).not.toThrow();
		expect(() =>
			assertPublicLinkWorkerDomain([
				{
					hostname: resources.publicLinkHostname,
					service: "relayapi-app",
					zone_name: resources.zoneName,
				},
			]),
		).toThrow("not mapped exactly once");
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
		expect(config).toContain(
			'{ "pattern": "api.relayapi.dev", "custom_domain": true }',
		);
		expect(config).toContain(
			'{ "pattern": "go.relayapi.dev", "custom_domain": true }',
		);
		expect(config).toContain(
			'"PUBLIC_LINK_BASE_URL": "https://go.relayapi.dev"',
		);
		expect(config).toContain(`"BASELINE_GENERATION": "${BASELINE_GENERATION}"`);
		expect(config).not.toContain('"jurisdiction": "default"');
		for (const expected of resources.queueConsumers) {
			expect(config).toContain(`"queue": "${expected.queue}"`);
		}
		for (const binding of resources.requiredBindings) {
			expect(config).toContain(`"${binding}"`);
		}
		for (const relativePath of [
			"../../../app/wrangler.jsonc",
			"../../../docs/wrangler.jsonc",
		]) {
			const sameZoneWorkerConfig = readFileSync(
				new URL(relativePath, import.meta.url),
				"utf8",
			);
			expect(sameZoneWorkerConfig).toContain('"global_fetch_strictly_public"');
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
		expect(deploy).toContain("github.ref_protected");
		expect(deploy).toContain(
			"needs: [baseline-generation-guard, test, platform-tests, contracts, migration-gate]",
		);
		expect(workflow).toContain("baseline-generation-guard:");
		expect(workflow).toContain(
			"bun scripts/check-live-baseline-generation.ts --allow-initial-generation-bootstrap",
		);
		expect(workflow).toContain(
			"needs.baseline-generation-guard.outputs.automatic_deploy_allowed == 'true'",
		);
		expect(deploy).toContain("secrets.PRODUCTION_DATABASE_URL");
		expect(workflow).not.toContain("backup_restore_confirmed");
		expect(deploy).toContain("PRODUCTION_DATABASE_ACCESS_CLIENT_ID");
		expect(deploy).toContain("PRODUCTION_DATABASE_ACCESS_CLIENT_SECRET");
		expect(deploy).toContain("cloudflare/cloudflared:2026.6.0");
		expect(deploy).toContain("access tcp");
		expect(deploy).toContain('sslmode") !== "verify-full"');
		expect(migrationGate).toContain(
			"pgvector/pgvector:0.8.5-pg18-bookworm@sha256:",
		);
		expect(workflow).toContain("compatible_app_version_id:");
		expectInOrder(deploy, [
			"Capture currently deployed Worker version",
			"Verify active dashboard supports identity-deletion-v1",
			"inputs.compatible_app_version_id",
			"Apply reviewed production migrations",
			"--cwd packages/db migrate",
		]);
		expectInOrder(workflow, [
			"baseline-generation-guard:",
			"Compare repository and live baseline generations before database work",
			"  migration-gate:",
			"  deploy:",
		]);

		expectInOrder(migrationGate, [
			"db:migration-manifest",
			"--cwd packages/db migrate",
			"--cwd packages/db migrate",
			"--cwd packages/db verify:migrations",
			"--cwd packages/db migration:history:current",
		]);
		expectInOrder(deploy, [
			"Start Access-protected production database tunnel",
			"cloudflare:configure-queue-retention",
			"cloudflare:verify-prerequisites",
			"db:migration-manifest",
			"--cwd packages/db migration:history",
			"wrangler deployments status --json",
			"--cwd packages/db migrate",
			"--cwd packages/db verify:migrations",
			"--cwd packages/db migration:history:current",
			"WRANGLER_OUTPUT_FILE_PATH",
			"secrets:cf:deploy -- api --",
			"relayapi-api-deploy.jsonl",
			"cloudflare:smoke-production",
			"cloudflare:verify-production",
			"wrangler rollback",
		]);
		expect(workflow).not.toContain("run: bun run db:migrate");
		expect(workflow).not.toContain("run: bun run db:verify\n");
		expect(workflow).not.toContain("run: bun run db:migration-history");
		expect(deploy).toContain("EXPECTED_WORKER_VERSION_ID");
		expect(deploy).toContain("steps.previous_worker.outputs.version_id");
		expect(deploy).toContain("GITHUB_RUN_ID");
		expect(deploy).toContain("GITHUB_RUN_ATTEMPT");
		expect(deploy).toContain('versions view "$active_version" --json');
		expect(deploy).toContain("deploy_attempt.outputs.exit_code");
		expect(deploy).not.toContain("steps.deploy_worker.outcome");
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
			'"cloudflare:configure-queue-retention": "bun scripts/configure-queue-retention.ts"',
		);
		expect(packageJson).toContain(
			'"cloudflare:verify-prerequisites": "bun scripts/verify-cloudflare-production.ts --predeploy"',
		);
		expect(packageJson).not.toContain("--include-env=false");
	});

	it("uses workflow-owned database connections without opening developer tunnels", () => {
		for (const relativePath of [
			"../../../../.github/workflows/ci-db-migrations.yml",
			"../../../../.github/workflows/deploy-api.yml",
		]) {
			const workflow = readFileSync(
				new URL(relativePath, import.meta.url),
				"utf8",
			);
			expect(workflow).not.toContain("run: bun run db:migrate");
			expect(workflow).not.toContain("run: bun run db:verify\n");
			expect(workflow).not.toContain("run: bun run db:migration-history");
			expect(workflow).toContain("bun run --cwd packages/db migrate");
			expect(workflow).toContain("bun run --cwd packages/db verify:migrations");
			expect(workflow).toContain(
				"bun run --cwd packages/db migration:history:current",
			);
		}
	});
});
