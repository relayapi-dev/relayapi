import { describe, expect, it } from "bun:test";
import { POST as bootstrapDashboardKey } from "../pages/api/bootstrap-key";
import { GET as getDashboardKeyStatus } from "../pages/api/dashboard-key-status";
import { requireClient, requireOrganizationAdmin } from "./api-utils";
import {
	canManageOrganizationCredentials,
	getDashboardCredentialPermissions,
	hasCurrentDashboardCredentialPermissions,
} from "./credential-authorization";

describe("dashboard credential authorization", () => {
	it("grants API-key administration only to organization owners and admins", () => {
		for (const role of ["owner", "admin"]) {
			expect(canManageOrganizationCredentials(role)).toBe(true);
			expect(getDashboardCredentialPermissions(role)).toEqual([
				"read",
				"write",
				"manage_api_keys",
			]);
		}

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
		const kvWrites = new Map<string, string>();
		const response = await getDashboardKeyStatus({
			locals: {
				user: { id: "user_123" },
				organization: { id: "org_123" },
				organizationMembershipRole: "member",
				db: {
					select: () => ({
						from: () => ({
							where: () => ({
								limit: async () => [
									{
										status: "active",
										aiEnabled: true,
										dailyToolLimit: 17,
									},
								],
							}),
						}),
					}),
					transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
						callback({
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
		let selectCall = 0;
		let insertedValues: { key?: unknown; permissions?: unknown } | undefined;
		let disabled = false;
		let purgedExpiredCredentials = 0;

		const response = await getDashboardKeyStatus({
			locals: {
				user: { id: "user_expired" },
				organization: { id: "org_expired" },
				organizationMembershipRole: "member",
				db: {
					select: () => ({
						from: () => ({
							where: () => ({
								limit: async () => {
									selectCall += 1;
									return selectCall === 1
										? [
												{
													enabled: true,
													expiresAt: new Date(0),
													referenceId: "user_expired",
													organizationId: "org_expired",
													metadata: {
														principal_type: "dashboard_user",
														principal_id: "user_expired",
													},
													permissions: "read,write",
												},
											]
										: [];
								},
							}),
						}),
					}),
					transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
						callback({
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
					get: async () => oldRawKey,
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
	});

	it("reuses a current credential without writes or rotation", async () => {
		const rawKey = "rlay_live_current_test_credential";
		let transactions = 0;
		let kvWrites = 0;
		const response = await bootstrapDashboardKey({
			locals: {
				user: { id: "user_current" },
				organization: { id: "org_current" },
				organizationMembershipRole: "admin",
				db: {
					select: () => ({
						from: () => ({
							where: () => ({
								limit: async () => [
									{
										enabled: true,
										expiresAt: new Date(Date.now() + 60_000),
										referenceId: "user_current",
										organizationId: "org_current",
										permissions: "read,write,manage_api_keys",
										metadata: {
											principal_type: "dashboard_user",
											principal_id: "user_current",
										},
									},
								],
							}),
						}),
					}),
					transaction: async () => {
						transactions += 1;
					},
				},
				kv: {
					get: async () => rawKey,
					put: async () => {
						kvWrites += 1;
					},
					delete: async () => undefined,
				},
			},
		} as never);

		expect(response.status).toBe(200);
		expect(transactions).toBe(0);
		expect(kvWrites).toBe(0);
	});

	it("recovers a direct dashboard API request when its credential is missing", async () => {
		const kv = new Map<string, string>();
		const result = await requireClient({
			locals: {
				user: { id: "user_direct" },
				organization: { id: "org_direct" },
				organizationMembershipRole: "member",
				db: {
					select: () => ({
						from: () => ({
							where: () => ({ limit: async () => [] }),
						}),
					}),
					transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
						callback({
							delete: () => ({
								where: async () => undefined,
							}),
							select: () => ({
								from: () => ({ where: async () => [] }),
							}),
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
