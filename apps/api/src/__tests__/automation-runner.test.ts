// apps/api/src/__tests__/automation-runner.test.ts
//
// Integration tests for the automation runner. Run the isolated suite through
// the root `db:with-tunnel` wrapper to include these DB-backed cases. Each test
// seeds and tears down its own organization so the tests are hermetic.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationContactControls,
	automationEffects,
	automationNodeExecutions,
	automationRuns,
	automationStepRuns,
	automations,
	contacts,
	createDb,
	generateId,
	workspaces,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Graph } from "../schemas/automation-graph";
import { handlers } from "../services/automations/manifest";
import {
	automationEffectIdempotencyKey,
	enrollContact,
	runLoop,
} from "../services/automations/runner";
import {
	deleteOwnedFixtureOrganization,
	deleteOwnedFixtureWorkspaces,
	insertOwnedFixtureOrganization,
} from "./helpers/owned-organization-fixture";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;

const db = CONN
	? createDb(CONN)
	: (null as unknown as ReturnType<typeof createDb>);

// Lazily marks whether the tunnel is reachable. If the initial fixture setup
// throws, the tests themselves skip rather than fail the whole suite, so CI
// (no tunnel) still passes.
let dbAvailable = false;
let orgId = "";
let workspaceId = "";

async function seedFixtureOrg() {
	orgId = generateId("org_");
	await insertOwnedFixtureOrganization(db, {
		id: orgId,
		name: "runner-test-org",
		slug: `runner-test-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({
			organizationId: orgId,
			name: "runner-test-ws",
		})
		.returning();
	if (!ws) throw new Error("workspace insert failed");
	workspaceId = ws.id;
}

async function teardownFixtureOrg() {
	if (!orgId) return;
	// workspaces.organization_id has no ON DELETE CASCADE, so we have to clean
	// up everything the org fans out to before deleting the org itself. Most
	// business tables already cascade-delete from automations / contacts /
	// workspaces, so the explicit workspace delete is what unblocks the org
	// delete.
	await db
		.delete(automationContactControls)
		.where(eq(automationContactControls.organizationId, orgId));
	await db.delete(automations).where(eq(automations.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await deleteOwnedFixtureWorkspaces(db, orgId);
	await deleteOwnedFixtureOrganization(db, orgId);
}

async function createAutomation(graph: Graph, channel = "telegram") {
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name: "runner-test-automation",
			channel: channel as never,
			status: "active",
			graph: graph as never,
		})
		.returning();
	if (!auto) throw new Error("automation insert failed");
	return auto;
}

async function createContact() {
	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name: "runner-test-contact",
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	return ct;
}

beforeAll(async () => {
	if (!CONN) return;
	try {
		await seedFixtureOrg();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-runner.test] DB fixture setup failed — SSH tunnel likely down. Tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixtureOrg();
});

describe("automation runner", () => {
	it("runs a two-node message → end graph to completion", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "msg",
			nodes: [
				{
					key: "msg",
					kind: "message",
					config: {},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
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
					from_node: "msg",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};
		const auto = await createAutomation(graph);
		const ct = await createContact();

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: {},
		});

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run).toBeTruthy();
		if (!run) throw new Error("expected run to exist");
		expect(run.status).toBe("completed");
		expect(run.exitReason).toBe("completed");

		const steps = await db
			.select()
			.from(automationStepRuns)
			.where(eq(automationStepRuns.runId, runId));
		// message (advance) + end (end) = 2 step_run rows
		expect(steps.length).toBe(2);
		const kinds = steps.map((s) => s.nodeKind).sort();
		expect(kinds).toEqual(["end", "message"]);

		const autoAfter = await db.query.automations.findFirst({
			where: eq(automations.id, auto.id),
		});
		if (!autoAfter) throw new Error("expected autoAfter to exist");
		expect(autoAfter.totalEnrolled).toBe(1);
		expect(autoAfter.totalCompleted).toBe(1);
	});

	it("parks a run in waiting state when a pause row exists", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const graph: Graph = {
			schema_version: 1,
			root_node_key: "msg",
			nodes: [
				{
					key: "msg",
					kind: "message",
					config: {},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
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
					from_node: "msg",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};
		const auto = await createAutomation(graph);
		const ct = await createContact();

		// Insert a global pause for this contact BEFORE enrolling.
		await db.insert(automationContactControls).values({
			organizationId: orgId,
			contactId: ct.id,
			automationId: null,
			pauseReason: "manual_pause",
			pausedUntil: null,
		});

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: {},
		});

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) throw new Error("expected run to exist");
		expect(run.status).toBe("waiting");
		expect(run.waitingFor).toBe("external_event");
	});

	it("caps infinite loops at maxVisits and fails the run", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		// The validator would reject a goto → goto cycle, but we're bypassing
		// it here to exercise the runtime infinite-loop guard directly. Using
		// a small maxVisits override keeps the DB round-trip count manageable
		// over a latency-bound SSH tunnel while still proving the guard works.
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "g1",
			nodes: [
				{
					key: "g1",
					kind: "goto",
					config: { target_node_key: "g2" },
					ports: [{ key: "in", direction: "input" }],
				},
				{
					key: "g2",
					kind: "goto",
					config: { target_node_key: "g1" },
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [],
		};
		const auto = await createAutomation(graph);
		const ct = await createContact();

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: {},
			runLoopOptions: { maxVisits: 10 },
		});

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) throw new Error("expected run to exist");
		expect(run.status).toBe("failed");
		expect(run.exitReason).toBe("infinite_loop_cap");

		const autoAfter = await db.query.automations.findFirst({
			where: eq(automations.id, auto.id),
		});
		if (!autoAfter) throw new Error("expected autoAfter to exist");
		expect(autoAfter.totalFailed).toBeGreaterThanOrEqual(1);
	}, 30_000);

	it("exits via graph_changed when the current node is missing from the graph", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		// 1. Create an automation with an input node that parks the run.
		const inputGraph: Graph = {
			schema_version: 1,
			root_node_key: "wait",
			nodes: [
				{
					key: "wait",
					kind: "input",
					config: { field: "answer" },
					ports: [
						{ key: "in", direction: "input" },
						{ key: "captured", direction: "output", role: "default" },
					],
				},
			],
			edges: [],
		};
		const auto = await createAutomation(inputGraph);
		const ct = await createContact();

		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: {},
		});

		// Run should be waiting on input now.
		let run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) throw new Error("expected run to exist");
		expect(run.status).toBe("waiting");
		expect(run.currentNodeKey).toBe("wait");

		// 2. Remove the "wait" node from the graph and flip run back to active.
		const prunedGraph: Graph = {
			schema_version: 1,
			root_node_key: null,
			nodes: [],
			edges: [],
		};
		await db
			.update(automations)
			.set({ graph: prunedGraph as never })
			.where(eq(automations.id, auto.id));
		await db
			.update(automationRuns)
			.set({ status: "active", updatedAt: new Date() })
			.where(eq(automationRuns.id, runId));

		// 3. Re-enter the loop — should detect the missing node and exit.
		const result = await runLoop(db, runId, {});
		expect(result.status).toBe("exited");
		expect(result.exit_reason).toBe("graph_changed");

		run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) throw new Error("expected run to exist");
		expect(run.status).toBe("exited");
		expect(run.exitReason).toBe("graph_changed");
	}, 30_000);

	it("executes one handler under concurrent runLoop claims", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const kind = `test_concurrent_effect_${Date.now()}`;
		const graph = {
			schema_version: 1,
			root_node_key: "effect",
			nodes: [{ key: "effect", kind, config: {}, ports: [] }],
			edges: [],
		} as unknown as Graph;
		const auto = await createAutomation(graph);
		const ct = await createContact();
		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: {},
			deferRun: true,
		});

		let handlerCalls = 0;
		let enteredResolve: (() => void) | undefined;
		const entered = new Promise<void>((resolve) => {
			enteredResolve = resolve;
		});
		let releaseResolve: (() => void) | undefined;
		const release = new Promise<void>((resolve) => {
			releaseResolve = resolve;
		});
		handlers[kind] = {
			kind,
			async handle(_node, ctx) {
				handlerCalls += 1;
				expect(typeof ctx.effectIdempotencyKey).toBe("string");
				expect(ctx.env.automationEffectIdempotencyKey).toBe(
					ctx.effectIdempotencyKey,
				);
				enteredResolve?.();
				await release;
				return { result: "end", exit_reason: "completed" };
			},
		};

		try {
			const first = runLoop(db, runId, {});
			await Promise.race([
				entered,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("handler did not start")), 5_000),
				),
			]);
			const second = await runLoop(db, runId, {});
			expect(second).toEqual({ status: "active", exit_reason: null });
			releaseResolve?.();
			expect(await first).toEqual({
				status: "completed",
				exit_reason: "completed",
			});
		} finally {
			releaseResolve?.();
			delete handlers[kind];
		}

		expect(handlerCalls).toBe(1);
		const executions = await db
			.select()
			.from(automationNodeExecutions)
			.where(eq(automationNodeExecutions.runId, runId));
		expect(executions).toHaveLength(1);
		expect(executions[0]?.status).toBe("succeeded");
		expect(executions[0]?.attempts).toBe(1);
		const effects = await db
			.select()
			.from(automationEffects)
			.where(
				eq(automationEffects.nodeExecutionId, executions[0]?.id ?? "missing"),
			);
		expect(effects).toHaveLength(1);
		expect(effects[0]?.status).toBe("succeeded");
	});

	it("never replays an expired post-boundary node claim", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const kind = `test_crashed_effect_${Date.now()}`;
		const graph = {
			schema_version: 1,
			root_node_key: "effect",
			nodes: [{ key: "effect", kind, config: {}, ports: [] }],
			edges: [],
		} as unknown as Graph;
		const auto = await createAutomation(graph);
		const ct = await createContact();
		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: {},
			deferRun: true,
		});
		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) throw new Error("expected deferred run");
		const boundary = new Date(Date.now() - 10 * 60_000);
		const [execution] = await db
			.insert(automationNodeExecutions)
			.values({
				runId,
				organizationId: run.organizationId,
				scopeKey: run.scopeKey,
				runRevision: run.revision,
				visitOrdinal: 0,
				nodeKey: "effect",
				status: "in_flight",
				attempts: 1,
				leaseToken: 1,
				leaseExpiresAt: boundary,
				requestMayHaveBeenSentAt: boundary,
				claimedAt: boundary,
			})
			.returning();
		if (!execution) throw new Error("expected node execution");
		await db.insert(automationEffects).values({
			nodeExecutionId: execution.id,
			organizationId: run.organizationId,
			scopeKey: run.scopeKey,
			effectKey: "node-handler:v1",
			kind,
			providerIdempotencyKey: automationEffectIdempotencyKey(execution.id),
			status: "in_flight",
			attempts: 1,
			leaseToken: 1,
			leaseExpiresAt: boundary,
			requestMayHaveBeenSentAt: boundary,
			createdAt: boundary,
		});

		let handlerCalls = 0;
		handlers[kind] = {
			kind,
			async handle() {
				handlerCalls += 1;
				return { result: "end", exit_reason: "should_not_execute" };
			},
		};
		try {
			expect(await runLoop(db, runId, {})).toEqual({
				status: "failed",
				exit_reason: "node_effect_unknown",
			});
		} finally {
			delete handlers[kind];
		}

		expect(handlerCalls).toBe(0);
		const executionAfter = await db.query.automationNodeExecutions.findFirst({
			where: eq(automationNodeExecutions.id, execution.id),
		});
		expect(executionAfter?.status).toBe("unknown");
		const runAfter = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(runAfter?.status).toBe("failed");
		expect(runAfter?.exitReason).toBe("node_effect_unknown");
		expect(
			(runAfter?.context as Record<string, unknown> | null)
				?._automation_manual_reconciliation,
		).toBeDefined();
	});

	it("replays a completed HandlerResult without invoking the handler", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const kind = `test_replayed_effect_${Date.now()}`;
		const graph = {
			schema_version: 1,
			root_node_key: "effect",
			nodes: [{ key: "effect", kind, config: {}, ports: [] }],
			edges: [],
		} as unknown as Graph;
		const auto = await createAutomation(graph);
		const ct = await createContact();
		const { runId } = await enrollContact(db, {
			automationId: auto.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: {},
			deferRun: true,
		});
		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) throw new Error("expected deferred run");
		const completion = {
			version: 1,
			handlerResult: { result: "end", exit_reason: "replayed_completion" },
			context: { replayed_context: true },
			durationMs: 9,
		};
		const claimedAt = new Date(Date.now() - 1_000);
		const completedAt = new Date();
		const [execution] = await db
			.insert(automationNodeExecutions)
			.values({
				runId,
				organizationId: run.organizationId,
				scopeKey: run.scopeKey,
				runRevision: run.revision,
				visitOrdinal: 0,
				nodeKey: "effect",
				status: "succeeded",
				attempts: 1,
				leaseToken: 1,
				result: completion,
				claimedAt,
				completedAt,
			})
			.returning();
		if (!execution) throw new Error("expected node execution");
		await db.insert(automationEffects).values({
			nodeExecutionId: execution.id,
			organizationId: run.organizationId,
			scopeKey: run.scopeKey,
			effectKey: "node-handler:v1",
			kind,
			providerIdempotencyKey: automationEffectIdempotencyKey(execution.id),
			status: "succeeded",
			attempts: 1,
			leaseToken: 1,
			result: completion,
			createdAt: claimedAt,
			completedAt,
		});

		let handlerCalls = 0;
		handlers[kind] = {
			kind,
			async handle() {
				handlerCalls += 1;
				return { result: "end", exit_reason: "duplicate" };
			},
		};
		try {
			expect(await runLoop(db, runId, {})).toEqual({
				status: "completed",
				exit_reason: "replayed_completion",
			});
		} finally {
			delete handlers[kind];
		}
		expect(handlerCalls).toBe(0);
		const runAfter = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(runAfter?.context).toEqual({ replayed_context: true });
	});

	it("start_automation fails when the target automation is not active", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		// Target automation — start paused so start_automation should refuse it.
		const targetGraph: Graph = {
			schema_version: 1,
			root_node_key: "stop",
			nodes: [
				{
					key: "stop",
					kind: "end",
					config: {},
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [],
		};
		const [target] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "paused-target",
				channel: "telegram",
				status: "paused",
				graph: targetGraph as never,
			})
			.returning();
		if (!target) throw new Error("target insert failed");

		// Source automation — invokes start_automation against the paused target.
		const sourceGraph: Graph = {
			schema_version: 1,
			root_node_key: "sa",
			nodes: [
				{
					key: "sa",
					kind: "start_automation",
					config: { target_automation_id: target.id, pass_context: false },
					ports: [
						{ key: "in", direction: "input" },
						{ key: "next", direction: "output", role: "default" },
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
					from_node: "sa",
					from_port: "next",
					to_node: "stop",
					to_port: "in",
				},
			],
		};
		const source = await createAutomation(sourceGraph);
		const ct = await createContact();

		const { runId } = await enrollContact(db, {
			automationId: source.id,
			organizationId: orgId,
			contactId: ct.id,
			conversationId: null,
			channel: "telegram",
			entrypointId: null,
			bindingId: null,
			env: {},
		});

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) throw new Error("expected run to exist");
		// The start_automation node returns `fail` because the target isn't
		// active. The runner treats a bare `fail` (no `error` port wired up)
		// as a `failed` status with `handler_failure` exit_reason.
		expect(run.status).toBe("failed");
		expect(run.exitReason).toBe("handler_failure");
	});
});
