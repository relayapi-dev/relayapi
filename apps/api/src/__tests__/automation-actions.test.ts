// apps/api/src/__tests__/automation-actions.test.ts
//
// Integration tests for the action dispatcher hitting a real PostgreSQL
// database. Requires the SSH tunnel to localhost:5433 (see .vscode/tasks.json).
// On CI or when the tunnel is down, the tests skip rather than fail.
//
// We test the two most-exercised actions — tag_add (array column mutation)
// and field_set (custom field upsert) — and let the unit-level action_group
// test cover dispatcher shape.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	contacts,
	createDb,
	customFieldDefinitions,
	customFieldValues,
	generateId,
	organization,
	workspaces,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { dispatchAction } from "../services/automations/actions";
import type { RunContext } from "../services/automations/types";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
	"postgres://relayapi:z9scNsSByxEn8QC6Z6PDQLLSKLum3F@localhost:5433/relayapi?sslmode=disable";

const db = createDb(CONN);

let dbAvailable = false;
let orgId = "";
let workspaceId = "";

async function seedFixtureOrg() {
	orgId = generateId("org_");
	await db.insert(organization).values({
		id: orgId,
		name: "actions-test-org",
		slug: `actions-test-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({
			organizationId: orgId,
			name: "actions-test-ws",
		})
		.returning();
	if (!ws) throw new Error("workspace insert failed");
	workspaceId = ws.id;
}

async function teardownFixtureOrg() {
	if (!orgId) return;
	await db
		.delete(customFieldValues)
		.where(eq(customFieldValues.organizationId, orgId));
	await db
		.delete(customFieldDefinitions)
		.where(eq(customFieldDefinitions.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await db.delete(workspaces).where(eq(workspaces.organizationId, orgId));
	await db.delete(organization).where(eq(organization.id, orgId));
}

async function createContact(name = "actions-test-contact") {
	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name,
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	return ct;
}

function makeCtx(contactId: string): RunContext {
	return {
		runId: "arun_actions_test",
		automationId: "auto_actions_test",
		organizationId: orgId,
		contactId,
		conversationId: null,
		channel: "telegram",
		graph: { schema_version: 1, root_node_key: null, nodes: [], edges: [] },
		context: { contact: { name: "alice" } },
		now: new Date(),
		db,
		env: { db },
	};
}

beforeAll(async () => {
	try {
		await seedFixtureOrg();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-actions.test] DB fixture setup failed — SSH tunnel likely down. Tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixtureOrg();
});

describe("action dispatcher", () => {
	it("tag_add appends to contacts.tags (idempotent)", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const ct = await createContact();
		const ctx = makeCtx(ct.id);

		await dispatchAction(
			{ id: "a1", type: "tag_add", tag: "vip", on_error: "abort" } as never,
			ctx,
		);
		await dispatchAction(
			{ id: "a2", type: "tag_add", tag: "vip", on_error: "abort" } as never,
			ctx,
		);
		await dispatchAction(
			{
				id: "a3",
				type: "tag_add",
				tag: "customer",
				on_error: "abort",
			} as never,
			ctx,
		);

		const refreshed = await db.query.contacts.findFirst({
			where: eq(contacts.id, ct.id),
		});
		const tags = refreshed?.tags ?? [];
		expect(tags).toContain("vip");
		expect(tags).toContain("customer");
		expect(tags.filter((t) => t === "vip").length).toBe(1);
	});

	it("tag_remove removes a tag (idempotent)", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const ct = await createContact();
		const ctx = makeCtx(ct.id);

		await dispatchAction(
			{
				id: "a1",
				type: "tag_add",
				tag: "to-remove",
				on_error: "abort",
			} as never,
			ctx,
		);
		await dispatchAction(
			{
				id: "a2",
				type: "tag_remove",
				tag: "to-remove",
				on_error: "abort",
			} as never,
			ctx,
		);
		// Removing a tag that no longer exists should be a no-op.
		await dispatchAction(
			{
				id: "a3",
				type: "tag_remove",
				tag: "never-there",
				on_error: "abort",
			} as never,
			ctx,
		);

		const refreshed = await db.query.contacts.findFirst({
			where: eq(contacts.id, ct.id),
		});
		expect(refreshed?.tags ?? []).not.toContain("to-remove");
	});

	it("field_set upserts a custom_field_values row with merge tags resolved", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const ct = await createContact();
		const ctx = makeCtx(ct.id);

		// Seed a field definition the action will target.
		const defId = generateId("cfd_");
		await db.insert(customFieldDefinitions).values({
			id: defId,
			organizationId: orgId,
			name: "Favorite color",
			slug: "favorite_color",
			type: "text",
		});

		// First write — insert.
		await dispatchAction(
			{
				id: "a1",
				type: "field_set",
				field: "favorite_color",
				value: "blue",
				on_error: "abort",
			} as never,
			ctx,
		);
		let row = await db.query.customFieldValues.findFirst({
			where: and(
				eq(customFieldValues.definitionId, defId),
				eq(customFieldValues.contactId, ct.id),
			),
		});
		expect(row?.value).toBe("blue");

		// Second write — update (with merge tag).
		await dispatchAction(
			{
				id: "a2",
				type: "field_set",
				field: "favorite_color",
				value: "{{contact.name}}'s pick",
				on_error: "abort",
			} as never,
			ctx,
		);
		row = await db.query.customFieldValues.findFirst({
			where: and(
				eq(customFieldValues.definitionId, defId),
				eq(customFieldValues.contactId, ct.id),
			),
		});
		expect(row?.value).toBe("alice's pick");

		// Unknown field — field_set should throw.
		await expect(
			dispatchAction(
				{
					id: "a3",
					type: "field_set",
					field: "nonexistent_field",
					value: "x",
					on_error: "abort",
				} as never,
				ctx,
			),
		).rejects.toThrow(/not found/);
	});
});
