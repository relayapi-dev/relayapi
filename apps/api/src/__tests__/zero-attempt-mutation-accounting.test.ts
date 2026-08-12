import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { MutationEffectTracker } from "../lib/mutation-effect";
import admin from "../routes/admin";
import byos from "../routes/byos";
import emailIntents from "../routes/email-intents";
import organizations from "../routes/organizations";
import type { Env, Variables } from "../types";

type App = OpenAPIHono<{ Bindings: Env; Variables: Variables }>;

function tracker(): MutationEffectTracker {
	const value = new MutationEffectTracker();
	value.markRouteEntered();
	return value;
}

function expectNotApplied(value: MutationEffectTracker): void {
	expect(value.routeAuthoritativeOutcome(1)).toEqual({ kind: "not_applied" });
	expect(value.outcome(1)).toEqual({ kind: "not_applied" });
}

function noStagedByosDb(): Variables["db"] {
	const responses = [
		[
			{
				id: "key_byos",
				referenceId: null,
				principalId: "prn_byos",
				enabled: true,
				expiresAt: null,
				permissions: "write",
			},
		],
		[
			{
				id: "prn_byos",
				kind: "service",
				memberId: null,
				scopeMode: "all",
				lifecycleStatus: "active",
			},
		],
		[{ id: "org_byos", lifecycleStatus: "active" }],
		[],
	];
	let selectCall = 0;
	const tx = {
		execute: async () => undefined,
		select: () => {
			const response = responses[selectCall++] ?? [];
			// biome-ignore lint/suspicious/noExplicitAny: minimal Drizzle transaction double
			const query: any = {
				where: () => query,
				orderBy: () => query,
				for: () => query,
				limit: async () => response,
			};
			return { from: () => query };
		},
	};
	return {
		transaction: async <T>(callback: (value: typeof tx) => Promise<T>) =>
			callback(tx),
	} as unknown as Variables["db"];
}

function emptyActorDb(): Variables["db"] {
	// biome-ignore lint/suspicious/noExplicitAny: minimal Drizzle selection double
	const query: any = {
		leftJoin: () => query,
		where: () => query,
		limit: async () => [],
	};
	return {
		select: () => ({ from: () => query }),
	} as unknown as Variables["db"];
}

describe("zero-attempt mutation accounting runtime", () => {
	it("releases an admin authorization rejection", async () => {
		const evidence = tracker();
		const app: App = new OpenAPIHono();
		app.use("*", async (c, next) => {
			c.set("principalType", "service");
			c.set("principalUserId", null);
			c.set("mutationEffectTracker", evidence);
			await next();
		});
		app.route("/v1/admin", admin);

		const response = await app.request(
			"/v1/admin/organizations/org_target",
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "No mutation" }),
			},
			{} as Env,
		);

		expect(response.status).toBe(403);
		expectNotApplied(evidence);
	});

	it("releases an email-intent principal rejection", async () => {
		const evidence = tracker();
		const app: App = new OpenAPIHono();
		app.use("*", async (c, next) => {
			c.set("orgId", "org_email");
			c.set("principalType", "service");
			c.set("principalUserId", null);
			c.set("mutationEffectTracker", evidence);
			await next();
		});
		app.route("/v1", emailIntents);

		const response = await app.request(
			"/v1/invitations/inv_1/resend",
			{
				method: "POST",
				headers: { "idempotency-key": "email-test-1" },
			},
			{} as Env,
		);

		expect(response.status).toBe(403);
		expectNotApplied(evidence);
	});

	it("releases a BYOS not-found rejection before S3 egress", async () => {
		const evidence = tracker();
		const app: App = new OpenAPIHono();
		app.use("*", async (c, next) => {
			c.set("orgId", "org_byos");
			c.set("keyId", "key_byos");
			c.set("keyHash", "hash_byos");
			c.set("principalId", "prn_byos");
			c.set("principalType", "service");
			c.set("principalUserId", null);
			c.set("permissions", ["write"]);
			c.set("workspaceScope", "all");
			c.set("mutationEffectTracker", evidence);
			c.set("db", noStagedByosDb());
			await next();
		});
		app.route("/v1/byos", byos);

		const response = await app.request(
			"/v1/byos/test",
			{ method: "POST" },
			{} as Env,
		);

		expect(response.status).toBe(404);
		expectNotApplied(evidence);
	});

	it("releases an organization-deletion authorization rejection", async () => {
		const evidence = tracker();
		const app: App = new OpenAPIHono();
		app.use("*", async (c, next) => {
			c.set("orgId", "org_caller");
			c.set("keyId", "key_caller");
			c.set("permissions", ["write"]);
			c.set("workspaceScope", "all");
			c.set("mutationEffectTracker", evidence);
			c.set("db", emptyActorDb());
			await next();
		});
		app.route("/v1/organizations", organizations);

		const response = await app.request(
			"/v1/organizations/org_target",
			{ method: "DELETE" },
			{} as Env,
		);

		expect(response.status).toBe(403);
		expectNotApplied(evidence);
	});

	it("releases shared write and all-workspace permission denials", async () => {
		const readOnlyEvidence = tracker();
		const readOnlyApp: App = new OpenAPIHono();
		readOnlyApp.use("*", async (c, next) => {
			c.set("permissions", ["read"]);
			c.set("workspaceScope", "all");
			c.set("mutationEffectTracker", readOnlyEvidence);
			await next();
		});
		readOnlyApp.route("/v1/organizations", organizations);
		const readOnlyResponse = await readOnlyApp.request(
			"/v1/organizations/org_target",
			{ method: "DELETE" },
			{} as Env,
		);
		expect(readOnlyResponse.status).toBe(403);
		expectNotApplied(readOnlyEvidence);

		const scopedEvidence = tracker();
		const scopedApp: App = new OpenAPIHono();
		scopedApp.use("*", async (c, next) => {
			c.set("workspaceScope", ["ws_limited"]);
			c.set("mutationEffectTracker", scopedEvidence);
			await next();
		});
		scopedApp.route("/v1/byos", byos);
		const scopedResponse = await scopedApp.request(
			"/v1/byos/test",
			{ method: "POST" },
			{} as Env,
		);
		expect(scopedResponse.status).toBe(403);
		expectNotApplied(scopedEvidence);
	});
});

function handler(source: string, start: string, end: string): string {
	const startAt = source.indexOf(start);
	const endAt = source.indexOf(end, startAt + start.length);
	expect(startAt).toBeGreaterThanOrEqual(0);
	expect(endAt).toBeGreaterThan(startAt);
	return source.slice(startAt, endAt);
}

function markerCount(source: string): number {
	return source.match(/markMutationInputNotApplied\(c\)/g)?.length ?? 0;
}

describe("zero-attempt mutation accounting source enumeration", () => {
	it("enumerates every safe rejection in the requested route set", async () => {
		const [
			adminSource,
			emailSource,
			byosSource,
			organizationSource,
			permissionsSource,
		] = await Promise.all([
			Bun.file(new URL("../routes/admin.ts", import.meta.url)).text(),
			Bun.file(new URL("../routes/email-intents.ts", import.meta.url)).text(),
			Bun.file(new URL("../routes/byos.ts", import.meta.url)).text(),
			Bun.file(new URL("../routes/organizations.ts", import.meta.url)).text(),
			Bun.file(new URL("../middleware/permissions.ts", import.meta.url)).text(),
		]);

		const enumerated = [
			{
				name: "admin authorization middleware",
				source: handler(
					adminSource,
					'app.use("*", async (c, next)',
					"const AdminOrganizationListQuery",
				),
				markers: 2,
			},
			{
				name: "admin organization update",
				source: handler(
					adminSource,
					"app.openapi(updateOrganization",
					"const listSubscriptions",
				),
				markers: 2,
			},
			{
				name: "admin subscription update",
				source: handler(
					adminSource,
					"app.openapi(updateSubscription",
					"const AdminAutomationWebhookFailureListQuery",
				),
				markers: 3,
			},
			{
				name: "admin operator resolution",
				source: handler(
					adminSource,
					"app.openapi(resolveOperatorResolutionRoute",
					"const AdminErasureHoldListQuery",
				),
				markers: 5,
			},
			{
				name: "admin erasure-hold creation",
				source: handler(
					adminSource,
					"app.openapi(createErasureHold",
					"const releaseErasureHoldRoute",
				),
				markers: 5,
			},
			{
				name: "admin erasure-hold release",
				source: handler(
					adminSource,
					"app.openapi(releaseErasureHoldRoute",
					"export default app",
				),
				markers: 4,
			},
			{
				name: "invitation resend",
				source: handler(
					emailSource,
					"app.openapi(resendInvitation",
					"app.openapi(createOnDemandPlatformRequest",
				),
				markers: 3,
			},
			{
				name: "on-demand platform request",
				source: handler(
					emailSource,
					"app.openapi(createOnDemandPlatformRequest",
					"export default app",
				),
				markers: 2,
			},
			{
				name: "BYOS test",
				source: handler(
					byosSource,
					"app.openapi(testConfig",
					"const deleteConfig",
				),
				markers: 3,
			},
			{
				name: "organization deletion",
				source: handler(
					organizationSource,
					"app.openapi(deleteOrganization",
					"export default app",
				),
				markers: 3,
			},
			{
				name: "shared write permission",
				source: handler(
					permissionsSource,
					"export const requireWriteAccessMiddleware",
					"export const requireAllWorkspaceScopeMiddleware",
				),
				markers: 1,
			},
			{
				name: "shared all-workspace permission",
				source: handler(
					permissionsSource,
					"export const requireAllWorkspaceScopeMiddleware",
					"/** API-key administration",
				),
				markers: 1,
			},
			{
				name: "shared API-key-management permission",
				source: handler(
					permissionsSource,
					"export const requireManageApiKeysMiddleware",
					"export type FinancialPermission",
				),
				markers: 1,
			},
			{
				name: "shared live financial permission",
				source: handler(
					permissionsSource,
					"function financialPermissionMiddleware",
					"export const requireViewBillingMiddleware",
				),
				markers: 1,
			},
		];

		for (const item of enumerated) {
			expect(markerCount(item.source), item.name).toBe(item.markers);
		}
	});

	it("keeps every post-boundary or unclassified failure ambiguous", async () => {
		const [adminSource, emailSource, byosSource, organizationSource] =
			await Promise.all([
				Bun.file(new URL("../routes/admin.ts", import.meta.url)).text(),
				Bun.file(new URL("../routes/email-intents.ts", import.meta.url)).text(),
				Bun.file(new URL("../routes/byos.ts", import.meta.url)).text(),
				Bun.file(new URL("../routes/organizations.ts", import.meta.url)).text(),
			]);

		const organizationUpdate = handler(
			adminSource,
			"app.openapi(updateOrganization",
			"const listSubscriptions",
		);
		expect(
			organizationUpdate.slice(
				organizationUpdate.indexOf("const invalidations ="),
			),
		).not.toContain("markMutationInputNotApplied(c)");

		const subscriptionUpdate = handler(
			adminSource,
			"app.openapi(updateSubscription",
			"const AdminAutomationWebhookFailureListQuery",
		);
		expect(
			subscriptionUpdate.slice(
				subscriptionUpdate.indexOf("const invalidations ="),
			),
		).not.toContain("markMutationInputNotApplied(c)");

		const onDemand = handler(
			emailSource,
			"app.openapi(createOnDemandPlatformRequest",
			"export default app",
		);
		expect(
			onDemand.slice(onDemand.indexOf("await stageOnDemandPlatformRequest")),
		).not.toContain("markMutationInputNotApplied(c)");

		const byosTest = handler(
			byosSource,
			"app.openapi(testConfig",
			"const deleteConfig",
		);
		const activationConflict = handler(
			byosTest,
			"if (error instanceof ByosActivationConflictError)",
			"throw error",
		);
		expect(activationConflict).not.toContain("markMutationInputNotApplied(c)");

		const organizationDelete = handler(
			organizationSource,
			"app.openapi(deleteOrganization",
			"export default app",
		);
		const invalidationBoundary =
			organizationDelete.indexOf("async (pending) =>");
		const notFoundCatch = organizationDelete.indexOf(
			"if (error instanceof TenantDeletionNotFoundError)",
		);
		expect(invalidationBoundary).toBeGreaterThan(-1);
		expect(notFoundCatch).toBeGreaterThan(invalidationBoundary);
		expect(
			organizationDelete.slice(
				organizationDelete.lastIndexOf("throw error") - 5,
			),
		).not.toContain("markMutationInputNotApplied(c)");
	});
});
