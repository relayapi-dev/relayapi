import { describe, expect, it } from "bun:test";
import { DASHBOARD_SESSION_AUTHORITY_HEADER } from "@relayapi/config";
import {
	createDurableCredentialAuthoritySnapshot,
	lockDurableCredentialAuthorityInTransaction,
	withCredentialMutationAuthority,
	withCredentialMutationAuthorityInTransaction,
} from "../lib/credential-mutation-authority";

interface AuthorityFixture {
	principalType: "dashboard_user" | "service";
	permissions: string[];
	responses: unknown[][];
	sessionId?: string;
	workspaceScope?: "all" | string[];
}

function authorityContext(fixture: AuthorityFixture) {
	let inTransaction = false;
	let selectCall = 0;
	const tx = {
		select: () => {
			const response = fixture.responses[selectCall++] ?? [];
			const query = {} as {
				from: () => typeof query;
				where: () => typeof query;
				orderBy: () => typeof query;
				for: () => typeof query;
				limit: () => Promise<unknown[]>;
				then: PromiseLike<unknown[]>["then"];
			};
			query.from = () => query;
			query.where = () => query;
			query.orderBy = () => query;
			query.for = () => query;
			query.limit = async () => response;
			// biome-ignore lint/suspicious/noThenProperty: Drizzle select builders are intentionally awaitable before or after limit().
			query.then = (onfulfilled, onrejected) =>
				Promise.resolve(response).then(onfulfilled, onrejected);
			return query;
		},
	};
	const values = {
		orgId: "org_authority",
		keyId: "key_authority",
		keyHash: "hash_authority",
		principalId: "prn_authority",
		principalType: fixture.principalType,
		principalUserId:
			fixture.principalType === "dashboard_user" ? "usr_authority" : null,
		permissions: fixture.permissions,
		workspaceScope: fixture.workspaceScope ?? ("all" as const),
		db: {
			transaction: async (callback: (scope: unknown) => Promise<unknown>) => {
				inTransaction = true;
				try {
					return await callback(tx);
				} finally {
					inTransaction = false;
				}
			},
		},
	};
	return {
		context: {
			get: (name: keyof typeof values) => values[name],
			req: {
				header: (name: string) =>
					name === DASHBOARD_SESSION_AUTHORITY_HEADER
						? fixture.sessionId
						: undefined,
			},
		} as never,
		transaction: tx as never,
		inTransaction: () => inTransaction,
		selectCalls: () => selectCall,
	};
}

const dashboardPermissions = [
	"read",
	"write",
	"manage_api_keys",
	"manage_spend",
];

function dashboardResponses(sessionRows: unknown[]) {
	return [
		[
			{
				id: "usr_authority",
				banned: false,
				banExpires: null,
				credentialVersion: "generation-1",
			},
		],
		[{ id: "mem_authority", userId: "usr_authority", role: "admin" }],
		[{ id: "org_authority", lifecycleStatus: "active" }],
		[
			{
				id: "key_authority",
				referenceId: "usr_authority",
				principalId: "prn_authority",
				credentialVersion: "generation-1",
				enabled: true,
				expiresAt: null,
				permissions: dashboardPermissions.join(","),
			},
		],
		[
			{
				id: "prn_authority",
				kind: "member",
				memberId: "mem_authority",
				scopeMode: "all",
				lifecycleStatus: "active",
			},
		],
		sessionRows.map((row) => ({
			impersonatedBy: null,
			expiresAt: new Date("2999-01-01T00:00:00Z"),
			...(row as Record<string, unknown>),
		})),
	];
}

function queuedTransaction(responses: unknown[][]) {
	let selectCall = 0;
	const locks: string[] = [];
	const tx = {
		select: () => {
			const response = responses[selectCall++] ?? [];
			const query = {} as {
				from: () => typeof query;
				where: () => typeof query;
				orderBy: () => typeof query;
				for: (mode: string) => typeof query;
				limit: () => Promise<unknown[]>;
				then: PromiseLike<unknown[]>["then"];
			};
			query.from = () => query;
			query.where = () => query;
			query.orderBy = () => query;
			query.for = (mode) => {
				locks.push(mode);
				return query;
			};
			query.limit = async () => response;
			// biome-ignore lint/suspicious/noThenProperty: Drizzle select builders are intentionally awaitable.
			query.then = (onfulfilled, onrejected) =>
				Promise.resolve(response).then(onfulfilled, onrejected);
			return query;
		},
	};
	return {
		transaction: tx as never,
		locks,
		selectCalls: () => selectCall,
	};
}

const durableDashboardSnapshot = {
	organizationId: "org_authority",
	keyId: "key_authority",
	principalId: "prn_authority",
	principalType: "dashboard_user" as const,
	userId: "usr_authority",
	authorityMemberId: "mem_authority",
	credentialVersion: "generation-1",
	authoritySessionId: "session_authority",
	authorityWorkspaceId: "ws_selected",
	authorityRequiresAllWorkspaceScope: false,
	admittedAt: new Date("2026-08-03T10:00:00.000Z"),
	revision: 1,
};

function durableDashboardResponses(options?: {
	grants?: unknown[];
	memberId?: string;
	sessions?: unknown[];
}) {
	const memberId = options?.memberId ?? "mem_authority";
	return [
		[{ referenceId: "usr_authority", principalId: "prn_authority" }],
		[{ kind: "member", memberId }],
		[
			{
				id: "usr_authority",
				banned: false,
				banExpires: null,
				credentialVersion: "generation-1",
			},
		],
		[
			{
				id: memberId,
				role: "admin",
				userId: "usr_authority",
				organizationId: "org_authority",
			},
		],
		[{ id: "org_authority", lifecycleStatus: "active" }],
		[
			{
				id: "key_authority",
				referenceId: "usr_authority",
				principalId: "prn_authority",
				credentialVersion: "generation-1",
				enabled: true,
				expiresAt: null,
				permissions: dashboardPermissions.join(","),
			},
		],
		[
			{
				id: "prn_authority",
				kind: "member",
				memberId,
				scopeMode: "selected",
				lifecycleStatus: "active",
			},
		],
		options?.grants ?? [{ workspaceId: "ws_selected" }],
		options?.sessions ?? [
			{
				id: "session_authority",
				userId: "usr_authority",
				activeOrganizationId: "org_authority",
				impersonatedBy: null,
				expiresAt: new Date("2999-01-01T00:00:00Z"),
			},
		],
	];
}

describe("credential mutation authority", () => {
	it("binds durable admission to the exact selected workspace or all-workspace authority", () => {
		const authority = {
			organizationId: "org_authority",
			keyId: "key_authority",
			principalId: "prn_authority",
			principalType: "service" as const,
			userId: null,
			memberId: null,
			credentialVersion: "generation-1",
			sessionId: null,
			memberRole: null,
			globalRole: null,
			permissions: ["read", "write", "manage_spend"],
			workspaceScope: ["ws_selected"],
		};
		expect(
			createDurableCredentialAuthoritySnapshot(authority, {
				workspaceId: "ws_selected",
			}),
		).toMatchObject({
			authorityWorkspaceId: "ws_selected",
			authorityRequiresAllWorkspaceScope: false,
		});
		expect(() =>
			createDurableCredentialAuthoritySnapshot(authority, {
				workspaceId: "ws_revoked",
			}),
		).toThrow("does not include the operation workspace");
		expect(() =>
			createDurableCredentialAuthoritySnapshot(authority, {
				workspaceId: null,
			}),
		).toThrow("requires all-workspace scope");
	});

	it("rejects a durable principal rebound to a different membership row", async () => {
		const fixture = queuedTransaction(
			durableDashboardResponses({ memberId: "mem_rebound" }),
		);
		const result = await lockDurableCredentialAuthorityInTransaction(
			fixture.transaction,
			durableDashboardSnapshot,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("CREDENTIAL_NO_LONGER_AUTHORIZED");
		}
		expect(fixture.selectCalls()).toBe(2);
	});

	it("locks and accepts the exact live dashboard session and workspace at the boundary", async () => {
		const fixture = queuedTransaction(durableDashboardResponses());
		const result = await lockDurableCredentialAuthorityInTransaction(
			fixture.transaction,
			durableDashboardSnapshot,
			{ requiredFinancialPermission: "manage_spend" },
		);

		expect(result).toEqual({ ok: true, value: durableDashboardSnapshot });
		expect(fixture.selectCalls()).toBe(9);
		// User, membership, organization, key, principal, grant and session remain
		// share-locked until the caller commits its operation CAS.
		expect(fixture.locks).toHaveLength(7);
		expect(fixture.locks.every((mode) => mode === "share")).toBe(true);
	});

	it("fails revoke-first when session, workspace, or impersonation authority is invalid", async () => {
		for (const responses of [
			durableDashboardResponses({ sessions: [] }),
			durableDashboardResponses({ grants: [] }),
			durableDashboardResponses({
				sessions: [
					{
						id: "session_authority",
						userId: "usr_authority",
						activeOrganizationId: "org_authority",
						impersonatedBy: "usr_global_admin",
						expiresAt: new Date("2999-01-01T00:00:00Z"),
					},
				],
			}),
			durableDashboardResponses({
				sessions: [
					{
						id: "session_authority",
						userId: "usr_authority",
						activeOrganizationId: "org_authority",
						impersonatedBy: null,
						expiresAt: new Date("2000-01-01T00:00:00Z"),
					},
				],
			}),
		]) {
			const fixture = queuedTransaction(responses);
			const result = await lockDurableCredentialAuthorityInTransaction(
				fixture.transaction,
				durableDashboardSnapshot,
				{ requiredFinancialPermission: "manage_spend" },
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.code).toBe("CREDENTIAL_NO_LONGER_AUTHORIZED");
			}
		}
	});

	it("requires the exact live dashboard session before running the mutation", async () => {
		const fixture = authorityContext({
			principalType: "dashboard_user",
			permissions: dashboardPermissions,
			sessionId: "session_authority",
			responses: dashboardResponses([
				{
					id: "session_authority",
					userId: "usr_authority",
					activeOrganizationId: "org_authority",
				},
			]),
		});
		let called = false;
		const result = await withCredentialMutationAuthority(
			fixture.context,
			{},
			async () => {
				called = true;
				expect(fixture.inTransaction()).toBe(true);
				return "committed";
			},
		);

		expect(result).toEqual({ ok: true, value: "committed" });
		expect(called).toBe(true);
		expect(fixture.inTransaction()).toBe(false);
		expect(fixture.selectCalls()).toBe(6);
	});

	it("rejects a deleted dashboard session without running the mutation", async () => {
		const fixture = authorityContext({
			principalType: "dashboard_user",
			permissions: dashboardPermissions,
			sessionId: "session_deleted",
			responses: dashboardResponses([]),
		});
		let called = false;
		const result = await withCredentialMutationAuthority(
			fixture.context,
			{},
			async () => {
				called = true;
			},
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(401);
		expect(called).toBe(false);
	});

	it("rejects a session bound to another user or organization", async () => {
		for (const sessionRow of [
			{
				id: "session_wrong_user",
				userId: "usr_other",
				activeOrganizationId: "org_authority",
			},
			{
				id: "session_wrong_org",
				userId: "usr_authority",
				activeOrganizationId: "org_other",
			},
		]) {
			const fixture = authorityContext({
				principalType: "dashboard_user",
				permissions: dashboardPermissions,
				sessionId: sessionRow.id,
				responses: dashboardResponses([sessionRow]),
			});
			let called = false;
			const result = await withCredentialMutationAuthority(
				fixture.context,
				{},
				async () => {
					called = true;
				},
			);
			expect(result.ok).toBe(false);
			expect(called).toBe(false);
		}
	});

	it("rejects an impersonated dashboard session before durable mutation", async () => {
		const fixture = authorityContext({
			principalType: "dashboard_user",
			permissions: dashboardPermissions,
			sessionId: "session_impersonated",
			responses: dashboardResponses([
				{
					id: "session_impersonated",
					userId: "usr_authority",
					activeOrganizationId: "org_authority",
					impersonatedBy: "usr_global_admin",
				},
			]),
		});
		let called = false;
		const result = await withCredentialMutationAuthority(
			fixture.context,
			{},
			async () => {
				called = true;
			},
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(401);
		expect(called).toBe(false);
	});

	it("leaves service issuers header-free but rejects live permission drift", async () => {
		const serviceRows = (permissions: string) => [
			[
				{
					id: "key_authority",
					referenceId: null,
					principalId: "prn_authority",
					enabled: true,
					expiresAt: null,
					permissions,
				},
			],
			[
				{
					id: "prn_authority",
					kind: "service",
					memberId: null,
					scopeMode: "all",
					lifecycleStatus: "active",
				},
			],
			[{ id: "org_authority", lifecycleStatus: "active" }],
		];

		const live = authorityContext({
			principalType: "service",
			permissions: ["read", "write"],
			responses: serviceRows("read,write"),
		});
		let liveCalled = false;
		const liveResult = await withCredentialMutationAuthority(
			live.context,
			{},
			async () => {
				liveCalled = true;
			},
		);
		expect(liveResult.ok).toBe(true);
		expect(liveCalled).toBe(true);

		const drifted = authorityContext({
			principalType: "service",
			permissions: ["read", "write"],
			responses: serviceRows("read"),
		});
		let driftedCalled = false;
		const driftedResult = await withCredentialMutationAuthority(
			drifted.context,
			{},
			async () => {
				driftedCalled = true;
			},
		);
		expect(driftedResult.ok).toBe(false);
		expect(driftedCalled).toBe(false);
	});

	it("can fence a caller-owned admission transaction without nesting it", async () => {
		const fixture = authorityContext({
			principalType: "service",
			permissions: ["read", "write"],
			responses: [
				[
					{
						id: "key_authority",
						referenceId: null,
						principalId: "prn_authority",
						enabled: true,
						expiresAt: null,
						permissions: "read,write",
					},
				],
				[
					{
						id: "prn_authority",
						kind: "service",
						memberId: null,
						scopeMode: "all",
						lifecycleStatus: "active",
					},
				],
				[{ id: "org_authority", lifecycleStatus: "active" }],
			],
		});
		let called = false;
		const result = await withCredentialMutationAuthorityInTransaction(
			fixture.context,
			{},
			fixture.transaction,
			async (tx) => {
				called = true;
				expect(tx).toBe(fixture.transaction);
				return "admitted";
			},
		);

		expect(result).toEqual({ ok: true, value: "admitted" });
		expect(called).toBe(true);
	});

	it("rejects organization-global mutations from a selected-workspace issuer", async () => {
		const fixture = authorityContext({
			principalType: "service",
			permissions: ["read", "write"],
			workspaceScope: ["ws_selected"],
			responses: [
				[
					{
						id: "key_authority",
						referenceId: null,
						principalId: "prn_authority",
						enabled: true,
						expiresAt: null,
						permissions: "read,write",
					},
				],
				[
					{
						id: "prn_authority",
						kind: "service",
						memberId: null,
						scopeMode: "selected",
						lifecycleStatus: "active",
					},
				],
				[{ id: "org_authority", lifecycleStatus: "active" }],
				[{ workspaceId: "ws_selected" }],
			],
		});
		let called = false;
		const result = await withCredentialMutationAuthority(
			fixture.context,
			{ requireAllWorkspaceScope: true },
			async () => {
				called = true;
			},
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(403);
			expect(result.code).toBe("ALL_WORKSPACES_REQUIRED");
		}
		expect(called).toBe(false);
	});
});
