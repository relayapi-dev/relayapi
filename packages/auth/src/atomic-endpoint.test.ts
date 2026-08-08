import { describe, expect, it, spyOn } from "bun:test";
import {
	getCurrentAdapter,
	runWithTransaction,
} from "@better-auth/core/context";
import { wrapEndpointInTransaction } from "./atomic-endpoint";
import { createPostCommitInvitationEmailSender } from "./index";

describe("atomic Better Auth endpoint wrapper", () => {
	it("rolls organization creation back when owner-member creation fails", async () => {
		const committedModels: string[] = [];
		let afterCommitCalls = 0;
		const adapter = {
			transaction: async (
				callback: (transaction: {
					create(input: { model: string }): Promise<void>;
				}) => Promise<unknown>,
			) => {
				const pendingModels = [...committedModels];
				const result = await callback({
					create: async ({ model }) => {
						pendingModels.push(model);
					},
				});
				committedModels.splice(0, committedModels.length, ...pendingModels);
				return result;
			},
		};
		const endpoint = Object.assign(
			async (context: { context: { adapter: never } }) => {
				const directContextAdapter = context.context.adapter as unknown as {
					create(input: {
						model: string;
						data: Record<string, unknown>;
					}): Promise<void>;
				};
				await directContextAdapter.create({
					model: "organization",
					data: { id: "org_1" },
				});
				throw new Error("owner member insert failed");
			},
			{
				path: "/organization/create",
				options: { metadata: { openapi: { description: "create" } } },
			},
		);
		const wrapped = wrapEndpointInTransaction(endpoint, async () => {
			afterCommitCalls += 1;
		});

		await expect(
			wrapped({ context: { adapter: adapter as never } }),
		).rejects.toThrow("owner member insert failed");
		expect(committedModels).toEqual([]);
		expect(afterCommitCalls).toBe(0);
		expect(wrapped.path).toBe(endpoint.path);
		expect(wrapped.options).toBe(endpoint.options);
	});

	it("preserves committed success when a post-commit effect fails", async () => {
		const committedModels: string[] = [];
		const adapter = {
			transaction: async (
				callback: (transaction: {
					create(input: { model: string }): Promise<void>;
				}) => Promise<unknown>,
			) => {
				const pendingModels = [...committedModels];
				const result = await callback({
					create: async ({ model }) => {
						pendingModels.push(model);
					},
				});
				committedModels.splice(0, committedModels.length, ...pendingModels);
				return result;
			},
		};
		const endpoint = Object.assign(
			async (context: { context: { adapter: never } }) => {
				const currentAdapter = await getCurrentAdapter(context.context.adapter);
				await currentAdapter.create({
					model: "organization",
					data: { id: "org_1" },
				});
				return { id: "org_1" };
			},
			{ path: "/organization/create" },
		);
		const error = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const wrapped = wrapEndpointInTransaction(endpoint, async () => {
				throw new Error("reservation delete unavailable");
			});

			await expect(
				wrapped({ context: { adapter: adapter as never } }),
			).resolves.toEqual({ id: "org_1" });
			expect(committedModels).toEqual(["organization"]);
			expect(error).toHaveBeenCalledWith(
				JSON.stringify({
					event: "post_commit_endpoint_effect_failed",
					endpoint_path: "/organization/create",
				}),
			);
		} finally {
			error.mockRestore();
		}
	});

	it("stages invitation email only after the invitation transaction commits", async () => {
		let transactionActive = false;
		let deliveredWhileTransactionActive: boolean | undefined;
		const adapter = {
			transaction: async (
				callback: (transaction: never) => Promise<unknown>,
			) => {
				transactionActive = true;
				try {
					return await callback({} as never);
				} finally {
					transactionActive = false;
				}
			},
		};
		const sender = createPostCommitInvitationEmailSender(async () => {
			deliveredWhileTransactionActive = transactionActive;
		});

		await runWithTransaction(adapter as never, async () => {
			await sender({
				id: "invitation_1",
				occurrenceId: "occurrence_1",
				email: "invitee@example.com",
				role: "member",
				organizationId: "org_1",
				organizationName: "Example",
				inviterEmail: "owner@example.com",
			});
			expect(deliveredWhileTransactionActive).toBeUndefined();
		});

		expect(deliveredWhileTransactionActive).toBe(false);
	});

	it("does not turn a committed invitation into a false failure when email staging fails", async () => {
		const adapter = {
			transaction: async (callback: (transaction: never) => Promise<unknown>) =>
				callback({} as never),
		};
		const error = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const sender = createPostCommitInvitationEmailSender(async () => {
				throw new Error("email intent unavailable");
			});
			await expect(
				runWithTransaction(adapter as never, () =>
					sender({
						id: "invitation_1",
						occurrenceId: "occurrence_1",
						email: "invitee@example.com",
						role: "member",
						organizationId: "org_1",
						organizationName: "Example",
						inviterEmail: "owner@example.com",
					}),
				),
			).resolves.toBeUndefined();
			expect(error).toHaveBeenCalledWith(
				JSON.stringify({ event: "post_commit_invitation_email_failed" }),
			);
		} finally {
			error.mockRestore();
		}
	});
});
