import { beforeEach, describe, expect, it, mock } from "bun:test";

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
	},
	socialAccounts: {
		id: {},
		organizationId: {},
	},
}));

const { recordQueueFailureRecord } = await import("../queues/failures");

import type { Env } from "../types";

beforeEach(() => {
	state.activeOrganizationIds = [];
	state.inserts = [];
});

describe("queue failure tenant lifecycle", () => {
	it("does not recreate deleted-tenant payloads as unscoped failures", async () => {
		await recordQueueFailureRecord(
			{ HYPERDRIVE: { connectionString: "postgres://unused" } } as Env,
			{
				queueName: "relayapi-publish",
				messageId: "msg_deleted",
				attempts: 3,
				payload: { organization_id: "org_deleted", post_id: "post_1" },
				kind: "dead_letter",
				error: "failed",
			},
		);

		expect(state.inserts).toHaveLength(0);
	});

	it("retains a scoped failure while its organization is active", async () => {
		state.activeOrganizationIds = ["org_active"];
		await recordQueueFailureRecord(
			{ HYPERDRIVE: { connectionString: "postgres://unused" } } as Env,
			{
				queueName: "relayapi-publish",
				messageId: "msg_active",
				attempts: 3,
				payload: { organization_id: "org_active", post_id: "post_1" },
				kind: "dead_letter",
				error: "failed",
			},
		);

		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0]?.organizationIds).toEqual(["org_active"]);
	});

	it("redacts a mixed payload when only part of its tenant scope is active", async () => {
		state.activeOrganizationIds = ["org_active"];
		await recordQueueFailureRecord(
			{ HYPERDRIVE: { connectionString: "postgres://unused" } } as Env,
			{
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
			},
		);

		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0]?.organizationIds).toEqual(["org_active"]);
		expect(state.inserts[0]?.payload).toEqual({
			redacted: true,
			reason: "inactive_tenant_scope_removed",
			active_organization_ids: ["org_active"],
			operation_id: "receipt_1",
		});
	});
});
