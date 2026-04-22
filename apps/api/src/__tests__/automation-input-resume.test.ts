// apps/api/src/__tests__/automation-input-resume.test.ts
//
// Tests for the input wait/resume path (Plan 4, Task 2). Covers both the
// pure `resolveInputResume` decision function (unit, no DB) and the
// `resumeWaitingRunOnInput` integration path that walks a real run through
// a graph after a message arrives.
//
// DB-backed tests require the SSH tunnel to localhost:5433.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationRuns,
	automations,
	contacts,
	createDb,
	generateId,
	organization,
	workspaces,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Graph } from "../schemas/automation-graph";
import {
	resolveInputResume,
	resumeWaitingRunOnInput,
} from "../services/automations/input-resume";
import { enrollContact } from "../services/automations/runner";

// ---------------------------------------------------------------------------
// Unit tests — resolveInputResume (pure function)
// ---------------------------------------------------------------------------

describe("resolveInputResume", () => {
	it("accepts free text by default", () => {
		const out = resolveInputResume(
			{ field: "answer" },
			"hello world",
			false,
			0,
		);
		expect(out.port).toBe("captured");
		if (out.port === "captured") {
			expect(out.capturedValue).toBe("hello world");
		}
	});

	it("treats empty text as invalid (no retries left)", () => {
		const out = resolveInputResume(
			{ field: "answer", max_retries: 1 },
			"   ",
			false,
			0,
		);
		expect(out.port).toBe("invalid");
	});

	it("asks for retry when empty text but retries remain", () => {
		const out = resolveInputResume(
			{ field: "answer", max_retries: 3 },
			"",
			false,
			0,
		);
		expect(out.port).toBe("retry");
	});

	it("validates email format", () => {
		const ok = resolveInputResume(
			{ field: "email", input_type: "email" },
			"alice@example.com",
			false,
			0,
		);
		expect(ok.port).toBe("captured");

		const bad = resolveInputResume(
			{ field: "email", input_type: "email", max_retries: 1 },
			"not-an-email",
			false,
			0,
		);
		expect(bad.port).toBe("invalid");
	});

	it("exhausts email retries before firing `invalid`", () => {
		const cfg = { field: "email", input_type: "email" as const, max_retries: 2 };
		const first = resolveInputResume(cfg, "still-bad", false, 0);
		expect(first.port).toBe("retry");
		const second = resolveInputResume(cfg, "still-bad", false, 1);
		expect(second.port).toBe("invalid");
	});

	it("validates phone numbers loosely", () => {
		const ok = resolveInputResume(
			{ field: "phone", input_type: "phone" },
			"+1 (415) 555-1212",
			false,
			0,
		);
		expect(ok.port).toBe("captured");

		const bad = resolveInputResume(
			{ field: "phone", input_type: "phone", max_retries: 1 },
			"abc",
			false,
			0,
		);
		expect(bad.port).toBe("invalid");
	});

	it("parses numeric input", () => {
		const out = resolveInputResume(
			{ field: "age", input_type: "number" },
			"42",
			false,
			0,
		);
		expect(out.port).toBe("captured");
		if (out.port === "captured") expect(out.capturedValue).toBe(42);

		const bad = resolveInputResume(
			{ field: "age", input_type: "number", max_retries: 1 },
			"nope",
			false,
			0,
		);
		expect(bad.port).toBe("invalid");
	});

	it("matches choice values / labels / match[] aliases case-insensitively", () => {
		const cfg = {
			field: "size",
			input_type: "choice" as const,
			choices: [
				{ value: "small", label: "Small", match: ["S", "sm"] },
				{ value: "large", label: "Large", match: ["L", "lg"] },
			],
		};
		const byValue = resolveInputResume(cfg, "large", false, 0);
		const byLabel = resolveInputResume(cfg, "Small", false, 0);
		const byMatch = resolveInputResume(cfg, "lg", false, 0);
		expect(byValue.port).toBe("captured");
		expect(byLabel.port).toBe("captured");
		expect(byMatch.port).toBe("captured");
		if (byValue.port === "captured") expect(byValue.capturedValue).toBe("large");
		if (byLabel.port === "captured") expect(byLabel.capturedValue).toBe("small");
		if (byMatch.port === "captured") expect(byMatch.capturedValue).toBe("large");

		const miss = resolveInputResume(
			{ ...cfg, max_retries: 1 },
			"medium",
			false,
			0,
		);
		expect(miss.port).toBe("invalid");
	});

	it("requires an attachment for file inputs", () => {
		const withAttach = resolveInputResume(
			{ field: "file", input_type: "file" },
			"",
			true,
			0,
		);
		expect(withAttach.port).toBe("captured");

		const noAttach = resolveInputResume(
			{ field: "file", input_type: "file", max_retries: 1 },
			"",
			false,
			0,
		);
		expect(noAttach.port).toBe("invalid");
	});

	it("respects skip_allowed keyword", () => {
		const out = resolveInputResume(
			{ field: "email", input_type: "email", skip_allowed: true },
			"skip",
			false,
			0,
		);
		expect(out.port).toBe("skip");
	});

	it("skip keyword is ignored when skip_allowed is false", () => {
		const out = resolveInputResume(
			{ field: "email", input_type: "email", max_retries: 1 },
			"skip",
			false,
			0,
		);
		// "skip" is not a valid email, and we're out of retries → invalid
		expect(out.port).toBe("invalid");
	});

	it("enforces validation.pattern on text inputs", () => {
		const cfg = {
			field: "zip",
			input_type: "text" as const,
			validation: { pattern: "^\\d{5}$" },
			max_retries: 1,
		};
		const ok = resolveInputResume(cfg, "94103", false, 0);
		expect(ok.port).toBe("captured");

		const bad = resolveInputResume(cfg, "ABC", false, 0);
		expect(bad.port).toBe("invalid");
	});

	it("silently ignores malformed validation regex", () => {
		const cfg = {
			field: "zip",
			input_type: "text" as const,
			validation: { pattern: "[" /* invalid */ },
		};
		const out = resolveInputResume(cfg, "whatever", false, 0);
		expect(out.port).toBe("captured");
	});
});

// ---------------------------------------------------------------------------
// DB-backed integration tests — resumeWaitingRunOnInput
// ---------------------------------------------------------------------------

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
		name: "input-resume-test-org",
		slug: `input-resume-test-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({
			organizationId: orgId,
			name: "input-resume-test-ws",
		})
		.returning();
	if (!ws) throw new Error("workspace insert failed");
	workspaceId = ws.id;
}

async function teardownFixtureOrg() {
	if (!orgId) return;
	await db.delete(automations).where(eq(automations.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await db.delete(workspaces).where(eq(workspaces.organizationId, orgId));
	await db.delete(organization).where(eq(organization.id, orgId));
}

async function createAutomation(graph: Graph, channel = "telegram") {
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name: "input-resume-test-automation",
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
			name: "input-resume-test-contact",
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	return ct;
}

beforeAll(async () => {
	try {
		await seedFixtureOrg();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-input-resume.test] DB fixture setup failed — SSH tunnel likely down. Tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixtureOrg();
});

// Shared graph builder: input(email) → end, with optional invalid branch.
function emailCaptureGraph(opts: { maxRetries?: number } = {}): Graph {
	return {
		schema_version: 1,
		root_node_key: "ask_email",
		nodes: [
			{
				key: "ask_email",
				kind: "input",
				config: {
					field: "email",
					input_type: "email",
					max_retries: opts.maxRetries ?? 2,
				},
				ports: [
					{ key: "in", direction: "input" },
					{ key: "captured", direction: "output" },
					{ key: "invalid", direction: "output" },
					{ key: "timeout", direction: "output" },
					{ key: "skip", direction: "output" },
				],
			},
			{
				key: "ok",
				kind: "end",
				config: { reason: "captured" },
				ports: [{ key: "in", direction: "input" }],
			},
			{
				key: "fail",
				kind: "end",
				config: { reason: "invalid" },
				ports: [{ key: "in", direction: "input" }],
			},
		],
		edges: [
			{
				from_node: "ask_email",
				from_port: "captured",
				to_node: "ok",
				to_port: "in",
			},
			{
				from_node: "ask_email",
				from_port: "invalid",
				to_node: "fail",
				to_port: "in",
			},
		],
	};
}

describe("resumeWaitingRunOnInput (integration)", () => {
	it("captures a valid email and advances to the captured branch", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const auto = await createAutomation(emailCaptureGraph());
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

		// Run should be parked waiting for input now.
		let run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("waiting");
		expect(run!.waitingFor).toBe("input");
		expect(run!.currentNodeKey).toBe("ask_email");

		const outcome = await resumeWaitingRunOnInput(
			db,
			runId,
			"alice@example.com",
			false,
			{},
		);
		expect(outcome).toBe("advanced");

		run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		expect(run!.exitReason).toBe("completed");
		// Captured value should have landed in context under the configured field.
		const context = (run!.context as Record<string, unknown>) ?? {};
		expect(context.email).toBe("alice@example.com");
		// And the retry counter for this node must be cleaned up — we just
		// exited via `captured`, so nothing should be lingering in context.
		const retries = context._input_retries as
			| Record<string, number>
			| undefined;
		expect(retries?.ask_email).toBeUndefined();
	});

	it(
		"retries once on invalid input, then exits via the invalid port",
		async () => {
			if (!dbAvailable) {
				console.warn("skipping: DB fixture unavailable");
				return;
			}

			const auto = await createAutomation(emailCaptureGraph({ maxRetries: 2 }));
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

			// First bad input — should retry, run stays waiting.
			let outcome = await resumeWaitingRunOnInput(
				db,
				runId,
				"not-an-email",
				false,
				{},
			);
			expect(outcome).toBe("retried");

			let run = await db.query.automationRuns.findFirst({
				where: eq(automationRuns.id, runId),
			});
			expect(run!.status).toBe("waiting");
			expect(run!.waitingFor).toBe("input");
			expect(run!.currentNodeKey).toBe("ask_email");
			const ctx = (run!.context as Record<string, unknown>) ?? {};
			expect(
				(ctx._input_retries as Record<string, number> | undefined)?.ask_email,
			).toBe(1);

			// Second bad input — retries exhausted, run exits via `invalid` port.
			outcome = await resumeWaitingRunOnInput(
				db,
				runId,
				"still-not-an-email",
				false,
				{},
			);
			expect(outcome).toBe("advanced");

			run = await db.query.automationRuns.findFirst({
				where: eq(automationRuns.id, runId),
			});
			expect(run!.status).toBe("completed");
			// The `invalid` edge routes to the "fail" end node, so the run
			// completes cleanly. Email must NOT be stored in context.
			const finalCtx = (run!.context as Record<string, unknown>) ?? {};
			expect(finalCtx.email).toBeUndefined();
		},
		30_000,
	);

	it("returns 'race' when the run is no longer waiting for input", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		const auto = await createAutomation(emailCaptureGraph());
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

		// Simulate a concurrent worker flipping the run out of the waiting state.
		await db
			.update(automationRuns)
			.set({
				status: "completed",
				exitReason: "manual_complete",
				completedAt: new Date(),
				waitingFor: null,
				waitingUntil: null,
			})
			.where(eq(automationRuns.id, runId));

		const outcome = await resumeWaitingRunOnInput(
			db,
			runId,
			"alice@example.com",
			false,
			{},
		);
		expect(outcome).toBe("race");
	});

	it("exits cleanly when the chosen port has no outgoing edge", async () => {
		if (!dbAvailable) {
			console.warn("skipping: DB fixture unavailable");
			return;
		}

		// Graph with a captured edge but no `invalid` edge wired.
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "ask",
			nodes: [
				{
					key: "ask",
					kind: "input",
					config: {
						field: "email",
						input_type: "email",
						max_retries: 1,
					},
					ports: [
						{ key: "in", direction: "input" },
						{ key: "captured", direction: "output" },
						{ key: "invalid", direction: "output" },
					],
				},
				{
					key: "ok",
					kind: "end",
					config: {},
					ports: [{ key: "in", direction: "input" }],
				},
			],
			edges: [
				{
					from_node: "ask",
					from_port: "captured",
					to_node: "ok",
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

		const outcome = await resumeWaitingRunOnInput(
			db,
			runId,
			"not-an-email",
			false,
			{},
		);
		expect(outcome).toBe("completed");

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		expect(run!.status).toBe("completed");
		expect(run!.currentPortKey).toBe("invalid");
	});
});
