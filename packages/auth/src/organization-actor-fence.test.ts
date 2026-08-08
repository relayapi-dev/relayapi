import { describe, expect, test } from "bun:test";
import { runWithTransaction } from "@better-auth/core/context";
import {
	fenceOrganizationMutationActor,
	type OrganizationActorMutationContext,
} from "./organization-actor-fence";

type Where = Array<{
	field: string;
	operator?: string;
	value: unknown;
}>;

type UpdateInput = {
	model: string;
	update: Record<string, unknown>;
	where: Where;
};

type FindOneInput = {
	model: string;
	where: Where;
};

type AdapterHandlers = {
	findOne(input: FindOneInput): Promise<Record<string, unknown> | null>;
	update(input: UpdateInput): Promise<Record<string, unknown> | null>;
};

function actorContext(
	adapter: never,
	overrides?: {
		activeOrganizationId?: string;
		memberId?: string;
		organizationId?: string;
	},
): OrganizationActorMutationContext {
	return {
		body: {
			memberId: overrides?.memberId,
			organizationId: overrides?.organizationId,
		},
		context: {
			adapter,
			session: {
				user: { id: "actor", credentialVersion: "cookie-generation" },
				session: {
					id: "cookie-session",
					token: "cookie-token",
					userId: "actor",
					activeOrganizationId: overrides?.activeOrganizationId ?? "org_active",
				},
			},
		},
	};
}

function authoritativeSession(
	overrides?: Partial<{
		activeOrganizationId: string;
		credentialVersion: string;
		sessionId: string;
		token: string;
	}>,
) {
	return {
		user: {
			id: "actor",
			credentialVersion:
				overrides?.credentialVersion ?? "authoritative-generation",
		},
		session: {
			id: overrides?.sessionId ?? "authoritative-session",
			token: overrides?.token ?? "authoritative-token",
			userId: "actor",
			activeOrganizationId: overrides?.activeOrganizationId ?? "org_active",
		},
	} as never;
}

function transactionalAdapter(handlers: AdapterHandlers) {
	let transactionActive = false;
	const adapter = {
		transaction: async (callback: (transaction: never) => Promise<unknown>) => {
			transactionActive = true;
			try {
				return await callback({
					findOne: async (input: FindOneInput) => {
						expect(transactionActive).toBe(true);
						return handlers.findOne(input);
					},
					update: async (input: UpdateInput) => {
						expect(transactionActive).toBe(true);
						return handlers.update(input);
					},
				} as never);
			} finally {
				transactionActive = false;
			}
		},
	};
	return {
		adapter: adapter as never,
		isTransactionActive: () => transactionActive,
	};
}

function findValue(where: Where, field: string): unknown {
	return where.find((condition) => condition.field === field)?.value;
}

function liveHandlers(
	updates: UpdateInput[],
	options?: {
		actorRole?: string;
		organizationStatus?: string;
		sessionExists?: boolean;
		user?: Record<string, unknown> | null;
	},
): AdapterHandlers {
	const members = new Map([
		[
			"member_z_actor",
			{
				id: "member_z_actor",
				userId: "actor",
				organizationId: "org_requested",
				role: options?.actorRole ?? "owner",
			},
		],
		[
			"member_a_target",
			{
				id: "member_a_target",
				userId: "target",
				organizationId: "org_requested",
				role: "member",
			},
		],
	]);
	return {
		findOne: async (input) => {
			if (findValue(input.where, "userId") === "actor") {
				return members.get("member_z_actor") ?? null;
			}
			const memberId = findValue(input.where, "id");
			return typeof memberId === "string"
				? (members.get(memberId) ?? null)
				: null;
		},
		update: async (input) => {
			updates.push(input);
			if (input.model === "user") {
				return options && "user" in options
					? (options.user ?? null)
					: {
							id: "actor",
							credentialVersion: "authoritative-generation",
							banned: false,
							banExpires: null,
						};
			}
			if (input.model === "member") {
				const memberId = findValue(input.where, "id");
				return typeof memberId === "string"
					? (members.get(memberId) ?? null)
					: null;
			}
			if (input.model === "organization") {
				return {
					id: "org_requested",
					lifecycleStatus: options?.organizationStatus ?? "active",
				};
			}
			if (input.model === "session") {
				return options?.sessionExists === false
					? null
					: { id: "authoritative-session" };
			}
			return null;
		},
	};
}

describe("Better Auth organization mutation actor fence", () => {
	test("uses the authoritative session and locks actor/target IDs in stable order for an explicit organization", async () => {
		const updates: UpdateInput[] = [];
		const transaction = transactionalAdapter(liveHandlers(updates));
		const context = actorContext(transaction.adapter, {
			activeOrganizationId: "org_elsewhere",
			organizationId: "org_requested",
			memberId: "member_a_target",
		});

		await runWithTransaction(transaction.adapter, () =>
			fenceOrganizationMutationActor(
				context,
				"update-member-role",
				async () => {
					expect(transaction.isTransactionActive()).toBe(true);
					return authoritativeSession({
						activeOrganizationId: "org_elsewhere",
					});
				},
			),
		);

		expect(updates.map((input) => input.model)).toEqual([
			"user",
			"member",
			"member",
			"organization",
			"session",
		]);
		expect(
			updates
				.filter((input) => input.model === "member")
				.map((input) => findValue(input.where, "id")),
		).toEqual(["member_a_target", "member_z_actor"]);
		expect(findValue(updates[0]?.where ?? [], "credentialVersion")).toBe(
			"authoritative-generation",
		);
		expect(
			findValue(
				updates.find((input) => input.model === "organization")?.where ?? [],
				"id",
			),
		).toBe("org_requested");
		expect(
			findValue(
				updates.find((input) => input.model === "session")?.where ?? [],
				"id",
			),
		).toBe("authoritative-session");
		expect(context.context.session?.session.id).toBe("authoritative-session");
	});

	test("rejects a demoted actor attempting to restore their own role", async () => {
		const updates: UpdateInput[] = [];
		const transaction = transactionalAdapter(
			liveHandlers(updates, { actorRole: "member" }),
		);
		const context = actorContext(transaction.adapter, {
			organizationId: "org_requested",
			memberId: "member_z_actor",
		});

		await expect(
			runWithTransaction(transaction.adapter, () =>
				fenceOrganizationMutationActor(
					context,
					"update-member-role",
					async () => authoritativeSession(),
				),
			),
		).rejects.toMatchObject({
			status: "FORBIDDEN",
			body: { code: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER" },
		});
		expect(updates.filter((input) => input.model === "member")).toHaveLength(1);
	});

	test("rejects a ban generation change before locking organization authority", async () => {
		const updates: UpdateInput[] = [];
		const transaction = transactionalAdapter(
			liveHandlers(updates, { user: null }),
		);
		const context = actorContext(transaction.adapter, {
			organizationId: "org_requested",
		});

		await expect(
			runWithTransaction(transaction.adapter, () =>
				fenceOrganizationMutationActor(context, "invite", async () =>
					authoritativeSession(),
				),
			),
		).rejects.toMatchObject({
			status: "UNAUTHORIZED",
			body: { code: "SESSION_CREDENTIAL_STALE" },
		});
		expect(updates.map((input) => input.model)).toEqual(["user"]);
	});

	test("rejects exact-session deletion after locking live actor authority", async () => {
		const updates: UpdateInput[] = [];
		const transaction = transactionalAdapter(
			liveHandlers(updates, { sessionExists: false }),
		);
		const context = actorContext(transaction.adapter, {
			organizationId: "org_requested",
		});

		await expect(
			runWithTransaction(transaction.adapter, () =>
				fenceOrganizationMutationActor(context, "invite", async () =>
					authoritativeSession(),
				),
			),
		).rejects.toMatchObject({
			status: "UNAUTHORIZED",
			body: { code: "UNAUTHORIZED" },
		});
		expect(updates.map((input) => input.model)).toEqual([
			"user",
			"member",
			"organization",
			"session",
		]);
	});

	test("fails closed after an organization becomes non-active", async () => {
		const updates: UpdateInput[] = [];
		const transaction = transactionalAdapter(
			liveHandlers(updates, { organizationStatus: "deleting" }),
		);
		const context = actorContext(transaction.adapter, {
			organizationId: "org_requested",
		});

		await expect(
			runWithTransaction(transaction.adapter, () =>
				fenceOrganizationMutationActor(context, "invite", async () =>
					authoritativeSession(),
				),
			),
		).rejects.toMatchObject({
			status: "BAD_REQUEST",
			body: { code: "ORGANIZATION_NOT_FOUND" },
		});
	});
});
