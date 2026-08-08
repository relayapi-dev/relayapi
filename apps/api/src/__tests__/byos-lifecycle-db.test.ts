import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	createDb,
	eq,
	generateId,
	storageCredentials,
	storageLocations,
} from "@relayapi/db";
import {
	stageByosConfiguration,
	testAndActivateStagedByosConfiguration,
} from "../services/byos-configuration";
import { nextByosCleanupLocator } from "../services/storage-locator";
import type { Env } from "../types";
import {
	deleteOwnedFixtureOrganization,
	insertOwnedFixtureOrganization,
} from "./helpers/owned-organization-fixture";

const CONNECTION_STRING =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
const REQUIRE_DB_FIXTURES = process.env.RELAYAPI_REQUIRE_DB_FIXTURES === "1";

if (REQUIRE_DB_FIXTURES && !CONNECTION_STRING) {
	throw new Error(
		"RELAYAPI_REQUIRE_DB_FIXTURES=1 requires a PostgreSQL URL in HYPERDRIVE_LOCAL_CONNECTION_STRING or CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
	);
}

const db = CONNECTION_STRING
	? createDb(CONNECTION_STRING)
	: (null as unknown as ReturnType<typeof createDb>);
const databaseIt = CONNECTION_STRING ? it : it.skip;
const organizationId = generateId("org_");
let dbAvailable = false;

beforeAll(async () => {
	if (!CONNECTION_STRING) return;
	await insertOwnedFixtureOrganization(db, {
		id: organizationId,
		name: "BYOS lifecycle fixture",
		slug: `byos-lifecycle-${organizationId.slice(-8)}`,
	});
	dbAvailable = true;
});

afterEach(async () => {
	if (!dbAvailable) return;
	await db
		.delete(storageCredentials)
		.where(eq(storageCredentials.organizationId, organizationId));
	await db
		.delete(storageLocations)
		.where(eq(storageLocations.organizationId, organizationId));
});

afterAll(async () => {
	if (!dbAvailable) return;
	await deleteOwnedFixtureOrganization(db, organizationId);
});

function stageInput(suffix: string) {
	return {
		organizationId,
		endpoint: "https://objects.example.test",
		bucket: "relayapi-fixture",
		region: "eu-west-1",
		keyPrefix: "relayapi",
		forcePathStyle: false,
		encryptedAccessKeyId: `enc:v2:access-${suffix}`,
		encryptedSecretAccessKey: `enc:v2:secret-${suffix}`,
	};
}

describe("BYOS lifecycle database behavior", () => {
	databaseIt(
		"serializes concurrent stages and leaves exactly one fenced candidate",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");

			await Promise.all([
				stageByosConfiguration(db, stageInput("a")),
				stageByosConfiguration(db, stageInput("b")),
			]);

			const rows = await db
				.select({
					version: storageCredentials.version,
					state: storageCredentials.state,
					lastErrorCode: storageCredentials.lastErrorCode,
				})
				.from(storageCredentials)
				.where(eq(storageCredentials.organizationId, organizationId));
			expect(rows).toHaveLength(2);
			expect(rows.filter((row) => row.state === "staged")).toHaveLength(1);
			expect(rows.filter((row) => row.state === "failed")).toEqual([
				expect.objectContaining({ lastErrorCode: "superseded" }),
			]);
			expect(rows.map((row) => row.version).sort((a, b) => a - b)).toEqual([
				1, 2,
			]);
		},
	);

	databaseIt(
		"fails a bad rotation without retiring the active authority",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");
			const now = new Date();
			const activeLocationId = generateId("sloc_");
			await db.insert(storageLocations).values({
				id: activeLocationId,
				organizationId,
				endpoint: "https://active.example.test",
				bucket: "active-bucket",
				region: "eu-west-1",
				keyPrefix: "relayapi",
				forcePathStyle: false,
				activatedAt: now,
			});
			await db.insert(storageCredentials).values({
				id: generateId("scred_"),
				locationId: activeLocationId,
				organizationId,
				version: 1,
				accessKeyId: "enc:v2:active-access",
				secretAccessKey: "enc:v2:active-secret",
				state: "active",
				lastTestedAt: now,
				activatedAt: now,
			});
			await stageByosConfiguration(db, {
				...stageInput("rotation"),
				endpoint: "https://replacement.example.test",
				bucket: "replacement-bucket",
			});

			const result = await testAndActivateStagedByosConfiguration(
				db,
				{} as Env,
				organizationId,
				() => "probe_failed",
				now,
			);
			expect(result.credential.state).toBe("failed");

			const credentials = await db
				.select({
					locationId: storageCredentials.locationId,
					version: storageCredentials.version,
					state: storageCredentials.state,
					lastErrorCode: storageCredentials.lastErrorCode,
				})
				.from(storageCredentials)
				.where(eq(storageCredentials.organizationId, organizationId));
			expect(credentials).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						locationId: activeLocationId,
						version: 1,
						state: "active",
						lastErrorCode: null,
					}),
					expect.objectContaining({
						state: "failed",
						lastErrorCode: "probe_failed",
					}),
				]),
			);
			const [activeLocation] = await db
				.select({ retiredAt: storageLocations.retiredAt })
				.from(storageLocations)
				.where(eq(storageLocations.id, activeLocationId));
			expect(activeLocation?.retiredAt).toBeNull();

			const cleanupLocators = [];
			let cursor: { locationId: string; credentialVersion: number } | undefined;
			for (;;) {
				const locator = await nextByosCleanupLocator(
					db,
					organizationId,
					cursor,
				);
				if (!locator) break;
				cleanupLocators.push(locator);
				cursor = {
					locationId: locator.locationId,
					credentialVersion: locator.credentialVersion,
				};
			}
			expect(cleanupLocators).toHaveLength(2);
			expect(cleanupLocators).toEqual(
				expect.arrayContaining(
					credentials.map((credential) =>
						expect.objectContaining({
							locationId: credential.locationId,
							credentialVersion: credential.version,
						}),
					),
				),
			);
		},
	);
});
