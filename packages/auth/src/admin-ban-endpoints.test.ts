import { describe, expect, test } from "bun:test";
import { getCurrentAdapter } from "@better-auth/core/context";
import { admin } from "better-auth/plugins";
import {
	ADMIN_MUTATION_AUTHORITY_EXEMPTIONS,
	ADMIN_MUTATIONS_REQUIRE_AUTHENTICATED_SESSION,
	FENCED_ADMIN_MUTATION_ENDPOINTS,
	fenceGlobalAdminMutationActor,
	isActiveUserBan,
	wrapAdminBanEndpointsInTransactions,
	wrapAdminMutationEndpointsInTransactions,
} from "./admin-ban-endpoints";

type EndpointContext = {
	body?: {
		userId?: unknown;
		data?: Record<string, unknown>;
		banExpiresIn?: unknown;
	};
	context: {
		adapter: never;
		internalAdapter?: {
			findUserById(userId: string): Promise<{
				banned: boolean;
				banExpires: Date | null;
			}>;
			deleteUserSessions(userId: string): Promise<void>;
			updateUser(userId: string, data: Record<string, unknown>): Promise<void>;
		};
	};
};

function endpoint(
	value: unknown,
): (context: EndpointContext) => Promise<unknown> {
	if (typeof value !== "function") throw new Error("endpoint was not wrapped");
	return value as (context: EndpointContext) => Promise<unknown>;
}

describe("atomic admin ban endpoints", () => {
	test("rolls the user ban back when session deletion fails", async () => {
		const committed = { banned: false, sessions: ["session_1"] };
		const adapter = {
			transaction: async (
				callback: (transaction: {
					ban(): Promise<void>;
					deleteSessions(): Promise<void>;
				}) => Promise<unknown>,
			) => {
				const pending = {
					banned: committed.banned,
					sessions: [...committed.sessions],
				};
				const result = await callback({
					ban: async () => {
						pending.banned = true;
					},
					deleteSessions: async () => {
						throw new Error("session deletion failed");
					},
				});
				committed.banned = pending.banned;
				committed.sessions = pending.sessions;
				return result;
			},
		};
		const banUser = Object.assign(
			async (context: EndpointContext) => {
				const current = (await getCurrentAdapter(
					context.context.adapter,
				)) as unknown as {
					ban(): Promise<void>;
					deleteSessions(): Promise<void>;
				};
				await current.ban();
				await current.deleteSessions();
				return { user: { id: "user_1", banned: true } };
			},
			{ path: "/admin/ban-user" },
		);
		const callbacks: string[] = [];
		const plugin = { endpoints: { banUser } };
		wrapAdminBanEndpointsInTransactions(plugin, async (userId) => {
			callbacks.push(userId);
		});

		await expect(
			endpoint(plugin.endpoints.banUser)({
				body: { userId: "user_1" },
				context: { adapter: adapter as never },
			}),
		).rejects.toThrow("session deletion failed");
		expect(committed).toEqual({ banned: false, sessions: ["session_1"] });
		expect(callbacks).toEqual([]);
		expect((plugin.endpoints.banUser as typeof banUser).path).toBe(
			"/admin/ban-user",
		);
	});

	test("notifies only admin updates that request a ban", async () => {
		const adapter = {
			transaction: async (callback: () => Promise<unknown>) => callback(),
		};
		const adminUpdateUser = async () => ({ id: "user_1" });
		const callbacks: string[] = [];
		const internalAdapter = {
			findUserById: async () => ({ banned: true, banExpires: null }),
			deleteUserSessions: async () => undefined,
			updateUser: async () => undefined,
		};
		const plugin = { endpoints: { adminUpdateUser } };
		wrapAdminBanEndpointsInTransactions(plugin, async (userId) => {
			callbacks.push(userId);
		});
		const update = endpoint(plugin.endpoints.adminUpdateUser);

		await update({
			body: { userId: "user_1", data: { name: "Updated" } },
			context: { adapter: adapter as never },
		});
		await update({
			body: { userId: "user_1", data: { banned: true } },
			context: { adapter: adapter as never, internalAdapter },
		});

		expect(callbacks).toEqual(["user_1"]);
	});

	test("revokes sessions transactionally when banExpires alone reactivates an expired ban", async () => {
		let transactionActive = false;
		const state = {
			banned: true,
			banExpires: new Date(0) as Date | null,
			sessions: ["session_1"],
		};
		const adapter = {
			transaction: async (callback: () => Promise<unknown>) => {
				transactionActive = true;
				try {
					return await callback();
				} finally {
					transactionActive = false;
				}
			},
		};
		const internalAdapter = {
			findUserById: async () => ({
				banned: state.banned,
				banExpires: state.banExpires,
			}),
			deleteUserSessions: async () => {
				expect(transactionActive).toBe(true);
				state.sessions = [];
			},
			updateUser: async () => undefined,
		};
		const plugin = {
			endpoints: {
				adminUpdateUser: async (context: EndpointContext) => {
					state.banExpires = context.body?.data?.banExpires as Date;
					return { user: { id: "user_1" } };
				},
			},
		};
		wrapAdminBanEndpointsInTransactions(plugin, async () => undefined);

		await endpoint(plugin.endpoints.adminUpdateUser)({
			body: {
				userId: "user_1",
				data: { banExpires: new Date(Date.now() + 60_000) },
			},
			context: { adapter: adapter as never, internalAdapter },
		});

		expect(state.sessions).toEqual([]);
	});

	test("re-banning an expired temporary ban without a duration becomes permanent", async () => {
		let transactionActive = false;
		const state = {
			banned: true,
			banExpires: new Date(0) as Date | null,
			sessions: ["session_1"],
		};
		const adapter = {
			transaction: async (callback: () => Promise<unknown>) => {
				transactionActive = true;
				try {
					return await callback();
				} finally {
					transactionActive = false;
				}
			},
		};
		const internalAdapter = {
			findUserById: async () => ({
				banned: state.banned,
				banExpires: state.banExpires,
			}),
			deleteUserSessions: async () => {
				expect(transactionActive).toBe(true);
				state.sessions = [];
			},
			updateUser: async (_userId: string, data: Record<string, unknown>) => {
				expect(transactionActive).toBe(true);
				if (Object.hasOwn(data, "banExpires")) {
					state.banExpires = data.banExpires as Date | null;
				}
			},
		};
		const banUser = Object.assign(
			async () => {
				state.banned = true;
				return {
					user: { id: "user_1", banned: true, banExpires: new Date(0) },
				};
			},
			{ path: "/admin/ban-user" },
		);
		const plugin = { endpoints: { banUser } };
		wrapAdminBanEndpointsInTransactions(plugin, async () => undefined);

		const result = (await endpoint(plugin.endpoints.banUser)({
			body: { userId: "user_1" },
			context: { adapter: adapter as never, internalAdapter },
		})) as { user: { banExpires: Date | null } };

		expect(state.banExpires).toBeNull();
		expect(state.sessions).toEqual([]);
		expect(result.user.banExpires).toBeNull();
		expect((plugin.endpoints.banUser as typeof banUser).path).toBe(
			"/admin/ban-user",
		);
	});

	test("rejects attempts to overwrite the database-managed generation", async () => {
		let endpointCalls = 0;
		const adapter = {
			transaction: async (callback: () => Promise<unknown>) => callback(),
		};
		const plugin = {
			endpoints: {
				adminUpdateUser: async () => {
					endpointCalls += 1;
					return { id: "user_1" };
				},
			},
		};
		wrapAdminBanEndpointsInTransactions(plugin, async () => undefined);

		await expect(
			endpoint(plugin.endpoints.adminUpdateUser)({
				body: {
					userId: "user_1",
					data: { credentialVersion: "attacker-selected" },
				},
				context: { adapter: adapter as never },
			}),
		).rejects.toMatchObject({ status: "BAD_REQUEST" });
		expect(endpointCalls).toBe(0);
	});

	test("temporary bans stop being active once their expiry elapses", () => {
		expect(isActiveUserBan({ banned: true, banExpires: null }, 100)).toBe(true);
		expect(
			isActiveUserBan({ banned: true, banExpires: new Date(101) }, 100),
		).toBe(true);
		expect(
			isActiveUserBan({ banned: true, banExpires: new Date(100) }, 100),
		).toBe(false);
		expect(isActiveUserBan({ banned: false, banExpires: null }, 100)).toBe(
			false,
		);
	});
});

describe("global administrator mutation authority", () => {
	test("routes every core and admin session revocation through the database invariant", async () => {
		const repositoryRoot = new URL("../../../", import.meta.url).pathname;
		const [
			identityRenderer,
			signOutSource,
			sessionSource,
			passwordSource,
			updateUserSource,
			adminSource,
		] = await Promise.all([
			Bun.file(
				`${repositoryRoot}packages/db/scripts/render-auth-identity-invariant-sql.ts`,
			).text(),
			Bun.file(
				`${repositoryRoot}node_modules/better-auth/dist/api/routes/sign-out.mjs`,
			).text(),
			Bun.file(
				`${repositoryRoot}node_modules/better-auth/dist/api/routes/session.mjs`,
			).text(),
			Bun.file(
				`${repositoryRoot}node_modules/better-auth/dist/api/routes/password.mjs`,
			).text(),
			Bun.file(
				`${repositoryRoot}node_modules/better-auth/dist/api/routes/update-user.mjs`,
			).text(),
			Bun.file(
				`${repositoryRoot}node_modules/better-auth/dist/plugins/admin/routes.mjs`,
			).text(),
		]);

		expect(identityRenderer).toContain("AFTER DELETE ON ${qualified(");
		expect(identityRenderer).toContain(
			'derived_impersonation_session."impersonatedBy" = OLD."userId"',
		);
		expect(identityRenderer).toContain(
			'IF OLD."impersonatedBy" IS NOT NULL THEN',
		);
		expect(signOutSource).toContain(
			"internalAdapter.deleteSession(sessionCookieToken)",
		);
		for (const path of [
			'createAuthEndpoint("/revoke-session"',
			'createAuthEndpoint("/revoke-sessions"',
			'createAuthEndpoint("/revoke-other-sessions"',
		]) {
			expect(sessionSource).toContain(path);
		}
		expect(sessionSource).toContain("internalAdapter.deleteSession(token)");
		expect(sessionSource).toContain(
			"internalAdapter.deleteUserSessions(ctx.context.session.user.id)",
		);
		expect(sessionSource).toContain(
			"internalAdapter.deleteSession(session.token)",
		);
		expect(passwordSource).toContain(
			"revokeSessionsOnPasswordReset) await ctx.context.internalAdapter.deleteUserSessions(userId)",
		);
		expect(updateUserSource).toContain(
			"if (revokeOtherSessions) {\n\t\tawait ctx.context.internalAdapter.deleteUserSessions(session.user.id)",
		);
		expect(adminSource).toContain(
			"internalAdapter.deleteSession(ctx.body.sessionToken)",
		);
		expect(adminSource).toContain(
			"internalAdapter.deleteUserSessions(ctx.body.userId)",
		);
	});

	test("fail-closes the installed Better Auth admin endpoint inventory", () => {
		const installed = admin().endpoints ?? {};
		const semanticReads = new Set([
			"getUser",
			"listUsers",
			"listUserSessions",
			"userHasPermission",
		]);
		const classified = new Set([
			...semanticReads,
			...FENCED_ADMIN_MUTATION_ENDPOINTS,
			...ADMIN_MUTATION_AUTHORITY_EXEMPTIONS,
		]);
		expect(Object.keys(installed).sort()).toEqual([...classified].sort());
		const installedMutations = Object.keys(installed).filter(
			(name) => !semanticReads.has(name),
		);
		expect(installedMutations.sort()).toEqual(
			[
				...FENCED_ADMIN_MUTATION_ENDPOINTS,
				...ADMIN_MUTATION_AUTHORITY_EXEMPTIONS,
			].sort(),
		);
		expect((installed.stopImpersonating as { path?: unknown }).path).toBe(
			"/admin/stop-impersonating",
		);
	});

	test("fences every mutating admin endpoint and leaves stop-impersonation outside", async () => {
		let transactionActive = false;
		const events: string[] = [];
		const adapter = {
			transaction: async (callback: () => Promise<unknown>) => {
				transactionActive = true;
				try {
					return await callback();
				} finally {
					transactionActive = false;
				}
			},
		};
		const endpoints: Record<string, unknown> = {};
		for (const endpointName of FENCED_ADMIN_MUTATION_ENDPOINTS) {
			endpoints[endpointName] = Object.assign(
				async () => {
					expect(transactionActive, endpointName).toBe(true);
					events.push(`endpoint:${endpointName}`);
					return { ok: true };
				},
				{ path: `/admin/${endpointName}` },
			);
		}
		const stopImpersonating = async () => ({ ok: true });
		endpoints.stopImpersonating = stopImpersonating;
		const plugin = { endpoints };
		wrapAdminMutationEndpointsInTransactions(
			plugin,
			async () => undefined,
			async () => {
				expect(transactionActive).toBe(true);
				events.push("fence");
			},
		);

		for (const endpointName of FENCED_ADMIN_MUTATION_ENDPOINTS) {
			const wrapped = endpoint(plugin.endpoints[endpointName]);
			await wrapped({
				body: {},
				context: { adapter: adapter as never },
			});
			expect((plugin.endpoints[endpointName] as { path?: unknown }).path).toBe(
				`/admin/${endpointName}`,
			);
		}

		expect(events).toEqual(
			FENCED_ADMIN_MUTATION_ENDPOINTS.flatMap((endpointName) => [
				"fence",
				`endpoint:${endpointName}`,
			]),
		);
		expect(plugin.endpoints.stopImpersonating).toBe(stopImpersonating);
		expect(FENCED_ADMIN_MUTATION_ENDPOINTS).not.toContain(
			"stopImpersonating" as never,
		);
	});

	test("locks a live administrator and exact unexpired session", async () => {
		const models: string[] = [];
		const updates: Array<{
			model: string;
			where?: Array<{ field: string; operator?: string; value: unknown }>;
		}> = [];
		const adapter = {
			update: async (query: {
				model: string;
				where?: Array<{ field: string; operator?: string; value: unknown }>;
			}) => {
				models.push(query.model);
				updates.push(query);
				return query.model === "user"
					? {
							id: "usr_admin",
							role: "admin",
							banned: false,
							banExpires: null,
							credentialVersion: "generation_1",
						}
					: {
							id: "session_1",
							userId: "usr_admin",
							token: "session-token",
							impersonatedBy: null,
							expiresAt: new Date(Date.now() + 60_000),
						};
			},
		};
		const authoritativeSession = {
			session: {
				id: "session_1",
				userId: "usr_admin",
				token: "session-token",
				impersonatedBy: null,
			},
			user: {
				id: "usr_admin",
				role: "admin",
				credentialVersion: "generation_1",
			},
		};

		await fenceGlobalAdminMutationActor(
			{ context: { adapter: adapter as never } } as never,
			async () => authoritativeSession as never,
		);
		expect(models).toEqual(["user", "session"]);
		expect(updates[1]?.where).toEqual(
			expect.arrayContaining([
				{ field: "id", value: "session_1" },
				{ field: "userId", value: "usr_admin" },
				{ field: "token", value: "session-token" },
				expect.objectContaining({ field: "expiresAt", operator: "gt" }),
			]),
		);
	});

	test("rejects an expired locked session before endpoint work", async () => {
		const adapter = {
			update: async (query: { model: string }) =>
				query.model === "user"
					? {
							id: "usr_admin",
							role: "admin",
							banned: false,
							banExpires: null,
							credentialVersion: "generation_1",
						}
					: {
							id: "session_1",
							userId: "usr_admin",
							token: "session-token",
							impersonatedBy: null,
							expiresAt: new Date(0),
						},
		};
		await expect(
			fenceGlobalAdminMutationActor(
				{ context: { adapter: adapter as never } } as never,
				async () =>
					({
						session: {
							id: "session_1",
							userId: "usr_admin",
							token: "session-token",
							impersonatedBy: null,
						},
						user: {
							id: "usr_admin",
							role: "admin",
							credentialVersion: "generation_1",
						},
					}) as never,
			),
		).rejects.toMatchObject({
			status: "UNAUTHORIZED",
			body: { code: "SESSION_CREDENTIAL_STALE" },
		});
	});

	test("intentionally rejects Better Auth's sessionless createUser mode", async () => {
		expect(ADMIN_MUTATIONS_REQUIRE_AUTHENTICATED_SESSION).toBe(true);
		await expect(
			fenceGlobalAdminMutationActor(
				{ context: { adapter: {} as never } } as never,
				async () => null,
			),
		).rejects.toMatchObject({ status: "UNAUTHORIZED" });
	});
});
