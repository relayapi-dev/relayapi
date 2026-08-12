import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createDb, emailDeliveries, eq, generateId, user } from "@relayapi/db";
import { deleteUserAtomically } from "../../../app/src/lib/user-deletion";
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

const deletionDependencies = {
	kv: { delete: async (_key: string) => undefined },
	avatars: {
		list: async () => ({ objects: [], truncated: false }),
		delete: async (_keys: string | string[]) => undefined,
	},
	queueRescue: {
		list: async () => ({ objects: [], truncated: false }),
		delete: async (_keys: string | string[]) => undefined,
	},
};

beforeAll(async () => {
	if (!CONNECTION_STRING) return;
	await insertOwnedFixtureOrganization(db, {
		id: organizationId,
		name: "Email ownership fixture",
		slug: `email-owner-${organizationId.slice(-8)}`,
	});
	dbAvailable = true;
});

afterAll(async () => {
	if (!dbAvailable) return;
	await db
		.delete(emailDeliveries)
		.where(eq(emailDeliveries.organizationId, organizationId));
	await deleteOwnedFixtureOrganization(db, organizationId);
});

describe("email delivery ownership and erasure", () => {
	databaseIt(
		"cascades an auth-user-owned email intent when that identity is deleted",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");

			const authUserId = generateId("usr_");
			const deliveryId = generateId("email_");
			await db.insert(user).values({
				id: authUserId,
				name: "Email fixture identity",
				email: `${authUserId}@fixtures.relayapi.test`,
				emailVerified: true,
			});
			await db.insert(emailDeliveries).values({
				id: deliveryId,
				intent: "auth_user",
				authUserId,
				subjectUserId: authUserId,
				envelopeCiphertext: "enc:v2:email-fixture",
				envelopeKeyId: "email-fixture-key",
			});

			await deleteUserAtomically(
				db,
				deletionDependencies.kv,
				deletionDependencies.avatars,
				deletionDependencies.queueRescue,
				authUserId,
			);

			const [deliveryRows, identityRows] = await Promise.all([
				db
					.select({ id: emailDeliveries.id })
					.from(emailDeliveries)
					.where(eq(emailDeliveries.id, deliveryId)),
				db.select({ id: user.id }).from(user).where(eq(user.id, authUserId)),
			]);
			expect(deliveryRows).toEqual([]);
			expect(identityRows).toEqual([]);
		},
	);

	databaseIt(
		"deletes through the application behavior and minimizes an organization receipt",
		async () => {
			if (!dbAvailable)
				throw new Error("Database fixture setup did not complete");

			const subjectUserId = generateId("usr_");
			const deliveryId = generateId("email_");
			await db.insert(user).values({
				id: subjectUserId,
				name: "Email fixture subject",
				email: `${subjectUserId}@fixtures.relayapi.test`,
				emailVerified: true,
			});
			await db.insert(emailDeliveries).values({
				id: deliveryId,
				intent: "organization",
				organizationId,
				subjectUserId,
				envelopeCiphertext: "enc:v2:email-fixture",
				envelopeKeyId: "email-fixture-key",
				leaseExpiresAt: new Date(Date.now() + 60_000),
				dispatchLeaseExpiresAt: new Date(Date.now() + 60_000),
			});

			await deleteUserAtomically(
				db,
				deletionDependencies.kv,
				deletionDependencies.avatars,
				deletionDependencies.queueRescue,
				subjectUserId,
			);

			const [[delivery], identityRows] = await Promise.all([
				db
					.select({
						organizationId: emailDeliveries.organizationId,
						subjectUserId: emailDeliveries.subjectUserId,
						envelopeCiphertext: emailDeliveries.envelopeCiphertext,
						envelopeKeyId: emailDeliveries.envelopeKeyId,
						status: emailDeliveries.status,
						leaseExpiresAt: emailDeliveries.leaseExpiresAt,
						dispatchLeaseExpiresAt: emailDeliveries.dispatchLeaseExpiresAt,
						error: emailDeliveries.error,
						completedAt: emailDeliveries.completedAt,
						redactedAt: emailDeliveries.redactedAt,
					})
					.from(emailDeliveries)
					.where(eq(emailDeliveries.id, deliveryId)),
				db.select({ id: user.id }).from(user).where(eq(user.id, subjectUserId)),
			]);
			expect(delivery).toEqual({
				organizationId,
				subjectUserId: null,
				envelopeCiphertext: null,
				envelopeKeyId: null,
				status: "failed",
				leaseExpiresAt: null,
				dispatchLeaseExpiresAt: null,
				error: "recipient_identity_erased",
				completedAt: expect.any(Date),
				redactedAt: expect.any(Date),
			});
			expect(identityRows).toEqual([]);

			await db
				.delete(emailDeliveries)
				.where(eq(emailDeliveries.id, deliveryId));
		},
	);
});
