import { describe, expect, test } from "bun:test";
import { runWithTransaction } from "@better-auth/core/context";
import {
	fenceInvitationAcceptingSession,
	type InvitationAcceptContext,
} from "./invitation-redeemer-fence";

type UpdateInput = {
	model: string;
	where: Array<{
		field: string;
		operator?: string;
		value: unknown;
	}>;
	update: Record<string, unknown>;
};

function acceptanceContext(adapter: never): InvitationAcceptContext {
	return {
		context: {
			adapter,
			session: {
				user: { id: "user_1", credentialVersion: "generation_1" },
				session: {
					id: "session_1",
					token: "token_1",
					userId: "user_1",
				},
			},
		},
	};
}

function transactionalAdapter(
	update: (input: UpdateInput) => Promise<Record<string, unknown> | null>,
) {
	let transactionActive = false;
	const adapter = {
		transaction: async (callback: (transaction: never) => Promise<unknown>) => {
			transactionActive = true;
			try {
				return await callback({
					update: async (input: UpdateInput) => {
						expect(transactionActive).toBe(true);
						return update(input);
					},
				} as never);
			} finally {
				transactionActive = false;
			}
		},
	};
	return adapter as never;
}

describe("invitation accepting-session fence", () => {
	test("locks the user generation before the exact live session", async () => {
		const calls: UpdateInput[] = [];
		const adapter = transactionalAdapter(async (input) => {
			calls.push(input);
			return input.model === "user"
				? {
						id: "user_1",
						credentialVersion: "generation_1",
						banned: false,
						banExpires: null,
					}
				: { id: "session_1" };
		});

		await runWithTransaction(adapter, () =>
			fenceInvitationAcceptingSession(acceptanceContext(adapter)),
		);

		expect(calls.map((call) => call.model)).toEqual(["user", "session"]);
		expect(calls[0]?.where).toEqual([
			{ field: "id", value: "user_1" },
			{ field: "credentialVersion", value: "generation_1" },
		]);
		expect(calls[1]?.where).toMatchObject([
			{ field: "id", value: "session_1" },
			{ field: "token", value: "token_1" },
			{ field: "userId", value: "user_1" },
			{ field: "expiresAt", operator: "gt" },
		]);
	});

	test("rejects a generation rotated by a concurrent ban before touching the session", async () => {
		const calls: UpdateInput[] = [];
		const adapter = transactionalAdapter(async (input) => {
			calls.push(input);
			return null;
		});

		await expect(
			runWithTransaction(adapter, () =>
				fenceInvitationAcceptingSession(acceptanceContext(adapter)),
			),
		).rejects.toMatchObject({
			status: "UNAUTHORIZED",
			body: { code: "SESSION_CREDENTIAL_STALE" },
		});
		expect(calls.map((call) => call.model)).toEqual(["user"]);
	});

	test("rejects an active ban or a revoked exact session", async () => {
		const bannedAdapter = transactionalAdapter(async () => ({
			id: "user_1",
			credentialVersion: "generation_1",
			banned: true,
			banExpires: null,
		}));
		await expect(
			runWithTransaction(bannedAdapter, () =>
				fenceInvitationAcceptingSession(acceptanceContext(bannedAdapter)),
			),
		).rejects.toMatchObject({ status: "UNAUTHORIZED" });

		const missingSessionAdapter = transactionalAdapter(async (input) =>
			input.model === "user"
				? {
						id: "user_1",
						credentialVersion: "generation_1",
						banned: false,
						banExpires: null,
					}
				: null,
		);
		await expect(
			runWithTransaction(missingSessionAdapter, () =>
				fenceInvitationAcceptingSession(
					acceptanceContext(missingSessionAdapter),
				),
			),
		).rejects.toMatchObject({
			status: "UNAUTHORIZED",
			body: { code: "UNAUTHORIZED" },
		});
	});
});
