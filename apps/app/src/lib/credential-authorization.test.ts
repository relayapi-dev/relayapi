import { describe, expect, it } from "bun:test";
import { DASHBOARD_SESSION_AUTHORITY_HEADER } from "@relayapi/config";
import { POST as bootstrapDashboardKey } from "../pages/api/bootstrap-key";
import { GET as getDashboardKeyStatus } from "../pages/api/dashboard-key-status";
import {
	dashboardSessionRequestOptions,
	requireClient,
	requireOrganizationAdmin,
} from "./api-utils";
import {
	canManageOrganizationCredentials,
	getDashboardCredentialPermissions,
	hasCurrentDashboardCredentialPermissions,
} from "./credential-authorization";
import { encryptDashboardApiKey } from "./dashboard-key-envelope";

const DASHBOARD_CREDENTIAL_SECRET = `test-dashboard-secret-${"a".repeat(32)}`;

interface MockSelectQuery {
	leftJoin: () => MockSelectQuery;
	where: () => MockSelectQuery;
	limit: () => Promise<unknown[]>;
}

function orderedSelect(...responses: unknown[][]) {
	let call = 0;
	return () => {
		const query = {} as MockSelectQuery;
		query.leftJoin = () => query;
		query.where = () => query;
		query.limit = async () => responses[call++] ?? [];
		return { from: () => query };
	};
}

function existingMemberPrincipalSelect(
	memberId: string,
	principalId: string,
	userId: string,
	role: string,
	locksStaleCredential = false,
) {
	let authoritySelect = 0;
	const responses = [
		[{ id: memberId }],
		[{ id: principalId, scopeMode: "all" }],
		[
			{
				id: userId,
				banned: false,
				banExpires: null,
				credentialVersion: "legacy-v1",
			},
		],
		[{ id: memberId, role }],
		[{ id: `org_for_${memberId}`, lifecycleStatus: "active" }],
		...(locksStaleCredential ? [[{ id: `key_for_${memberId}` }]] : []),
		[
			{
				id: principalId,
				memberId,
				lifecycleStatus: "active",
			},
		],
	];
	return () => ({
		from: () => ({
			where: () => ({
				for: () => ({
					limit: async () => {
						const response = responses[authoritySelect] ?? [];
						authoritySelect += 1;
						return response;
					},
				}),
			}),
		}),
	});
}

describe("dashboard credential authorization", () => {
	it("derives mutation authority only from the server-resolved session", () => {
		const options = dashboardSessionRequestOptions({
			session: { id: "session_from_locals" },
		});
		expect(options).toEqual({
			headers: {
				[DASHBOARD_SESSION_AUTHORITY_HEADER]: "session_from_locals",
			},
		});
		expect(dashboardSessionRequestOptions({ session: null })).toBeNull();
		expect(dashboardSessionRequestOptions({ session: { id: 123 } })).toBeNull();
	});

	it("grants API-key administration only to organization owners and admins", () => {
		expect(canManageOrganizationCredentials("owner")).toBe(true);
		expect(getDashboardCredentialPermissions("owner")).toEqual([
			"read",
			"write",
			"manage_api_keys",
			"view_billing",
			"manage_billing",
			"manage_spend",
		]);
		expect(canManageOrganizationCredentials("admin")).toBe(true);
		expect(getDashboardCredentialPermissions("admin")).toEqual([
			"read",
			"write",
			"manage_api_keys",
			"manage_spend",
		]);

		expect(canManageOrganizationCredentials("member")).toBe(false);
		expect(canManageOrganizationCredentials("member,admin")).toBe(true);
		expect(getDashboardCredentialPermissions("member")).toEqual([
			"read",
			"write",
		]);
	});

	it("marks an admin dashboard key stale after the member is demoted", () => {
		expect(
			hasCurrentDashboardCredentialPermissions(
				"read,write,manage_api_keys",
				"member",
			),
		).toBe(false);
		expect(
			hasCurrentDashboardCredentialPermissions("read,write", "member"),
		).toBe(true);
	});

	it("rejects API-key management for an ordinary organization member", async () => {
		const denied = await requireOrganizationAdmin({
			locals: {
				user: { id: "user_123" },
				organization: { id: "org_123" },
				organizationMembershipRole: "member",
			},
		} as never);

		expect(denied).toBeInstanceOf(Response);
		expect(denied?.status).toBe(403);
	});

	it("fails closed before reading credentials without a live membership role", async () => {
		let credentialRead = false;
		const response = await bootstrapDashboardKey({
			locals: {
				user: { id: "user_123" },
				organization: { id: "org_123" },
				organizationMembershipRole: null,
				kv: {
					get: async () => {
						credentialRead = true;
						return null;
					},
				},
			},
		} as never);

		expect(response.status).toBe(403);
		expect(credentialRead).toBe(false);
	});

	it("automatically mints an ordinary member credential without API-key administration", async () => {
		let insertedValues: { permissions?: unknown } | undefined;
		let disabledCredentials = 0;
		let purgedExpiredCredentials = 0;
		const authoritySelect = existingMemberPrincipalSelect(
			"mem_123",
			"prn_123",
			"user_123",
			"member",
		);
		const kvWrites = new Map<string, string>();
		const response = await getDashboardKeyStatus({
			locals: {
				user: { id: "user_123" },
				organization: { id: "org_123" },
				organizationMembershipRole: "member",
				dashboardCredentialSecret: DASHBOARD_CREDENTIAL_SECRET,
				db: {
					select: orderedSelect([
						{
							status: "active",
							aiEnabled: true,
							dailyToolLimitOverride: 17,
						},
					]),
					transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
						callback({
							select: authoritySelect,
							delete: () => ({
								where: async () => {
									purgedExpiredCredentials += 1;
								},
							}),
							update: () => ({
								set: () => ({
									where: async () => {
										disabledCredentials += 1;
									},
								}),
							}),
							insert: () => ({
								values: async (values: { permissions?: unknown }) => {
									insertedValues = values;
								},
							}),
						}),
				},
				kv: {
					get: async () => null,
					put: async (key: string, value: string) => {
						kvWrites.set(key, value);
					},
					delete: async () => undefined,
				},
			},
		} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ has_api_key: true });
		expect(insertedValues?.permissions).toBe("read,write");
		expect(disabledCredentials).toBe(0);
		expect(purgedExpiredCredentials).toBe(1);
		const authCache = [...kvWrites]
			.find(([key]) => key.startsWith("apikey:"))
			?.at(1);
		expect(authCache).toBeDefined();
		const authData = JSON.parse(authCache ?? "{}");
		expect(authData.permissions).toEqual(["read", "write"]);
		expect(authData.ai_enabled).toBe(true);
		expect(authData.daily_tool_limit).toBe(17);
		const pointer = kvWrites.get("dashboard-key:org_123:user_123");
		expect(pointer).toStartWith("v2.");
		expect(pointer).not.toContain("rlay_live_");
	});

	it("rotates an expired principal credential instead of reporting no key", async () => {
		const oldRawKey = "rlay_live_expired_test_credential";
		const oldHashBuffer = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(oldRawKey),
		);
		const oldHash = Array.from(new Uint8Array(oldHashBuffer))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		const deletedKeys: string[] = [];
		const kvWrites = new Map<string, string>();
		let insertedValues: { key?: unknown; permissions?: unknown } | undefined;
		let disabled = false;
		let purgedExpiredCredentials = 0;
		const authoritySelect = existingMemberPrincipalSelect(
			"mem_expired",
			"prn_expired",
			"user_expired",
			"member",
			true,
		);
		const pointerName = "dashboard-key:org_expired:user_expired";
		const oldEnvelope = await encryptDashboardApiKey(
			oldRawKey,
			DASHBOARD_CREDENTIAL_SECRET,
			pointerName,
		);

		const response = await getDashboardKeyStatus({
			locals: {
				user: { id: "user_expired" },
				organization: { id: "org_expired" },
				organizationMembershipRole: "member",
				dashboardCredentialSecret: DASHBOARD_CREDENTIAL_SECRET,
				db: {
					select: orderedSelect(
						[
							{
								enabled: true,
								expiresAt: new Date(0),
								referenceId: "user_expired",
								organizationId: "org_expired",
								principalId: "prn_expired",
								permissions: "read,write",
								credentialVersion: null,
								liveUserId: "user_expired",
								userBanned: false,
								userBanExpires: null,
								userCredentialVersion: "legacy-v1",
							},
						],
						[],
					),
					transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
						callback({
							select: authoritySelect,
							delete: () => ({
								where: async () => {
									purgedExpiredCredentials += 1;
								},
							}),
							update: () => ({
								set: () => ({
									where: async () => {
										disabled = true;
									},
								}),
							}),
							insert: () => ({
								values: async (values: {
									key?: unknown;
									permissions?: unknown;
								}) => {
									insertedValues = values;
								},
							}),
						}),
				},
				kv: {
					get: async () => oldEnvelope,
					put: async (key: string, value: string) => {
						kvWrites.set(key, value);
					},
					delete: async (key: string) => {
						deletedKeys.push(key);
					},
				},
			},
		} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ has_api_key: true });
		expect(disabled).toBe(true);
		expect(purgedExpiredCredentials).toBe(1);
		expect(insertedValues?.permissions).toBe("read,write");
		expect(insertedValues?.key).not.toBe(oldHash);
		expect(deletedKeys).not.toContain("dashboard-key:org_expired:user_expired");
		expect(deletedKeys).toContain(`apikey:${oldHash}`);
		expect(kvWrites.get("dashboard-key:org_expired:user_expired")).not.toBe(
			oldRawKey,
		);
		expect(kvWrites.get("dashboard-key:org_expired:user_expired")).toStartWith(
			"v2.",
		);
	});

	it("reuses a current credential without writes or rotation", async () => {
		const rawKey = "rlay_live_current_test_credential";
		let transactions = 0;
		let kvWrites = 0;
		const authoritySelect = existingMemberPrincipalSelect(
			"mem_current",
			"prn_current",
			"user_current",
			"admin",
		);
		const pointerName = "dashboard-key:org_current:user_current";
		const currentEnvelope = await encryptDashboardApiKey(
			rawKey,
			DASHBOARD_CREDENTIAL_SECRET,
			pointerName,
		);
		const response = await bootstrapDashboardKey({
			locals: {
				user: { id: "user_current" },
				organization: { id: "org_current" },
				organizationMembershipRole: "admin",
				dashboardCredentialSecret: DASHBOARD_CREDENTIAL_SECRET,
				db: {
					select: orderedSelect([
						{
							enabled: true,
							expiresAt: new Date(Date.now() + 60_000),
							referenceId: "user_current",
							organizationId: "org_current",
							principalId: "prn_current",
							permissions: "read,write,manage_api_keys,manage_spend",
							credentialVersion: null,
							liveUserId: "user_current",
							userBanned: false,
							userBanExpires: null,
							userCredentialVersion: "legacy-v1",
						},
					]),
					transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
						transactions += 1;
						return callback({ select: authoritySelect });
					},
				},
				kv: {
					get: async () => currentEnvelope,
					put: async () => {
						kvWrites += 1;
					},
					delete: async () => undefined,
				},
			},
		} as never);

		expect(response.status).toBe(200);
		expect(transactions).toBe(1);
		expect(kvWrites).toBe(0);
	});

	it("recovers a direct dashboard API request when its credential is missing", async () => {
		const kv = new Map<string, string>();
		const authoritySelect = existingMemberPrincipalSelect(
			"mem_direct",
			"prn_direct",
			"user_direct",
			"member",
		);
		const result = await requireClient({
			locals: {
				user: { id: "user_direct" },
				organization: { id: "org_direct" },
				organizationMembershipRole: "member",
				dashboardCredentialSecret: DASHBOARD_CREDENTIAL_SECRET,
				db: {
					select: orderedSelect([]),
					transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
						callback({
							delete: () => ({
								where: async () => undefined,
							}),
							select: authoritySelect,
							update: () => ({
								set: () => ({ where: async () => undefined }),
							}),
							insert: () => ({ values: async () => undefined }),
						}),
				},
				kv: {
					get: async (key: string) => kv.get(key) ?? null,
					put: async (key: string, value: string) => {
						kv.set(key, value);
					},
					delete: async (key: string) => {
						kv.delete(key);
					},
				},
			},
		} as never);

		expect(result).not.toBeInstanceOf(Response);
		expect(kv.has("dashboard-key:org_direct:user_direct")).toBe(true);
	});
});
