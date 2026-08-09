import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";

const state = {
	activeOrganizationIds: [] as string[],
	inserts: [] as Array<Record<string, unknown>>,
};

mock.module("@relayapi/db", () => ({
	createDb: () => ({
		transaction: async (callback: (tx: unknown) => Promise<void>) =>
			callback({
				select: () => ({
					from: () => ({
						where: () => ({
							for: async () =>
								state.activeOrganizationIds.map((id) => ({ id })),
							limit: async () => [],
						}),
					}),
				}),
				insert: () => ({
					values: (values: Record<string, unknown>) => ({
						onConflictDoUpdate: async () => {
							state.inserts.push(values);
						},
					}),
				}),
			}),
	}),
	inboundWebhookEvents: {
		id: {},
		organizationIds: {},
	},
	organization: {
		id: {},
		lifecycleStatus: {},
	},
	queueFailures: {
		queueName: {},
		messageId: {},
		attempts: {},
		organizationIds: {},
		workspaceIds: {},
		userIds: {},
		contactIds: {},
		accountIds: {},
		payloadCiphertext: {},
		payloadKeyId: {},
		payloadExpiresAt: {},
	},
	socialAccounts: {
		id: {},
		organizationId: {},
	},
}));

const { decryptQueueFailurePayload, recordQueueFailureRecord } = await import(
	"../queues/failures"
);

import type { Env } from "../types";

const ENCRYPTION_KEY = `active=${"11".repeat(32)}`;

function env(): Env {
	return {
		HYPERDRIVE: { connectionString: "postgres://unused" },
		ENCRYPTION_KEY,
	} as Env;
}

beforeEach(() => {
	state.activeOrganizationIds = [];
	state.inserts = [];
});

describe("queue failure tenant lifecycle", () => {
	it("does not recreate deleted-tenant payloads as unscoped failures", async () => {
		await recordQueueFailureRecord(env(), {
			queueName: "relayapi-publish",
			messageId: "msg_deleted",
			attempts: 3,
			payload: { organization_id: "org_deleted", post_id: "post_1" },
			kind: "dead_letter",
			error: "failed",
		});

		expect(state.inserts).toHaveLength(0);
	});

	it("retains a scoped failure while its organization is active", async () => {
		state.activeOrganizationIds = ["org_active"];
		await recordQueueFailureRecord(env(), {
			queueName: "relayapi-publish",
			messageId: "msg_active",
			attempts: 3,
			payload: { organization_id: "org_active", post_id: "post_1" },
			kind: "dead_letter",
			error: "failed",
		});

		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0]?.organizationIds).toEqual(["org_active"]);
		expect(String(state.inserts[0]?.payloadCiphertext)).toStartWith(
			"enc:v2:active:",
		);
		expect(String(state.inserts[0]?.payloadCiphertext)).not.toContain("post_1");
		expect(state.inserts[0]?.payloadKeyId).toBe("active");
	});

	it("derives self-host media tenant scope from the object key", async () => {
		state.activeOrganizationIds = ["org_media"];
		await recordQueueFailureRecord(env(), {
			queueName: "relayapi-selfhost-media-cleanup-dlq",
			messageId: "msg_media",
			attempts: 3,
			payload: {
				account: "cf-account",
				bucket: "relayapi-selfhost-media",
				action: "PutObject",
				object: { key: "org_media/uploads/photo.jpg" },
			},
			kind: "dead_letter",
			error: "failed",
		});

		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0]?.organizationIds).toEqual(["org_media"]);
	});

	it("redacts a mixed payload when only part of its tenant scope is active", async () => {
		state.activeOrganizationIds = ["org_active"];
		await recordQueueFailureRecord(env(), {
			queueName: "relayapi-inbox",
			messageId: "msg_mixed",
			attempts: 3,
			organizationIds: ["org_active", "org_deleted"],
			payload: {
				organization_ids: ["org_active", "org_deleted"],
				receipt_id: "receipt_1",
				private_body: "must not survive partial tenant deletion",
			},
			kind: "dead_letter",
			error: "failed",
		});

		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0]?.organizationIds).toEqual(["org_active"]);
		expect(String(state.inserts[0]?.payloadCiphertext)).not.toContain(
			"must not survive partial tenant deletion",
		);
		await expect(
			decryptQueueFailurePayload(env(), {
				queueName: "relayapi-inbox",
				messageId: "msg_mixed",
				payloadCiphertext: String(state.inserts[0]?.payloadCiphertext),
			}),
		).resolves.toEqual({
			redacted: true,
			reason: "inactive_tenant_scope_removed",
			active_organization_ids: ["org_active"],
			operation_id: "receipt_1",
		});
	});

	it("has typed subject locators and hard payload/receipt clocks", () => {
		const schema = readFileSync(
			new URL("../../../../packages/db/src/schema.ts", import.meta.url),
			"utf8",
		);
		const start = schema.indexOf("export const queueFailures");
		const end = schema.indexOf("export const emailDeliveries", start);
		const table = schema.slice(start, end);
		for (const marker of [
			'workspaceIds: text("workspace_ids")',
			'userIds: text("user_ids")',
			'contactIds: text("contact_ids")',
			'accountIds: text("account_ids")',
			'payloadCiphertext: text("payload_ciphertext")',
			"now() + interval '30 days'",
			"now() + interval '90 days'",
		]) {
			expect(table).toContain(marker);
		}
		expect(table).not.toContain('payload: jsonb("payload")');
	});

	it("redacts and drains in bounded pages without allowing redelivery to renew privacy clocks", () => {
		const retention = readFileSync(
			new URL("../services/operational-retention.ts", import.meta.url),
			"utf8",
		);
		const implementation = retention.slice(
			retention.indexOf("export async function retainQueueFailures"),
			retention.indexOf("/**", retention.indexOf("retainQueueFailures") + 10),
		);
		expect(implementation).toContain("QUEUE_FAILURE_RETENTION_MAX_PASSES");
		expect(implementation).toContain(".limit(QUEUE_FAILURE_RETENTION_BATCH)");
		expect(implementation).toContain("hold.released_at IS NULL");

		const writer = readFileSync(
			new URL("../queues/failures.ts", import.meta.url),
			"utf8",
		);
		expect(writer).toContain(
			`LEAST(\${queueFailures.payloadExpiresAt}, excluded.payload_expires_at)`,
		);
		expect(writer).toContain(
			`WHEN \${queueFailures.payloadRedactedAt} IS NOT NULL`,
		);
	});
});
