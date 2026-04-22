// apps/api/src/__tests__/automation-integration-actions.test.ts
//
// Plan 4 — Unit RR1: integration test covering the wiring of `ctx.db` and
// the initial hydration of `automation_runs.context` with contact / tags /
// fields at enrollment time.
//
// Both behaviors are exercised by a single run that:
//   1. Seeds an organization, workspace, social account (channel=instagram),
//      contact, a custom field definition `first_name`, a preset value
//      `first_name="Alice"`, and a tag `lead` on the contact.
//   2. Creates an automation with graph:
//        action_group [ tag_add("qualified"), field_set("first_name", "Alice Updated") ]
//          → end
//   3. Activates it and calls enrollContact directly.
//   4. Asserts:
//      - run reaches status=completed, exit_reason=completed
//      - step_runs records 2 step rows (action_group + end)
//      - contacts.tags contains both "lead" (preserved) and "qualified" (added
//        by the tag_add handler, proving ctx.db was wired correctly)
//      - custom_field_values for first_name is now "Alice Updated" (proving
//        the field_set handler used ctx.db)
//      - automation_runs.context contains hydrated contact, tags, fields
//        (proving buildInitialRunContext ran)
//
// Requires the SSH tunnel to localhost:5433 (matches the other integration
// tests). When the tunnel is down the test skips gracefully.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationRuns,
	automationStepRuns,
	automations,
	contacts,
	createDb,
	customFieldDefinitions,
	customFieldValues,
	generateId,
	organization,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Graph } from "../schemas/automation-graph";
import { enrollContact } from "../services/automations/runner";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
	"postgres://relayapi:z9scNsSByxEn8QC6Z6PDQLLSKLum3F@localhost:5433/relayapi?sslmode=disable";

const db = createDb(CONN);

let dbAvailable = false;
let orgId = "";
let workspaceId = "";
let socialAccountId = "";
let contactId = "";
let fieldDefinitionId = "";

async function seedFixture() {
	orgId = generateId("org_");
	await db.insert(organization).values({
		id: orgId,
		name: "integration-actions-org",
		slug: `int-actions-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({ organizationId: orgId, name: "int-actions-ws" })
		.returning();
	if (!ws) throw new Error("workspace insert failed");
	workspaceId = ws.id;

	const [sa] = await db
		.insert(socialAccounts)
		.values({
			organizationId: orgId,
			workspaceId,
			platform: "instagram",
			platformAccountId: `ig_${generateId("acc_")}`,
			displayName: "Integration IG Account",
		})
		.returning();
	if (!sa) throw new Error("social account insert failed");
	socialAccountId = sa.id;

	// Contact is pre-seeded with the `lead` tag so we can verify the
	// hydration preserves existing tags AND that tag_add appends rather
	// than replaces.
	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name: "Alice Example",
			email: "alice@example.com",
			tags: ["lead"],
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	contactId = ct.id;

	// Create a custom field definition "first_name" and a preset value so
	// we can verify (a) hydration surfaces it under `fields.first_name`,
	// and (b) field_set updates the existing row via ctx.db.
	const [def] = await db
		.insert(customFieldDefinitions)
		.values({
			organizationId: orgId,
			workspaceId,
			name: "First Name",
			slug: "first_name",
			type: "text",
		})
		.returning();
	if (!def) throw new Error("custom field definition insert failed");
	fieldDefinitionId = def.id;

	await db.insert(customFieldValues).values({
		definitionId: def.id,
		contactId: ct.id,
		organizationId: orgId,
		value: "Alice",
	});
}

async function teardownFixture() {
	if (!orgId) return;
	await db
		.delete(automationRuns)
		.where(eq(automationRuns.organizationId, orgId));
	await db.delete(automations).where(eq(automations.organizationId, orgId));
	await db
		.delete(customFieldValues)
		.where(eq(customFieldValues.organizationId, orgId));
	await db
		.delete(customFieldDefinitions)
		.where(eq(customFieldDefinitions.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await db
		.delete(socialAccounts)
		.where(eq(socialAccounts.organizationId, orgId));
	await db.delete(workspaces).where(eq(workspaces.organizationId, orgId));
	await db.delete(organization).where(eq(organization.id, orgId));
}

beforeAll(async () => {
	try {
		await seedFixture();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-integration-actions.test] DB fixture setup failed — SSH tunnel likely down. Test will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixture();
});

describe("automation integration — ctx.db wiring + context hydration", () => {
	it("action_group → end runs side effects and hydrates context", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable (SSH tunnel likely down)");
			return;
		}

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "actions",
			nodes: [
				{
					key: "actions",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "a1",
								type: "tag_add",
								tag: "qualified",
								on_error: "abort",
							},
							{
								id: "a2",
								type: "field_set",
								field: "first_name",
								value: "Alice Updated",
								on_error: "abort",
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "error", direction: "output", role: "error" },
					],
				},
				{
					key: "stop",
					kind: "end",
					config: {},
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [
				{
					from_node: "actions",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};

		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "integration-actions-automation",
				channel: "instagram",
				status: "active",
				graph: graph as never,
			})
			.returning();
		if (!auto) throw new Error("automation insert failed");

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId,
			conversationId: null,
			channel: "instagram",
			entrypointId: null,
			bindingId: null,
			env: {},
		});

		// 1. Run reached terminal success.
		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run).toBeTruthy();
		expect(run!.status).toBe("completed");
		expect(run!.exitReason).toBe("completed");

		// 2. step_runs captures action_group + end.
		const steps = await db
			.select()
			.from(automationStepRuns)
			.where(eq(automationStepRuns.runId, runId));
		const kinds = steps.map((s) => s.nodeKind).sort();
		expect(kinds).toEqual(["action_group", "end"]);

		// 3. tag_add appended "qualified" while preserving "lead" — proves
		//    ctx.db was wired: without it the handler would have thrown and
		//    the action_group would have routed via `error`.
		const refreshedContact = await db.query.contacts.findFirst({
			where: eq(contacts.id, contactId),
		});
		expect(refreshedContact).toBeTruthy();
		expect(refreshedContact!.tags).toContain("lead");
		expect(refreshedContact!.tags).toContain("qualified");

		// 4. field_set updated the existing custom field value. Again, would
		//    have blown up if ctx.db weren't populated.
		const fieldValue = await db.query.customFieldValues.findFirst({
			where: and(
				eq(customFieldValues.definitionId, fieldDefinitionId),
				eq(customFieldValues.contactId, contactId),
			),
		});
		expect(fieldValue).toBeTruthy();
		expect(fieldValue!.value).toBe("Alice Updated");

		// 5. The run's JSONB context was hydrated at enrollment.
		const ctxJson = (run!.context ?? {}) as Record<string, any>;
		expect(ctxJson.contact).toBeTruthy();
		expect(ctxJson.contact.id).toBe(contactId);
		expect(Array.isArray(ctxJson.tags)).toBe(true);
		// The runner persists ctx.context after every step, so by the time
		// the run completes the stored context reflects ALL same-run
		// mutations including the tag_add ("qualified") and field_set
		// ("Alice Updated") executed above. Plan 6 Unit RR11 / Task 5 (F6)
		// wires that refresh into the tag + field action handlers.
		expect(ctxJson.tags).toContain("lead");
		expect(ctxJson.tags).toContain("qualified");
		expect(ctxJson.fields).toBeTruthy();
		expect(ctxJson.fields.first_name).toBe("Alice Updated");
	});

	it("tag_add → condition(tags contains) → true branch reads freshly added tag", async () => {
		// Plan 6 Unit RR11 / Task 5 (F6): same-run context refresh after tag
		// mutations. Flow:
		//   action_group [tag_add "premium"]
		//     → condition(tags contains "premium")
		//         → branch true: action_group [tag_add "saw_premium_branch"]
		//           → end
		//         → branch false: action_group [tag_add "saw_default_branch"]
		//           → end
		//
		// Before the fix, tag_add wrote to the DB but not to ctx.context, so
		// the condition always fell through to the false branch. The
		// assertion: after the run completes, the contact has
		// "saw_premium_branch" (not "saw_default_branch").
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		// Use a fresh contact so we can assert terminal tag state without
		// interference from earlier tests.
		const [ct] = await db
			.insert(contacts)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "Same-run tag refresh contact",
				tags: [],
			})
			.returning();
		if (!ct) throw new Error("contact insert failed");

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "grant",
			nodes: [
				{
					key: "grant",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "a_grant",
								type: "tag_add",
								tag: "premium",
								on_error: "abort",
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "error", direction: "output", role: "error" },
					],
				},
				{
					key: "check",
					kind: "condition",
					config: {
						predicates: {
							all: [{ field: "tags", op: "contains", value: "premium" }],
						},
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "true", direction: "output" },
						{ key: "false", direction: "output" },
					],
				},
				{
					key: "on_true",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "a_true",
								type: "tag_add",
								tag: "saw_premium_branch",
								on_error: "abort",
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "error", direction: "output", role: "error" },
					],
				},
				{
					key: "on_false",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "a_false",
								type: "tag_add",
								tag: "saw_default_branch",
								on_error: "abort",
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "error", direction: "output", role: "error" },
					],
				},
				{
					key: "done",
					kind: "end",
					config: {},
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [
				{
					from_node: "grant",
					from_port: "next",
					to_node: "check",
					to_port: "in",
				},
				{
					from_node: "check",
					from_port: "true",
					to_node: "on_true",
					to_port: "in",
				},
				{
					from_node: "check",
					from_port: "false",
					to_node: "on_false",
					to_port: "in",
				},
				{
					from_node: "on_true",
					from_port: "next",
					to_node: "done",
					to_port: "in",
				},
				{
					from_node: "on_false",
					from_port: "next",
					to_node: "done",
					to_port: "in",
				},
			],
		};

		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "same-run-tag-refresh",
				channel: "instagram",
				status: "active",
				graph: graph as never,
			})
			.returning();
		if (!auto) throw new Error("automation insert failed");

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "instagram",
			entrypointId: null,
			bindingId: null,
			env: {},
		});

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run?.status).toBe("completed");

		const refreshed = await db.query.contacts.findFirst({
			where: eq(contacts.id, ct.id),
		});
		expect(refreshed?.tags).toContain("premium");
		expect(refreshed?.tags).toContain("saw_premium_branch");
		// Negative: false branch must NOT have executed.
		expect(refreshed?.tags ?? []).not.toContain("saw_default_branch");
	});

	it("field_set → condition(field == value) → true branch reads freshly written field", async () => {
		// Same as the tag_add test above, but for field_set. Plan 6 Unit
		// RR11 / Task 5 (F6). Uses a custom field definition `plan` and
		// writes "pro", then branches on `fields.plan == "pro"`.
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		// Create a `plan` custom field definition (scoped to this test so it
		// doesn't interfere with the hydration assertions above).
		const [planDef] = await db
			.insert(customFieldDefinitions)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "Plan",
				slug: "plan",
				type: "text",
			})
			.returning();
		if (!planDef) throw new Error("custom field definition insert failed");

		const [ct] = await db
			.insert(contacts)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "Same-run field refresh contact",
				tags: [],
			})
			.returning();
		if (!ct) throw new Error("contact insert failed");

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "upgrade",
			nodes: [
				{
					key: "upgrade",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "a_set_plan",
								type: "field_set",
								field: "plan",
								value: "pro",
								on_error: "abort",
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "error", direction: "output", role: "error" },
					],
				},
				{
					key: "check",
					kind: "condition",
					config: {
						predicates: {
							all: [{ field: "fields.plan", op: "eq", value: "pro" }],
						},
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "true", direction: "output" },
						{ key: "false", direction: "output" },
					],
				},
				{
					key: "on_true",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "a_true",
								type: "tag_add",
								tag: "saw_pro_plan",
								on_error: "abort",
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "error", direction: "output", role: "error" },
					],
				},
				{
					key: "on_false",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "a_false",
								type: "tag_add",
								tag: "saw_non_pro_plan",
								on_error: "abort",
							},
						],
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
						{ key: "error", direction: "output", role: "error" },
					],
				},
				{
					key: "done",
					kind: "end",
					config: {},
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [
				{
					from_node: "upgrade",
					from_port: "next",
					to_node: "check",
					to_port: "in",
				},
				{
					from_node: "check",
					from_port: "true",
					to_node: "on_true",
					to_port: "in",
				},
				{
					from_node: "check",
					from_port: "false",
					to_node: "on_false",
					to_port: "in",
				},
				{
					from_node: "on_true",
					from_port: "next",
					to_node: "done",
					to_port: "in",
				},
				{
					from_node: "on_false",
					from_port: "next",
					to_node: "done",
					to_port: "in",
				},
			],
		};

		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "same-run-field-refresh",
				channel: "instagram",
				status: "active",
				graph: graph as never,
			})
			.returning();
		if (!auto) throw new Error("automation insert failed");

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "instagram",
			entrypointId: null,
			bindingId: null,
			env: {},
		});

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run?.status).toBe("completed");

		const refreshed = await db.query.contacts.findFirst({
			where: eq(contacts.id, ct.id),
		});
		expect(refreshed?.tags).toContain("saw_pro_plan");
		expect(refreshed?.tags ?? []).not.toContain("saw_non_pro_plan");

		// Sanity: the DB row for the custom field value was written.
		const fv = await db.query.customFieldValues.findFirst({
			where: and(
				eq(customFieldValues.definitionId, planDef.id),
				eq(customFieldValues.contactId, ct.id),
			),
		});
		expect(fv?.value).toBe("pro");
	});
});
