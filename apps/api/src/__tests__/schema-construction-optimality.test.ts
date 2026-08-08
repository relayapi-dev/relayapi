import { describe, expect, it } from "bun:test";
import {
	EntrypointCreateSchema,
	validateEntrypointConfig,
} from "../schemas/automation-entrypoints";
import { CreateFieldBody, UpdateFieldBody } from "../schemas/custom-fields";
import { WebhookLogEntry } from "../schemas/webhooks";
import { WORKSPACE_PURGE_TABLES } from "../services/workspace-erasure";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("pre-freeze construction optimality runtime contracts", () => {
	it("accepts custom-field options exactly when the immutable type is select", () => {
		expect(
			CreateFieldBody.safeParse({
				name: "Tier",
				type: "select",
			}).success,
		).toBe(false);
		expect(
			CreateFieldBody.safeParse({
				name: "Nickname",
				type: "text",
				options: ["VIP"],
			}).success,
		).toBe(false);
		expect(
			CreateFieldBody.safeParse({
				name: "Tier",
				type: "select",
				options: ["VIP"],
			}).success,
		).toBe(true);
		expect(UpdateFieldBody.safeParse({ options: [] }).success).toBe(false);
	});

	it("rejects social-account identity on accountless trigger kinds", () => {
		expect(
			EntrypointCreateSchema.safeParse({
				channel: "instagram",
				kind: "schedule",
				social_account_id: "acc_123",
				config: { cron: "0 9 * * *", timezone: "UTC" },
			}).success,
		).toBe(false);
		expect(
			EntrypointCreateSchema.safeParse({
				channel: "instagram",
				kind: "dm_received",
				social_account_id: "acc_123",
				config: {},
			}).success,
		).toBe(true);
		expect(
			validateEntrypointConfig("schedule", {
				cron: "0 9 * * *",
				timezone: "UTC",
			}).success,
		).toBe(true);
	});

	it("exposes the exact typed webhook attempt without removing legacy success", () => {
		expect(
			WebhookLogEntry.safeParse({
				id: "log_1",
				webhook_id: "wh_1",
				delivery_id: null,
				event: "test",
				attempt_ordinal: 1,
				attempt_kind: "test",
				outcome: "succeeded",
				status_code: 204,
				response_time_ms: 5,
				success: true,
				error: null,
				payload: { test: true },
				created_at: new Date().toISOString(),
			}).success,
		).toBe(true);
	});

	it("writes explicit test and durable delivery attempt identities", async () => {
		const [routeSource, deliverySource] = await Promise.all([
			Bun.file(`${repoRoot}apps/api/src/routes/webhooks.ts`).text(),
			Bun.file(`${repoRoot}apps/api/src/services/webhook-delivery.ts`).text(),
		]);
		expect(routeSource).toContain('attemptKind: "test"');
		expect(routeSource).toContain("attemptOrdinal: 1");
		expect(routeSource).toContain("deliveryId: null");
		expect(deliverySource).toContain('attemptKind: "delivery"');
		expect(deliverySource).toContain(
			"const attemptOrdinal = delivery.attempts + 1",
		);
		expect(deliverySource).toContain('outcome: "unknown"');
	});

	it("enforces immutable custom-field type on PATCH", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/routes/custom-fields.ts`,
		).text();
		expect(source).toContain("type: customFieldDefinitions.type");
		expect(source).toContain("Options are allowed only for select fields");
	});

	it("projects idea-tag scope only from its parent idea", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/routes/ideas.ts`,
		).text();
		expect(source).not.toContain("ideaTags.workspaceId");
		expect(source).not.toContain("scoped_idea_tags.workspace_id");
		expect(source).toContain("scopeKey: row.scopeKey");
		expect(source).toContain("scopeKey: current.scopeKey");
		expect(WORKSPACE_PURGE_TABLES).not.toContain("idea_tags");
	});

	it("projects organization and scope on every scheduled-job writer", async () => {
		const [runner, scheduler, webhookReceiver] = await Promise.all([
			Bun.file(`${repoRoot}apps/api/src/services/automations/runner.ts`).text(),
			Bun.file(
				`${repoRoot}apps/api/src/services/automations/scheduler.ts`,
			).text(),
			Bun.file(
				`${repoRoot}apps/api/src/services/automations/webhook-receiver.ts`,
			).text(),
		]);
		for (const source of [runner, scheduler, webhookReceiver]) {
			expect(source).toContain("organizationId:");
			expect(source).toContain("scopeKey:");
		}
	});

	it("creates the attempt before writing each locked current-attempt projection", async () => {
		const [publisher, threadPublisher, retention] = await Promise.all([
			Bun.file(`${repoRoot}apps/api/src/services/publisher-runner.ts`).text(),
			Bun.file(`${repoRoot}apps/api/src/services/thread-publisher.ts`).text(),
			Bun.file(
				`${repoRoot}apps/api/src/services/executable-retention.ts`,
			).text(),
		]);
		for (const source of [publisher, threadPublisher]) {
			const claim = source.indexOf('.for("update")');
			const attempt = source.indexOf("tx.insert(publishAttempts)", claim);
			const projection = source.indexOf(".update(postTargets)", attempt);
			expect(claim).toBeGreaterThan(-1);
			expect(attempt).toBeGreaterThan(claim);
			expect(projection).toBeGreaterThan(attempt);
			expect(source).toContain(
				"Superseded before the provider request boundary",
			);
		}
		expect(retention).toContain("target.attempt_id IS DISTINCT FROM item.id");
	});
});
