import { describe, expect, it } from "bun:test";
import { resolveInboxTarget } from "../routes/inbox-helpers";
import { automationMessageDeliveryError } from "../services/automations/nodes/message";
import { combineSchedulePredicateSets } from "../services/automations/scheduler";

function targetDb(rows: unknown[]) {
	const chain = {
		from: () => chain,
		innerJoin: () => chain,
		leftJoin: () => chain,
		where: () => chain,
		limit: async () => rows,
	};
	return { select: () => chain };
}

const conversation = {
	id: "conv_a",
	organizationId: "org_1",
	workspaceId: "ws_a",
	scopeKey: "ws_a",
	accountId: "acc_a",
	platform: "telegram",
	platformConversationId: "chat_a",
};
const account = {
	id: "acc_a",
	organizationId: "org_1",
	workspaceId: "ws_a",
	scopeKey: "ws_a",
	platform: "telegram",
	lifecycleStatus: "active",
	accessToken: null,
};

describe("high-risk schema flow guards", () => {
	it("never lets the compatibility account id select an inbox target", async () => {
		const resolved = await resolveInboxTarget(
			targetDb([{ conversation, account, message: null }]) as never,
			{
				conversationId: conversation.id,
				organizationId: conversation.organizationId,
				workspaceScope: [conversation.workspaceId],
				assertedAccountId: "acc_other",
			},
		);

		expect(resolved).toBeNull();
	});

	it("rejects an ambiguous provider conversation id", async () => {
		const resolved = await resolveInboxTarget(
			targetDb([
				{ conversation, account, message: null },
				{
					conversation: { ...conversation, id: "conv_b" },
					account: { ...account, id: "acc_b" },
					message: null,
				},
			]) as never,
			{
				conversationId: conversation.platformConversationId,
				organizationId: conversation.organizationId,
				workspaceScope: [conversation.workspaceId],
			},
		);

		expect(resolved).toBeNull();
	});

	it("shares organization-scoped inbox targets only with non-empty scopes", async () => {
		const globalConversation = {
			...conversation,
			workspaceId: null,
			scopeKey: "org",
		};
		const globalAccount = { ...account, workspaceId: null, scopeKey: "org" };
		await expect(
			resolveInboxTarget(
				targetDb([
					{
						conversation: globalConversation,
						account: globalAccount,
						message: null,
					},
				]) as never,
				{
					conversationId: globalConversation.id,
					organizationId: globalConversation.organizationId,
					workspaceScope: ["ws_a"],
				},
			),
		).resolves.toMatchObject({ conversation: { workspaceId: null } });
		await expect(
			resolveInboxTarget(
				targetDb([
					{
						conversation: globalConversation,
						account: globalAccount,
						message: null,
					},
				]) as never,
				{
					conversationId: globalConversation.id,
					organizationId: globalConversation.organizationId,
					workspaceScope: [],
				},
			),
		).resolves.toBeNull();
	});

	it("does not advance or wait after full, partial, or zero delivery", () => {
		expect(
			automationMessageDeliveryError({
				sent: [],
				errors: [{ blockId: "a", error: "provider failed" }],
			}),
		).toBeInstanceOf(Error);
		expect(
			automationMessageDeliveryError({
				sent: [{ skipped: false }],
				errors: [{ blockId: "b", error: "provider failed" }],
			}),
		).toBeInstanceOf(Error);
		expect(
			automationMessageDeliveryError({
				sent: [{ skipped: true }],
				errors: [],
			}),
		).toBeInstanceOf(Error);
		expect(
			automationMessageDeliveryError({
				sent: [{ skipped: false }],
				errors: [],
			}),
		).toBeNull();
	});

	it("implements scheduled all as intersection and any as union", () => {
		expect(
			combineSchedulePredicateSets(
				[new Set(["a", "b"]), new Set(["b", "c"])],
				[],
			),
		).toEqual(["b"]);
		expect(
			new Set(
				combineSchedulePredicateSets([], [new Set(["a"]), new Set(["b", "c"])]),
			),
		).toEqual(new Set(["a", "b", "c"]));
		expect(
			combineSchedulePredicateSets(
				[new Set(["a", "b", "c"])],
				[new Set(["b"]), new Set(["d"])],
			),
		).toEqual(["b"]);
	});

	it("keeps inbox message insertion and projection repair in one transaction", async () => {
		const source = await Bun.file(
			new URL("../services/inbox-persistence.ts", import.meta.url),
		).text();
		const insertStart = source.indexOf("export async function insertMessage");
		const listStart = source.indexOf("export async function listConversations");
		const implementation = source.slice(insertStart, listStart);

		expect(implementation).toContain("return db.transaction(async (tx) =>");
		expect(implementation).toContain("WITH stats AS");
		expect(implementation).toContain("message_count = stats.message_count");
	});

	it("resolves every inbox provider target before the first provider call", async () => {
		const source = await Bun.file(
			new URL("../routes/inbox-feed.ts", import.meta.url),
		).text();
		for (const [startMarker, endMarker] of [
			["app.openapi(sendMessageRoute", "const sendTypingRoute"],
			["app.openapi(sendTypingRoute", "const ConversationMessageIdParam"],
			["app.openapi(addReactionRoute", "const removeReactionRoute"],
			["app.openapi(removeReactionRoute", "const deleteMessageRoute"],
			["app.openapi(deleteMessageRoute", "const listNotesRoute"],
		] as const) {
			const start = source.indexOf(startMarker);
			const end = source.indexOf(endMarker, start);
			const handler = source.slice(start, end);
			expect(handler.indexOf("resolveInboxTarget(")).toBeGreaterThan(-1);
			expect(handler.indexOf("fetch(")).toBeGreaterThan(
				handler.indexOf("resolveInboxTarget("),
			);
		}
	});

	it("validates prospective automation tuples before mutation", async () => {
		const [entrypoints, bindings, receiver] = await Promise.all([
			Bun.file(
				new URL("../routes/automation-entrypoints.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL("../routes/automation-bindings.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL("../services/automations/webhook-receiver.ts", import.meta.url),
			).text(),
		]);

		expect(entrypoints).toContain("const prospectiveAccountId =");
		expect(entrypoints).toContain(
			"account.workspaceId !== automation.workspaceId",
		);
		expect(bindings).toContain("const result = await db.transaction");
		expect(bindings).toContain('.for("update")');
		expect(bindings).toContain("account.platform !== automation.channel");
		expect(receiver).toContain(
			"eq(contactChannels.socialAccountId, scope.socialAccountId)",
		);
		expect(receiver).toContain("workspaceId: match.automation.workspaceId");
	});

	it("keeps post mutation and provider boundaries fenced", async () => {
		const [routes, runner, threadRunner, ...otherPostWriters] =
			await Promise.all([
				Bun.file(new URL("../routes/posts.ts", import.meta.url)).text(),
				Bun.file(
					new URL("../services/publisher-runner.ts", import.meta.url),
				).text(),
				Bun.file(
					new URL("../services/thread-publisher.ts", import.meta.url),
				).text(),
				...[
					"scheduler.ts",
					"post-publish-reconciler.ts",
					"analytics-refresh.ts",
					"tenant-deletion.ts",
				].map((file) =>
					Bun.file(new URL(`../services/${file}`, import.meta.url)).text(),
				),
			]);

		expect(routes).toContain("eq(posts.publishAttempts, 0)");
		expect(routes).toContain("eq(posts.revision, post.revision)");
		expect(routes).not.toContain("date_trunc('milliseconds'");
		expect(runner).toContain("eq(posts.revision, post.revision)");
		expect(threadRunner).toContain("eq(posts.revision, post.revision)");
		expect(runner).toContain("revision: sql`${posts.revision} + 1`");
		expect(threadRunner).toContain("revision: sql`${posts.revision} + 1`");
		for (const source of [routes, runner, threadRunner, ...otherPostWriters]) {
			expect(source.match(/\.update\(posts\)/g)?.length ?? 0).toBe(
				source.match(/revision: sql`\$\{posts\.revision\} \+ 1`/g)?.length ?? 0,
			);
		}
		expect(routes).toContain("Posts are immutable after publishing starts");
		expect(runner).toContain("PUBLISH_PARENT_LEASE_MS");
		expect(runner).toContain("leaseRenewedAt");
		expect(threadRunner).toContain("const renewExecutionLease");
		expect(
			threadRunner.match(/await renewExecutionLease\(\)/g)?.length ?? 0,
		).toBeGreaterThanOrEqual(2);
	});

	it("prohibits account graph splits and cross-workspace contact links", async () => {
		const [accounts, contacts, linker] = await Promise.all([
			Bun.file(new URL("../routes/accounts.ts", import.meta.url)).text(),
			Bun.file(new URL("../routes/contacts.ts", import.meta.url)).text(),
			Bun.file(
				new URL("../services/contact-linker.ts", import.meta.url),
			).text(),
		]);

		expect(accounts).toContain("ACCOUNT_WORKSPACE_GRAPH_EXISTS");
		for (const dependency of [
			"post_targets",
			"inbox_conversations",
			"contact_channels",
			"automation_entrypoints",
			"cross_post_actions",
		]) {
			expect(accounts).toContain(dependency);
		}
		expect(contacts).toContain("source.workspaceId !== target.workspaceId");
		expect(contacts).toContain(
			"segmentResult.segment.workspaceId !== contact.workspaceId",
		);
		expect(linker).toContain("const sameAccountWorkspace");
		expect(linker).toContain("contacts.emailCanonical");
	});

	it("serializes free-organization creation across the auth hook boundary", async () => {
		const [auth, schema] = await Promise.all([
			Bun.file(
				new URL("../../../../packages/auth/src/index.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL("../../../../packages/db/src/schema.ts", import.meta.url),
			).text(),
		]);

		expect(auth).toContain("pg_advisory_xact_lock");
		expect(auth).toContain("organizationCreationReservations");
		expect(auth).toContain(
			"expiresAt: new Date(now.getTime() + 10 * 60 * 1000)",
		);
		expect(schema).toContain("organizationCreationReservations");
		expect(schema).toContain(
			"organization_creation_reservation_user_slug_uniq",
		);
	});
});
