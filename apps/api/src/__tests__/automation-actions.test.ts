// apps/api/src/__tests__/automation-actions.test.ts
//
// Integration tests for the action dispatcher hitting a real PostgreSQL
// database. Run the isolated suite through the root `db:with-tunnel` wrapper to
// include DB cases; on CI or without the tunnel, they skip rather than fail.
//
// We test the two most-exercised actions — tag_add (array column mutation)
// and field_set (custom field upsert) — and let the unit-level action_group
// test cover dispatcher shape.

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import {
	contacts,
	createDb,
	customFieldDefinitions,
	customFieldValues,
	generateId,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { encryptAccountToken } from "../lib/account-token-crypto";
import { dispatchAction } from "../services/automations/actions";
import type { RunContext } from "../services/automations/types";
import {
	deleteOwnedFixtureOrganization,
	deleteOwnedFixtureWorkspaces,
	insertOwnedFixtureOrganization,
} from "./helpers/owned-organization-fixture";
import { protectedContactFieldsFixture } from "./helpers/protected-contact-fixtures";

const TEST_ENCRYPTION_KEY = `test=${"11".repeat(32)},identity=${"12".repeat(32)}`;

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;

const db = CONN
	? createDb(CONN)
	: (null as unknown as ReturnType<typeof createDb>);
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

let dbAvailable = false;
let orgId = "";
let workspaceId = "";

async function seedFixtureOrg() {
	orgId = generateId("org_");
	await insertOwnedFixtureOrganization(db, {
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
	await db
		.delete(socialAccounts)
		.where(eq(socialAccounts.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await deleteOwnedFixtureWorkspaces(db, orgId);
	await deleteOwnedFixtureOrganization(db, orgId);
}

async function createContact(name = "actions-test-contact") {
	const id = generateId("ct_");
	const [ct] = await db
		.insert(contacts)
		.values({
			id,
			organizationId: orgId,
			workspaceId,
			...(await protectedContactFieldsFixture({
				id,
				organizationId: orgId,
				name,
			})),
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
		workspaceId,
		contactId,
		conversationId: null,
		channel: "telegram",
		graph: { schema_version: 1, root_node_key: null, nodes: [], edges: [] },
		context: { contact: { name: "alice" } },
		now: new Date(),
		db,
		env: { db, ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
	};
}

async function createSocialAccount(platform: string, accessToken: string) {
	const id = generateId("acc_");
	const [acc] = await db
		.insert(socialAccounts)
		.values({
			id,
			organizationId: orgId,
			workspaceId,
			platform: platform as never,
			platformAccountId: `platacc_${platform}_${Date.now()}`,
			username: `actions_${platform}`,
			accessToken: await encryptAccountToken(
				accessToken,
				TEST_ENCRYPTION_KEY,
				id,
				"access_token",
			),
		})
		.returning();
	if (!acc) throw new Error("social account insert failed");
	return acc;
}

beforeAll(async () => {
	if (!CONN) return;
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

afterEach(() => {
	globalThis.fetch = originalFetch;
	console.warn = originalWarn;
});

describe("action dispatcher", () => {
	it("persists a durable conversion outbox fact before its fast-path dispatch", async () => {
		let persisted: Record<string, unknown> | undefined;
		let conflictTarget: unknown;
		const durableDb = {
			insert: () => ({
				values: (values: Record<string, unknown>) => {
					persisted = values;
					return {
						onConflictDoNothing: async (options: { target: unknown }) => {
							conflictTarget = options.target;
						},
					};
				},
			}),
		} as unknown as RunContext["db"];
		const ctx: RunContext = {
			...makeCtx("ct_conversion_test"),
			organizationId: "org_conversion_test",
			workspaceId: "ws_conversion_test",
			db: durableDb,
			env: { db: durableDb, ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
			context: {
				contact: { name: "alice" },
				// The unit is concerned with the durable write that precedes the
				// best-effort fast path; the scheduled dispatcher owns recovery.
				triggerEvent: { payload: { _event_depth: 5 } },
			},
		};
		console.warn = mock(() => {});

		await dispatchAction(
			{
				id: "conversion_1",
				type: "log_conversion_event",
				event_name: "purchase",
				value: "49.00",
				currency: "gbp",
				on_error: "abort",
			} as never,
			ctx,
		);

		expect(persisted).toMatchObject({
			organizationId: "org_conversion_test",
			scopeKey: "ws/ws_conversion_test",
			automationId: "auto_actions_test",
			runId: "arun_actions_test",
			contactId: "ct_conversion_test",
			occurrenceId: "arun_actions_test:conversion_1",
			eventName: "purchase",
			value: "49.00",
			currency: "GBP",
			metadata: { action_id: "conversion_1" },
		});
		expect(conflictTarget).toBeDefined();
	});

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

	it("reply_to_comment posts a merged public reply to the triggering Instagram comment", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const ct = await createContact();
		const acc = await createSocialAccount("instagram", "IGAAtest-token");

		let calledUrl = "";
		let calledBody: Record<string, unknown> | null = null;
		globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
			calledUrl = String(input);
			calledBody = init?.body ? JSON.parse(String(init.body)) : null;
			return new Response(JSON.stringify({ id: "ig_reply_1" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		await dispatchAction(
			{
				id: "a4",
				type: "reply_to_comment",
				text: "Thanks {{contact.name}}!",
				on_error: "abort",
			} as never,
			{
				...makeCtx(ct.id),
				channel: "instagram",
				context: {
					contact: { name: "alice" },
					_triggering_social_account_id: acc.id,
					triggerEvent: {
						socialAccountId: acc.id,
						payload: { comment_id: "ig_comment_42" },
					},
				},
			},
		);

		expect(calledUrl).toBe(
			"https://graph.instagram.com/v25.0/ig_comment_42/replies",
		);
		expect(calledBody).not.toBeNull();
		if (!calledBody) throw new Error("expected fetch body");
		const body = calledBody as unknown as Record<string, unknown>;
		expect(body).toEqual({
			message: "Thanks alice!",
			access_token: "IGAAtest-token",
		});
	});
});
