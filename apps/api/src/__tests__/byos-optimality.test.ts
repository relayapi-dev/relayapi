import { describe, expect, it } from "bun:test";
import { media, storageCredentials, storageLocations } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	buildByosBucketUrl,
	buildByosObjectUrl,
	PINNED_BYOS_CREDENTIAL_STATES,
	storageLocatorForMedia,
} from "../services/storage-locator";

const config = {
	endpoint: "https://objects.example.test/base",
	bucket: "tenant-media",
	keyPrefix: "relayapi",
	forcePathStyle: false,
};

describe("BYOS optimal storage boundary", () => {
	it("pins an exact tenant-safe location and credential version on every BYOS media row", () => {
		expect(media.storageProvider).toBeDefined();
		expect(media.storageBucketLocator).toBeDefined();
		expect(media.storageRegion).toBeDefined();
		expect(media.storageLocationId).toBeDefined();
		expect(media.storageCredentialVersion).toBeDefined();
		expect(media.storageKey).toBeDefined();
		const config = getTableConfig(media);
		expect(
			config.foreignKeys.map((foreignKey) => foreignKey.getName()),
		).toEqual(
			expect.arrayContaining([
				"media_storage_location_org_locator_fk",
				"media_storage_credential_org_version_fk",
			]),
		);
		expect(
			config.indexes.some(
				(index) => index.config.name === "media_storage_key_uniq",
			),
		).toBe(true);
		expect(getTableConfig(storageLocations).uniqueConstraints).toHaveLength(2);
		expect(
			getTableConfig(storageCredentials).uniqueConstraints.some(
				(constraint) =>
					constraint.name ===
					"storage_credentials_location_org_version_uniq",
			),
		).toBe(true);

		expect(
			storageLocatorForMedia({
				organizationId: "org_1",
				storageProvider: "byos",
				storageBucketLocator: "tenant-media",
				storageRegion: "eu-west-1",
				storageLocationId: "sloc_1",
				storageCredentialVersion: 4,
				storageKey: "org_1/file.jpg",
			}),
		).toEqual({
			provider: "byos",
			organizationId: "org_1",
			locationId: "sloc_1",
			credentialVersion: 4,
			bucket: "tenant-media",
			region: "eu-west-1",
			key: "org_1/file.jpg",
		});
		expect(() =>
			storageLocatorForMedia({
				organizationId: "org_1",
				storageProvider: "byos",
				storageBucketLocator: "tenant-media",
				storageRegion: "eu-west-1",
				storageLocationId: null,
				storageCredentialVersion: null,
				storageKey: "org_1/file.jpg",
			}),
		).toThrow("missing its location or credential version");
	});

	it("builds virtual-hosted and path-style S3 URLs without losing endpoint paths", () => {
		expect(
			buildByosObjectUrl(config, "org_1/media/file 1.jpg").toString(),
		).toBe(
			"https://tenant-media.objects.example.test/base/relayapi/org_1/media/file%201.jpg",
		);
		expect(buildByosBucketUrl(config).toString()).toBe(
			"https://tenant-media.objects.example.test/base",
		);

		const pathStyle = { ...config, forcePathStyle: true };
		expect(
			buildByosObjectUrl(pathStyle, "org_1/media/file.jpg").toString(),
		).toBe(
			"https://objects.example.test/base/tenant-media/relayapi/org_1/media/file.jpg",
		);
		expect(buildByosBucketUrl(pathStyle).toString()).toBe(
			"https://objects.example.test/base/tenant-media",
		);
	});

	it("routes every media lifecycle boundary through the shared locator", async () => {
		const [
			mediaRoute,
			presigning,
			reliability,
			workspaceErasure,
			tenantErasure,
			byosRoute,
		] = await Promise.all([
			Bun.file("src/routes/media.ts").text(),
			Bun.file("src/lib/r2-presign.ts").text(),
			Bun.file("src/services/media-reliability.ts").text(),
			Bun.file("src/services/workspace-erasure.ts").text(),
			Bun.file("src/services/tenant-deletion.ts").text(),
			Bun.file("src/routes/byos.ts").text(),
		]);

		expect(mediaRoute).toContain("preferredMediaStorageTarget");
		expect(mediaRoute).toContain("storageBucketLocator: storageTarget.bucket");
		expect(mediaRoute).toContain("storageRegion: storageTarget.region");
		expect(mediaRoute).toContain(
			"storageLocationId: storageTarget.locationId",
		);
		expect(mediaRoute).toContain(
			"storageCredentialVersion: storageTarget.credentialVersion",
		);
		expect(mediaRoute).toContain("putStoredObject");
		expect(mediaRoute).toContain("headStoredObject");
		expect(mediaRoute).toContain("presignStoredObject");
		expect(presigning).toContain("headStoredObject");
		expect(presigning).toContain("presignStoredObject");
		expect(reliability).toContain("deleteStoredObject");
		expect(reliability).toContain("getStoredObject");
		expect(workspaceErasure).toContain("deleteStoredObject");
		expect(tenantErasure).toContain("deleteByosPrefixPage");
		expect(byosRoute).not.toContain("secret_access_key: row.");
		expect(byosRoute).toContain("credentials_present");
		expect(byosRoute).toContain("BYOS_OBJECTS_EXIST");
	});

	it("keeps retired authorities readable while excluding staged and failed versions", () => {
		expect(PINNED_BYOS_CREDENTIAL_STATES).toEqual(["active", "retired"]);
	});

	it("serializes concurrent stages and activates only the exact fenced probe", async () => {
		const lifecycle = await Bun.file(
			"src/services/byos-configuration.ts",
		).text();
		expect(lifecycle).toContain("pg_advisory_xact_lock");
		expect(lifecycle).toContain('eq(storageCredentials.state, "staged")');
		expect(lifecycle).toContain(
			"eq(storageCredentials.probeToken, claim.probeToken)",
		);
		expect(lifecycle).toContain("if (!active) throw new ByosActivationConflictError()");
		expect(lifecycle).toContain(
			"if (!activatedLocation) throw new ByosActivationConflictError()",
		);
	});

	it("fails a bad rotation without retiring the prior active authority", async () => {
		const lifecycle = await Bun.file(
			"src/services/byos-configuration.ts",
		).text();
		const failureStart = lifecycle.indexOf("async function failStagedCredential");
		const activationStart = lifecycle.indexOf(
			"async function activateStagedCredential",
		);
		const failurePath = lifecycle.slice(failureStart, activationStart);
		expect(failurePath).toContain('state: "failed"');
		expect(failurePath).not.toContain('state: "retired"');
		expect(failurePath).not.toContain('eq(storageCredentials.state, "active")');
		expect(lifecycle.slice(activationStart)).toContain('state: "retired"');
	});

	it("inserts location changes and tenant cleanup walks exact historical credentials", async () => {
		const [lifecycle, tenantErasure, locator] = await Promise.all([
			Bun.file("src/services/byos-configuration.ts").text(),
			Bun.file("src/services/tenant-deletion.ts").text(),
			Bun.file("src/services/storage-locator.ts").text(),
		]);
		expect(lifecycle).toContain(".insert(storageLocations)");
		expect(lifecycle).toContain("oldActive.locationId !== candidate.locationId");
		expect(tenantErasure).toContain("nextByosCleanupLocator");
		expect(tenantErasure).toContain("byos_credential_version");
		expect(locator).toContain("CLEANUP_BYOS_CREDENTIAL_STATES");
		expect(locator).toContain('"failed"');
	});
});
