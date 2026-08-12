import { describe, expect, it } from "bun:test";
import { deleteUserQueueRescueEvidence } from "./queue-rescue-erasure";

describe("queue rescue user erasure", () => {
	it("scans only tenant prefixes and deletes matching user metadata", async () => {
		const prefixes: string[] = [];
		const deleted: string[][] = [];
		const bucket = {
			list: async (options: {
				prefix: string;
				limit: number;
				cursor?: string;
				include: ["customMetadata"];
			}) => {
				prefixes.push(options.prefix ?? "");
				return {
					objects: [
						{
							key: `${options.prefix}delete.json`,
							customMetadata: {
								subjectLocators: JSON.stringify([
									{ kind: "user", id: "user_delete" },
								]),
							},
						},
						{
							key: `${options.prefix}keep.json`,
							customMetadata: {
								subjectLocators: JSON.stringify([
									{ kind: "user", id: "user_keep" },
								]),
							},
						},
					],
					truncated: false,
				};
			},
			delete: async (keys: string[]) => {
				deleted.push(keys);
			},
		};

		expect(
			await deleteUserQueueRescueEvidence(
				bucket,
				["org_b", "org_a", "org_a"],
				"user_delete",
			),
		).toBe(2);
		expect(prefixes).toEqual([
			"queue-rescue/by-organization/org_a/",
			"queue-rescue/by-organization/org_b/",
		]);
		expect(deleted).toEqual([
			["queue-rescue/by-organization/org_a/delete.json"],
			["queue-rescue/by-organization/org_b/delete.json"],
		]);
	});

	it("fails closed when a bounded scan cannot reach the terminal page", async () => {
		const bucket = {
			list: async () => ({
				objects: [],
				truncated: true,
				cursor: "next",
			}),
			delete: async () => undefined,
		};

		await expect(
			deleteUserQueueRescueEvidence(bucket, ["org_1"], "user_1", {
				maxPagesPerOrganization: 1,
			}),
		).rejects.toThrow("exceeded 1 bounded pages");
	});
});
