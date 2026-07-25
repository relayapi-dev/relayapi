import { describe, expect, it, spyOn } from "bun:test";
import { getCurrentAdapter } from "@better-auth/core/context";
import { wrapEndpointInTransaction } from "./atomic-endpoint";

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
				const currentAdapter = await getCurrentAdapter(context.context.adapter);
				await currentAdapter.create({
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
});
