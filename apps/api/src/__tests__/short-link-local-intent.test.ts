import { describe, expect, it } from "bun:test";
import {
	type Database,
	externalSubjectCleanupJobs,
	shortLinkConfigs,
	shortLinkCredentials,
	shortLinks,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	createTrackedExternalShortLink,
	TrackedShortLinkCreationError,
} from "../services/short-link-lifecycle";
import type { ShortLinkProvider } from "../services/short-link-providers";

function lifecycleDb(options?: { failActivation?: boolean }): {
	db: Database;
	operations: string[];
	inserted: Record<string, unknown>[];
	updates: Record<string, unknown>[];
	cleanupUpdates: Record<string, unknown>[];
} {
	const operations: string[] = [];
	const inserted: Record<string, unknown>[] = [];
	const updates: Record<string, unknown>[] = [];
	const cleanupUpdates: Record<string, unknown>[] = [];
	let updateCount = 0;
	const db = {
		insert: () => ({
			values: async (value: Record<string, unknown>) => {
				operations.push("db:insert-pending");
				inserted.push(value);
			},
		}),
		update: (table: unknown) => ({
			set: (value: Record<string, unknown>) => {
				updateCount += 1;
				updates.push(value);
				if (table === externalSubjectCleanupJobs) {
					cleanupUpdates.push(value);
				}
				const whereResult = {
					returning: async () => {
						if (options?.failActivation && updateCount === 1) {
							throw new Error("injected activation failure");
						}
						operations.push("db:activate");
						return [
							{
								...inserted[0],
								...value,
								createdAt: new Date(),
								clickCount: 0,
								nextClickSyncAt: new Date(),
								clickSyncGeneration: 0,
								clickSyncLeaseExpiresAt: null,
								clickSyncStartedAt: null,
								clickSyncAttempts: 0,
								clickSyncLastError: null,
								clickSyncLastErrorClass: null,
								lastClickSyncAt: null,
								scopeKey: "__organization__",
							},
						];
					},
				};
				return {
					where: () => {
						if (value.creationStatus === "manual_review") {
							operations.push("db:manual-review");
						}
						return whereResult;
					},
				};
			},
		}),
	} as unknown as Database;
	return { db, operations, inserted, updates, cleanupUpdates };
}

function provider(operations: string[]): ShortLinkProvider {
	return {
		providerType: "dub",
		shortLinkDomain: "dub.sh",
		async shorten(_apiKey, _domain, _url, intentId) {
			operations.push(`provider:create:${intentId}`);
			return {
				shortUrl: "https://dub.sh/abc",
				providerRef: {
					provider: "dub",
					externalId: intentId,
					linkId: "dub_1",
				},
			};
		},
		async probeCredential() {},
		async deleteLink() {
			return { kind: "deleted" };
		},
		async getClickCount() {
			return 0;
		},
		async getClickCounts() {
			return new Map();
		},
	};
}

describe("external short-link local intent", () => {
	it("commits pending state before provider egress and activates under the same fence", async () => {
		const fixture = lifecycleDb();
		const row = await createTrackedExternalShortLink({
			db: fixture.db,
			organizationId: "org_1",
			workspaceId: null,
			originalUrl: "https://example.com",
			providerType: "dub",
			providerConfigVersion: 4,
			credentialVersion: 3,
			domain: null,
			apiKey: "secret",
			provider: provider(fixture.operations),
		});

		expect(fixture.operations[0]).toBe("db:insert-pending");
		expect(fixture.operations[1]).toStartWith("provider:create:sl_");
		expect(fixture.operations[2]).toBe("db:activate");
		expect(row.creationStatus).toBe("active");
		expect(row.providerConfigVersion).toBe(4);
		expect(row.credentialVersion).toBe(3);
	});

	it("keeps the durable intent and enters manual review after a post-provider failure", async () => {
		const fixture = lifecycleDb({ failActivation: true });
		await expect(
			createTrackedExternalShortLink({
				db: fixture.db,
				organizationId: "org_1",
				workspaceId: "ws_1",
				originalUrl: "https://example.com",
				providerType: "dub",
				providerConfigVersion: 1,
				credentialVersion: 1,
				domain: null,
				apiKey: "secret",
				provider: provider(fixture.operations),
			}),
		).rejects.toBeInstanceOf(TrackedShortLinkCreationError);

		expect(fixture.inserted).toHaveLength(1);
		expect(
			fixture.operations.filter((operation) =>
				operation.startsWith("provider:create:"),
			),
		).toHaveLength(1);
		expect(fixture.operations).toContain("db:manual-review");
		expect(
			fixture.updates.find(
				(update) => update.creationStatus === "manual_review",
			),
		).toMatchObject({
			creationStatus: "manual_review",
			providerRef: {
				provider: "dub",
				linkId: "dub_1",
			},
			shortCode: "abc",
			shortUrl: "https://dub.sh/abc",
		});
		expect(fixture.cleanupUpdates).toContainEqual(
			expect.objectContaining({
				providerRef: expect.objectContaining({
					provider: "dub",
					externalId: expect.stringMatching(/^sl_/),
					linkId: "dub_1",
				}),
			}),
		);
	});

	it("retains provider identity before rejecting a malformed post-provider URL", async () => {
		const fixture = lifecycleDb();
		const malformedProvider = provider(fixture.operations);
		malformedProvider.shorten = async (_apiKey, _domain, _url, intentId) => {
			fixture.operations.push(`provider:create:${intentId}`);
			return {
				shortUrl: "file:///not-a-short-link",
				providerRef: {
					provider: "dub",
					externalId: intentId,
					linkId: "dub_malformed_1",
				},
			};
		};

		await expect(
			createTrackedExternalShortLink({
				db: fixture.db,
				organizationId: "org_1",
				workspaceId: null,
				originalUrl: "https://example.com",
				providerType: "dub",
				providerConfigVersion: 1,
				credentialVersion: 1,
				domain: null,
				apiKey: "secret",
				provider: malformedProvider,
			}),
		).rejects.toBeInstanceOf(TrackedShortLinkCreationError);

		expect(
			fixture.updates.find(
				(update) => update.creationStatus === "manual_review",
			),
		).toMatchObject({
			providerRef: {
				provider: "dub",
				linkId: "dub_malformed_1",
			},
		});
		const manualReview = fixture.updates.find(
			(update) => update.creationStatus === "manual_review",
		);
		expect(manualReview?.shortCode).toBeUndefined();
		expect(manualReview?.shortUrl).toBeUndefined();
		expect(fixture.cleanupUpdates.at(-1)).toMatchObject({
			providerRef: {
				provider: "dub",
				linkId: "dub_malformed_1",
			},
		});
	});

	it("polls with each link's pinned historical credential instead of current config", async () => {
		const source = await Bun.file(
			new URL("../services/short-link-click-sync.ts", import.meta.url),
		).text();
		expect(source).toContain("credentialVersion: link.credentialVersion");
		expect(source).toContain("resolveExternalShortLinkProvider");
		expect(source).not.toContain("JOIN short_link_configs");
		expect(source).not.toContain("current provider configuration");
	});

	it("pins provider/config/credential identity in DDL and never overwrites credential ciphertext", async () => {
		const configColumns = getTableConfig(shortLinkConfigs).columns.map(
			(column) => column.name,
		);
		expect(configColumns).toContain("provider_config_version");
		expect(configColumns).toContain("credential_version");
		expect(configColumns).not.toContain("api_key");

		const credentialConfig = getTableConfig(shortLinkCredentials);
		expect(credentialConfig.columns.map((column) => column.name)).toContain(
			"api_key_ciphertext",
		);
		expect(
			credentialConfig.indexes.find(
				(index) =>
					index.config.name === "short_link_credentials_org_active_uniq",
			)?.config.where,
		).toBeDefined();

		const linkColumns = getTableConfig(shortLinks).columns.map(
			(column) => column.name,
		);
		expect(linkColumns).toEqual(
			expect.arrayContaining([
				"provider_config_version",
				"credential_version",
				"provider_ref",
				"creation_status",
				"creation_fence",
			]),
		);

		const source = await Bun.file(
			new URL("../services/short-link-configuration.ts", import.meta.url),
		).text();
		expect(source).toContain("pg_advisory_xact_lock");
		expect(source).toContain('state: "retired"');
		expect(source).toContain("apiKeyCiphertext: input.encryptedApiKey");
		expect(source).not.toContain("set({ apiKeyCiphertext");
		expect(source).toContain("pruneOrphanedShortLinkCredentials");
		expect(source).toContain("credential.state = 'retired'");
		expect(source).toContain("NOT EXISTS");
	});

	it("probes a replacement credential before activating its immutable version", async () => {
		const routeSource = await Bun.file(
			new URL("../routes/short-links.ts", import.meta.url),
		).text();
		const probeAt = routeSource.indexOf(
			"await provider.probeCredential(body.api_key)",
		);
		const activateAt = routeSource.indexOf(
			"updateVersionedShortLinkConfigInTransaction(tx, orgId",
		);
		expect(probeAt).toBeGreaterThan(-1);
		expect(activateAt).toBeGreaterThan(probeAt);
		expect(routeSource).toContain(
			"A failed probe leaves the prior immutable version active",
		);
	});

	it("locks erasure candidates so creation and cleanup cannot observe different identities", async () => {
		const [tenantSource, workspaceSource] = await Promise.all([
			Bun.file(
				new URL("../services/tenant-deletion.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL("../services/workspace-erasure.ts", import.meta.url),
			).text(),
		]);
		for (const source of [tenantSource, workspaceSource]) {
			const shortLinkSlice = source.slice(
				source.indexOf("credentialCiphertext: shortLinkCredentials"),
				source.indexOf(
					"enqueueShortLinkProviderCleanup",
					source.indexOf("credentialCiphertext: shortLinkCredentials"),
				),
			);
			expect(shortLinkSlice).toContain('.for("update", { of: shortLinks })');
		}
	});
});
