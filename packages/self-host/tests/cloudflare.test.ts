import { afterEach, describe, expect, mock, test } from "bun:test";
import { CloudflareClient } from "../src/cloudflare.js";
import { withResolvedHyperdriveCaCertificateId } from "../src/config.js";
import {
	QUEUE_MESSAGE_RETENTION_SECONDS,
	QUEUE_NAMES,
	RESOURCE_NAMES,
} from "../src/constants.js";
import type { SelfHostConfig } from "../src/types.js";

const originalFetch = globalThis.fetch;
const hyperdriveCaCertificateId = "11111111-2222-4333-8444-555555555555";
const rotatedCaCertificateId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const thirdCaCertificateId = "99999999-8888-4777-8666-555555555555";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function response(result: unknown): Response {
	return Response.json({ success: true, result, errors: [], messages: [] });
}

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
		hyperdriveCaCertificateId,
	},
	features: { email: false, ai: false, downloader: false },
};

const provisionedConfig: SelfHostConfig = {
	...config,
	resources: {
		kvNamespaceId: "kv-id",
		hyperdriveId: "hyperdrive-id",
		queues: Object.fromEntries(
			QUEUE_NAMES.map((name) => [
				name,
				`id-${RESOURCE_NAMES.hyperdrive}-${name}`,
			]),
		) as NonNullable<SelfHostConfig["resources"]>["queues"],
	},
};

const runtimeDatabaseUrl =
	"postgresql://runtime:super-secret@db.example.com/relay?sslmode=verify-full";

function hyperdrive(
	input: {
		name?: string;
		host?: string;
		user?: string;
		sslmode?: "require" | "verify-ca" | "verify-full";
		cachingDisabled?: boolean;
		caCertificateId?: string;
		originConnectionLimit?: number;
	} = {},
) {
	return {
		id: "hyperdrive-id",
		name: input.name ?? RESOURCE_NAMES.hyperdrive,
		origin: {
			host: input.host ?? "db.example.com",
			port: 5432,
			scheme: "postgresql",
			database: "relay",
			user: input.user ?? "runtime",
		},
		caching: { disabled: input.cachingDisabled ?? true },
		mtls: {
			sslmode: input.sslmode ?? "verify-full",
			ca_certificate_id: input.caCertificateId ?? hyperdriveCaCertificateId,
			mtls_certificate_id: "client-id",
		},
		origin_connection_limit: input.originConnectionLimit ?? 37,
	};
}

function installHyperdrivePlanFetch(remoteCaCertificateId: string): void {
	const existing = hyperdrive({ caCertificateId: remoteCaCertificateId });
	globalThis.fetch = Object.assign(
		mock(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/hyperdrive/configs/hyperdrive-id")) {
				return response(existing);
			}
			if (url.includes("/hyperdrive/configs?")) return response([existing]);
			if (url.includes("/storage/kv/namespaces?")) return response([]);
			if (url.includes("/r2/buckets?")) return response({ buckets: [] });
			if (url.includes("/queues?")) return response([]);
			throw new Error(`Unhandled test request: ${url}`);
		}),
		{ preconnect: originalFetch.preconnect },
	);
}

describe("Cloudflare provisioning", () => {
	test("creates a missing stack without placing credentials in URLs", async () => {
		expect(QUEUE_MESSAGE_RETENTION_SECONDS).toBe(86_400);
		const calls: Array<{
			url: string;
			method: string;
			body?: Record<string, unknown>;
			authorization: string | null;
			r2Jurisdiction: string | null;
		}> = [];
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				const body = init?.body ? JSON.parse(String(init.body)) : undefined;
				const headers = new Headers(init?.headers);
				calls.push({
					url,
					method,
					...(body ? { body } : {}),
					authorization: headers.get("authorization"),
					r2Jurisdiction: headers.get("cf-r2-jurisdiction"),
				});

				if (method === "GET" && url.includes("/storage/kv/namespaces?")) {
					return response([]);
				}
				if (method === "GET" && url.includes("/r2/buckets?")) {
					return response({ buckets: [] });
				}
				if (method === "GET" && url.includes("/queues?")) return response([]);
				if (method === "GET" && url.includes("/hyperdrive/configs?")) {
					return response([]);
				}
				if (method === "POST" && url.endsWith("/storage/kv/namespaces")) {
					return response({ id: "kv-id", title: RESOURCE_NAMES.kv });
				}
				if (method === "POST" && url.endsWith("/r2/buckets")) {
					return response({ name: body?.name });
				}
				if (method === "POST" && url.endsWith("/queues")) {
					const name = String(body?.queue_name);
					return response({
						queue_id: `id-${name}`,
						queue_name: name,
						settings: { message_retention_period: 345_600 },
					});
				}
				if (method === "PUT" && url.includes("/queues/")) {
					const name = String(body?.queue_name);
					return response({
						queue_id: `id-${name}`,
						queue_name: name,
						settings: {
							message_retention_period: QUEUE_MESSAGE_RETENTION_SECONDS,
						},
					});
				}
				if (method === "POST" && url.endsWith("/hyperdrive/configs")) {
					return response({
						id: "hyperdrive-id",
						name: RESOURCE_NAMES.hyperdrive,
					});
				}
				if (
					method === "GET" &&
					url.endsWith("/hyperdrive/configs/hyperdrive-id")
				) {
					return response({
						id: "hyperdrive-id",
						name: RESOURCE_NAMES.hyperdrive,
						origin: {
							host: "db.example.com",
							port: 5432,
							scheme: "postgresql",
							database: "relay",
							user: "runtime",
						},
						caching: { disabled: true },
						mtls: {
							sslmode: "verify-full",
							ca_certificate_id: hyperdriveCaCertificateId,
						},
					});
				}
				if (method === "GET" && url.endsWith("/lifecycle")) {
					return response({
						rules: [{ id: "operator-owned-rule", enabled: true }],
					});
				}
				if (method === "PUT" && url.endsWith("/lifecycle")) {
					return response({});
				}
				if (method === "PUT" && url.includes("/event_notifications/r2/")) {
					return response({});
				}
				if (method === "GET" && url.endsWith("/domains/custom")) {
					return response({ domains: [] });
				}
				if (method === "POST" && url.endsWith("/domains/custom")) {
					return response({});
				}
				throw new Error(`Unhandled test request: ${method} ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);

		const client = new CloudflareClient(
			"account-id",
			"cloudflare-token",
			"https://cloudflare.test/client/v4",
		);
		const resources = await client.apply(
			config,
			[
				"postgresql://runtime",
				"super-secret@db.example.com/relay?sslmode=verify-full",
			].join(":"),
		);

		expect(resources.kvNamespaceId).toBe("kv-id");
		expect(resources.hyperdriveId).toBe("hyperdrive-id");
		expect(Object.keys(resources.queues)).toHaveLength(QUEUE_NAMES.length);
		const queueRetentionUpdates = calls.filter(
			(call) =>
				call.method === "PUT" &&
				call.url.includes("/queues/id-relayapi-selfhost-") &&
				call.body?.settings !== undefined,
		);
		expect(queueRetentionUpdates).toHaveLength(QUEUE_NAMES.length);
		for (const update of queueRetentionUpdates) {
			expect(update.body).toMatchObject({
				settings: {
					message_retention_period: QUEUE_MESSAGE_RETENTION_SECONDS,
				},
			});
		}
		expect(
			calls.every((call) => call.authorization === "Bearer cloudflare-token"),
		).toBe(true);
		expect(calls.some((call) => call.url.includes("super-secret"))).toBe(false);
		const r2Calls = calls.filter(
			(call) =>
				call.url.includes("/r2/") ||
				call.url.includes("/event_notifications/r2/"),
		);
		expect(
			new Set(
				r2Calls
					.filter((call) => call.url.includes("/r2/buckets?"))
					.map((call) => call.r2Jurisdiction),
			),
		).toEqual(new Set(["default", "eu"]));
		for (const call of r2Calls.filter(
			(call) => !call.url.includes("/r2/buckets?"),
		)) {
			expect(call.r2Jurisdiction).toBe("default");
		}
		const hyperdriveCreate = calls.find(
			(call) =>
				call.method === "POST" && call.url.endsWith("/hyperdrive/configs"),
		);
		expect(hyperdriveCreate?.body).toMatchObject({
			origin: {
				host: "db.example.com",
				user: "runtime",
				password: "super-secret",
			},
			caching: { disabled: true },
			mtls: {
				sslmode: "verify-full",
				ca_certificate_id: hyperdriveCaCertificateId,
			},
		});
		const lifecycleUpdates = calls.filter(
			(call) => call.method === "PUT" && call.url.endsWith("/lifecycle"),
		);
		expect(lifecycleUpdates).toHaveLength(5);
		for (const update of lifecycleUpdates) {
			expect(update.body?.rules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "operator-owned-rule" }),
					expect.objectContaining({
						id: "relayapi-abort-incomplete-multipart",
						conditions: { prefix: "" },
						abortMultipartUploadsTransition: {
							condition: { type: "Age", maxAge: 86_400 },
						},
					}),
				]),
			);
		}
		const expiringUpdates = lifecycleUpdates.filter(
			(update) =>
				update.url.includes(RESOURCE_NAMES.buckets.media) ||
				update.url.includes(RESOURCE_NAMES.buckets.queueRescue),
		);
		expect(expiringUpdates).toHaveLength(2);
		for (const update of expiringUpdates) {
			expect(update.body?.rules).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						deleteObjectsTransition: {
							condition: { type: "Age", maxAge: 2_592_000 },
						},
					}),
				]),
			);
		}
	});

	test("rejects an existing bucket in the other immutable jurisdiction", async () => {
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				if (url.includes("/storage/kv/namespaces?")) return response([]);
				if (url.includes("/queues?")) return response([]);
				if (url.includes("/hyperdrive/configs?")) return response([]);
				if (url.includes("/r2/buckets?")) {
					return response({
						buckets:
							headers.get("cf-r2-jurisdiction") === "eu"
								? [{ name: RESOURCE_NAMES.buckets.media, jurisdiction: "eu" }]
								: [],
					});
				}
				throw new Error(`Unhandled test request: ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = new CloudflareClient(
			"account-id",
			"cloudflare-token",
			"https://cloudflare.test/client/v4",
		);
		await expect(
			client.plan(
				config,
				"postgresql://runtime:secret@db.example.com/relay?sslmode=verify-full",
			),
		).rejects.toThrow("jurisdiction is immutable");
	});

	test("resolves a pinned Hyperdrive ID first and reports only readable drift", async () => {
		const calls: string[] = [];
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL) => {
				const url = String(input);
				calls.push(url);
				if (url.endsWith("/hyperdrive/configs/hyperdrive-id")) {
					return response(
						hyperdrive({
							name: "legacy-name",
							sslmode: "verify-ca",
							cachingDisabled: false,
						}),
					);
				}
				if (url.includes("/hyperdrive/configs?")) return response([]);
				if (url.includes("/storage/kv/namespaces?")) return response([]);
				if (url.includes("/r2/buckets?")) return response({ buckets: [] });
				if (url.includes("/queues?")) return response([]);
				throw new Error(`Unhandled test request: ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = new CloudflareClient(
			"account-id",
			"cloudflare-token",
			"https://cloudflare.test/client/v4",
		);
		const plan = await client.plan(provisionedConfig, runtimeDatabaseUrl);
		expect(calls[0]).toEndWith("/hyperdrive/configs/hyperdrive-id");
		expect(plan.hyperdrive).toEqual({
			name: RESOURCE_NAMES.hyperdrive,
			id: "hyperdrive-id",
			currentCaCertificateId: hyperdriveCaCertificateId,
			caCertificateId: hyperdriveCaCertificateId,
			caCertificateAction: "retain",
			action: "reconcile",
			visibleDrift: ["name", "caching.disabled", "mtls.sslmode"],
			credentialAction: "reapply_write_only",
		});
		expect(JSON.stringify(plan)).not.toContain("super-secret");
	});

	test("adopts a legacy config's existing CA intent but rejects missing or changed trust anchors", async () => {
		const legacyConfig = structuredClone(provisionedConfig);
		delete legacyConfig.cloudflare.hyperdriveCaCertificateId;
		const installFetch = (existing: Record<string, unknown>) => {
			globalThis.fetch = Object.assign(
				mock(async (input: RequestInfo | URL) => {
					const url = String(input);
					if (url.endsWith("/hyperdrive/configs/hyperdrive-id")) {
						return response(existing);
					}
					if (url.includes("/hyperdrive/configs?")) return response([existing]);
					if (url.includes("/storage/kv/namespaces?")) return response([]);
					if (url.includes("/r2/buckets?")) return response({ buckets: [] });
					if (url.includes("/queues?")) return response([]);
					throw new Error(`Unhandled test request: ${url}`);
				}),
				{ preconnect: originalFetch.preconnect },
			);
		};

		installFetch(hyperdrive());
		const client = new CloudflareClient(
			"account-id",
			"cloudflare-token",
			"https://cloudflare.test/client/v4",
		);
		const plan = await client.plan(legacyConfig, runtimeDatabaseUrl);
		expect(plan.hyperdrive.caCertificateId).toBe(hyperdriveCaCertificateId);
		expect(plan.hyperdrive.caCertificateAction).toBe("adopt");
		expect(
			withResolvedHyperdriveCaCertificateId(
				legacyConfig,
				plan.hyperdrive.caCertificateId,
			).cloudflare.hyperdriveCaCertificateId,
		).toBe(hyperdriveCaCertificateId);

		const unpinnedLegacyConfig = structuredClone(config);
		delete unpinnedLegacyConfig.cloudflare.hyperdriveCaCertificateId;
		installFetch(hyperdrive());
		await expect(
			client.plan(unpinnedLegacyConfig, runtimeDatabaseUrl),
		).rejects.toThrow("only from its exact pinned resource ID");
		installFetch(hyperdrive({ caCertificateId: rotatedCaCertificateId }));
		await expect(
			client.plan(unpinnedLegacyConfig, runtimeDatabaseUrl, {
				requestedCaCertificateId: rotatedCaCertificateId,
			}),
		).rejects.toThrow("only from its exact pinned resource ID");

		installFetch(hyperdrive());
		await expect(
			client.plan(config, runtimeDatabaseUrl, {
				requestedCaCertificateId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			}),
		).rejects.toThrow("exact operator-pinned resources.hyperdriveId");

		installFetch({
			...hyperdrive(),
			mtls: { sslmode: "verify-full" },
		});
		await expect(client.plan(legacyConfig, runtimeDatabaseUrl)).rejects.toThrow(
			"has no pinned CA certificate",
		);

		installFetch(hyperdrive());
		await expect(
			client.plan(
				{
					...provisionedConfig,
					cloudflare: {
						...provisionedConfig.cloudflare,
						hyperdriveCaCertificateId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
					},
				},
				runtimeDatabaseUrl,
			),
		).rejects.toThrow("pass --hyperdrive-ca-certificate-id explicitly");
	});

	test("authorizes explicit CA intent only from the persisted old-or-target state table", async () => {
		const scenarios: Array<{
			name: string;
			localCaCertificateId?: string;
			remoteCaCertificateId: string;
			action?: "retain" | "adopt" | "rotate";
			error?: string;
		}> = [
			{
				name: "stored old / remote old",
				localCaCertificateId: hyperdriveCaCertificateId,
				remoteCaCertificateId: hyperdriveCaCertificateId,
				action: "rotate",
			},
			{
				name: "stored old / remote target",
				localCaCertificateId: hyperdriveCaCertificateId,
				remoteCaCertificateId: rotatedCaCertificateId,
				action: "retain",
			},
			{
				name: "stored old / remote third",
				localCaCertificateId: hyperdriveCaCertificateId,
				remoteCaCertificateId: thirdCaCertificateId,
				error: "unexpected third state",
			},
			{
				name: "stored target / remote old",
				localCaCertificateId: rotatedCaCertificateId,
				remoteCaCertificateId: hyperdriveCaCertificateId,
				error: "unexpected third state",
			},
			{
				name: "stored target / remote target",
				localCaCertificateId: rotatedCaCertificateId,
				remoteCaCertificateId: rotatedCaCertificateId,
				action: "retain",
			},
			{
				name: "stored target / remote third",
				localCaCertificateId: rotatedCaCertificateId,
				remoteCaCertificateId: thirdCaCertificateId,
				error: "unexpected third state",
			},
			{
				name: "legacy absent / remote old",
				remoteCaCertificateId: hyperdriveCaCertificateId,
				error: "must first adopt and persist",
			},
			{
				name: "legacy absent / remote target",
				remoteCaCertificateId: rotatedCaCertificateId,
				action: "adopt",
			},
			{
				name: "legacy absent / remote third",
				remoteCaCertificateId: thirdCaCertificateId,
				error: "must first adopt and persist",
			},
		];
		const client = new CloudflareClient(
			"account-id",
			"cloudflare-token",
			"https://cloudflare.test/client/v4",
		);

		for (const scenario of scenarios) {
			installHyperdrivePlanFetch(scenario.remoteCaCertificateId);
			const scenarioConfig = structuredClone(provisionedConfig);
			if (scenario.localCaCertificateId) {
				scenarioConfig.cloudflare.hyperdriveCaCertificateId =
					scenario.localCaCertificateId;
			} else {
				delete scenarioConfig.cloudflare.hyperdriveCaCertificateId;
			}
			const operation = client.plan(scenarioConfig, runtimeDatabaseUrl, {
				requestedCaCertificateId: rotatedCaCertificateId,
			});
			if (scenario.error) {
				await expect(operation, scenario.name).rejects.toThrow(scenario.error);
			} else {
				if (!scenario.action) {
					throw new Error(`Missing expected action for ${scenario.name}`);
				}
				const plan = await operation;
				expect(plan.hyperdrive.caCertificateAction, scenario.name).toBe(
					scenario.action,
				);
				expect(plan.hyperdrive.caCertificateId, scenario.name).toBe(
					rotatedCaCertificateId,
				);
			}
		}
	});

	test("allows only the carried prior CA or target during the apply-time re-plan", async () => {
		const scenarios = [
			{
				name: "remote carried prior",
				remoteCaCertificateId: hyperdriveCaCertificateId,
				action: "rotate",
			},
			{
				name: "remote target",
				remoteCaCertificateId: rotatedCaCertificateId,
				action: "retain",
			},
			{
				name: "remote third",
				remoteCaCertificateId: thirdCaCertificateId,
				error: "unexpected third state",
			},
		] as const;
		const client = new CloudflareClient(
			"account-id",
			"cloudflare-token",
			"https://cloudflare.test/client/v4",
		);
		const applyConfig = structuredClone(provisionedConfig);
		applyConfig.cloudflare.hyperdriveCaCertificateId = rotatedCaCertificateId;

		for (const scenario of scenarios) {
			installHyperdrivePlanFetch(scenario.remoteCaCertificateId);
			const operation = client.plan(applyConfig, runtimeDatabaseUrl, {
				requestedCaCertificateId: rotatedCaCertificateId,
				expectedCurrentCaCertificateId: hyperdriveCaCertificateId,
			});
			if ("error" in scenario) {
				await expect(operation, scenario.name).rejects.toThrow(scenario.error);
			} else {
				const plan = await operation;
				expect(plan.hyperdrive.caCertificateAction, scenario.name).toBe(
					scenario.action,
				);
			}
		}
	});

	test("requires explicit CA intent before a clean Hyperdrive create", async () => {
		const legacyConfig = structuredClone(config);
		delete legacyConfig.cloudflare.hyperdriveCaCertificateId;
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/hyperdrive/configs?")) return response([]);
				throw new Error(`Unexpected request after missing CA intent: ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = new CloudflareClient(
			"account-id",
			"cloudflare-token",
			"https://cloudflare.test/client/v4",
		);
		await expect(client.plan(legacyConfig, runtimeDatabaseUrl)).rejects.toThrow(
			"hyperdriveCaCertificateId is required",
		);
	});

	test("rejects pinned-name collisions, origin changes, and TLS downgrades", async () => {
		const scenarios = [
			{
				existing: hyperdrive(),
				listed: [{ ...hyperdrive(), id: "other-id" }],
				url: runtimeDatabaseUrl,
				error: "belongs to a different configuration",
			},
			{
				existing: hyperdrive({ host: "other-db.example.com" }),
				listed: [],
				url: runtimeDatabaseUrl,
				error: "different database origin",
			},
			{
				existing: hyperdrive({ sslmode: "verify-full" }),
				listed: [],
				url: "postgresql://runtime:super-secret@db.example.com/relay?sslmode=verify-ca",
				error: "cannot be downgraded",
			},
		] as const;

		for (const scenario of scenarios) {
			globalThis.fetch = Object.assign(
				mock(async (input: RequestInfo | URL) => {
					const url = String(input);
					if (url.endsWith("/hyperdrive/configs/hyperdrive-id")) {
						return response(scenario.existing);
					}
					if (url.includes("/hyperdrive/configs?")) {
						return response(scenario.listed);
					}
					throw new Error(`Unexpected request after unsafe plan: ${url}`);
				}),
				{ preconnect: originalFetch.preconnect },
			);
			const client = new CloudflareClient(
				"account-id",
				"cloudflare-token",
				"https://cloudflare.test/client/v4",
			);
			await expect(
				client.plan(provisionedConfig, scenario.url),
			).rejects.toThrow(scenario.error);
		}
	});

	test("rotates the exact pinned Hyperdrive CA and preserves connection settings", async () => {
		let activeCaCertificateId = hyperdriveCaCertificateId;
		let injectedCaCertificateIdBeforePatch: string | undefined;
		let raceExactGets = 0;
		const calls: Array<{
			url: string;
			method: string;
			body?: Record<string, unknown>;
		}> = [];
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				const body = init?.body
					? (JSON.parse(String(init.body)) as Record<string, unknown>)
					: undefined;
				calls.push({ url, method, ...(body ? { body } : {}) });
				const headers = new Headers(init?.headers);
				if (url.endsWith("/hyperdrive/configs/hyperdrive-id")) {
					if (method === "GET" && injectedCaCertificateIdBeforePatch) {
						raceExactGets++;
						if (raceExactGets === 2) {
							activeCaCertificateId = injectedCaCertificateIdBeforePatch;
						}
					}
					if (method === "PATCH") {
						activeCaCertificateId = String(
							(body?.mtls as Record<string, unknown>)?.ca_certificate_id,
						);
					}
					return response(
						hyperdrive({ caCertificateId: activeCaCertificateId }),
					);
				}
				if (url.includes("/hyperdrive/configs?")) {
					return response([
						hyperdrive({ caCertificateId: activeCaCertificateId }),
					]);
				}
				if (url.includes("/storage/kv/namespaces?")) {
					return response([{ id: "kv-id", title: RESOURCE_NAMES.kv }]);
				}
				if (url.includes("/r2/buckets?")) {
					return response({
						buckets:
							headers.get("cf-r2-jurisdiction") === "default"
								? Object.values(RESOURCE_NAMES.buckets).map((name) => ({
										name,
									}))
								: [],
					});
				}
				if (url.includes("/queues?")) {
					return response(
						QUEUE_NAMES.map((name) => ({
							queue_id: provisionedConfig.resources?.queues[name],
							queue_name: `relayapi-selfhost-${name}`,
							settings: {
								message_retention_period: QUEUE_MESSAGE_RETENTION_SECONDS,
							},
						})),
					);
				}
				if (method === "GET" && url.endsWith("/lifecycle")) {
					return response({ rules: [] });
				}
				if (method === "PUT" && url.endsWith("/lifecycle")) {
					return response({});
				}
				if (method === "PUT" && url.includes("/event_notifications/r2/")) {
					return response({});
				}
				if (method === "GET" && url.endsWith("/domains/custom")) {
					return response({
						domains: [
							{ domain: config.cloudflare.mediaHostname },
							{ domain: config.cloudflare.thumbnailHostname },
						],
					});
				}
				throw new Error(`Unhandled test request: ${method} ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = new CloudflareClient(
			"account-id",
			"cloudflare-token",
			"https://cloudflare.test/client/v4",
		);
		const rotationOptions = {
			requestedCaCertificateId: rotatedCaCertificateId,
		};
		const plan = await client.plan(
			provisionedConfig,
			runtimeDatabaseUrl,
			rotationOptions,
		);
		expect(plan.hyperdrive.caCertificateAction).toBe("rotate");
		expect(plan.hyperdrive.caCertificateId).toBe(rotatedCaCertificateId);
		expect(calls.some((call) => call.method === "PATCH")).toBe(false);
		await expect(
			client.apply(provisionedConfig, runtimeDatabaseUrl, rotationOptions),
		).resolves.toMatchObject({ hyperdriveId: "hyperdrive-id" });
		const patches = calls.filter(
			(call) =>
				call.method === "PATCH" &&
				call.url.endsWith("/hyperdrive/configs/hyperdrive-id"),
		);
		expect(patches).toHaveLength(1);
		expect(patches[0]?.body).toMatchObject({
			name: RESOURCE_NAMES.hyperdrive,
			origin: {
				host: "db.example.com",
				port: 5432,
				database: "relay",
				user: "runtime",
				password: "super-secret",
			},
			caching: { disabled: true },
			mtls: {
				sslmode: "verify-full",
				ca_certificate_id: rotatedCaCertificateId,
				mtls_certificate_id: "client-id",
			},
			origin_connection_limit: 37,
		});
		expect(calls.some((call) => call.url.includes("super-secret"))).toBe(false);
		const exactGets = calls.filter(
			(call) =>
				call.method === "GET" &&
				call.url.endsWith("/hyperdrive/configs/hyperdrive-id"),
		);
		expect(exactGets.length).toBeGreaterThanOrEqual(3);

		const recoveryPlan = await client.plan(
			provisionedConfig,
			runtimeDatabaseUrl,
			rotationOptions,
		);
		expect(recoveryPlan.hyperdrive.caCertificateAction).toBe("retain");
		expect(recoveryPlan.hyperdrive.currentCaCertificateId).toBe(
			rotatedCaCertificateId,
		);

		// Reconciliation persists the old CA as independent authority for apply.
		// If the outer plan saw the target but Cloudflare returns to that known old
		// CA before PATCH, the retry remains safe and converges back to the target.
		const configForApply = structuredClone(provisionedConfig);
		configForApply.cloudflare.hyperdriveCaCertificateId =
			rotatedCaCertificateId;
		activeCaCertificateId = rotatedCaCertificateId;
		raceExactGets = 0;
		injectedCaCertificateIdBeforePatch = hyperdriveCaCertificateId;
		await expect(
			client.apply(configForApply, runtimeDatabaseUrl, {
				...rotationOptions,
				expectedCurrentCaCertificateId: hyperdriveCaCertificateId,
			}),
		).resolves.toMatchObject({ hyperdriveId: "hyperdrive-id" });
		expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2);

		// A retry that observes the stored prior during planning and the requested
		// target immediately before PATCH is an authorized idempotent transition.
		activeCaCertificateId = hyperdriveCaCertificateId;
		raceExactGets = 0;
		injectedCaCertificateIdBeforePatch = rotatedCaCertificateId;
		await expect(
			client.apply(provisionedConfig, runtimeDatabaseUrl, rotationOptions),
		).resolves.toMatchObject({ hyperdriveId: "hyperdrive-id" });
		expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(3);

		// Any state outside the stored prior and explicit target is rejected by the
		// final read, before a mutating request can be sent.
		activeCaCertificateId = hyperdriveCaCertificateId;
		raceExactGets = 0;
		injectedCaCertificateIdBeforePatch = thirdCaCertificateId;
		await expect(
			client.apply(provisionedConfig, runtimeDatabaseUrl, rotationOptions),
		).rejects.toThrow("unexpected third state before PATCH");
		expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(3);
		injectedCaCertificateIdBeforePatch = undefined;

		await expect(
			client.plan(provisionedConfig, runtimeDatabaseUrl, rotationOptions),
		).rejects.toThrow("unexpected third state");
		await expect(
			client.plan(
				{
					...provisionedConfig,
					cloudflare: {
						...provisionedConfig.cloudflare,
						hyperdriveCaCertificateId: rotatedCaCertificateId,
					},
				},
				runtimeDatabaseUrl,
				{
					...rotationOptions,
					expectedCurrentCaCertificateId: hyperdriveCaCertificateId,
				},
			),
		).rejects.toThrow("unexpected third state");
	});
});
