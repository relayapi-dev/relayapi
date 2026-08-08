import { describe, expect, it } from "bun:test";
import {
	deleteAvatarObjectPrefix,
	organizationLogoPrefix,
	userAvatarPrefix,
} from "./avatar-object-keys";

describe("typed avatar object keys", () => {
	it("uses independently purgeable user and organization namespaces", () => {
		expect(userAvatarPrefix("user/a")).toBe("user/user%2Fa/");
		expect(organizationLogoPrefix("org/a")).toBe("organization/org%2Fa/");
	});

	it("deletes a subject prefix in cursor-bounded pages", async () => {
		const cursors: Array<string | undefined> = [];
		const deleted: string[][] = [];
		const bucket = {
			list: async (options: {
				prefix: string;
				limit?: number;
				cursor?: string;
			}) => {
				cursors.push(options.cursor);
				return options.cursor
					? {
							objects: [{ key: "user/user_1/avatar.webp" }],
							truncated: false,
						}
					: {
							objects: [{ key: "user/user_1/avatar.jpg" }],
							truncated: true,
							cursor: "next",
						};
			},
			delete: async (keys: string[]) => {
				deleted.push(keys);
			},
		};

		expect(
			await deleteAvatarObjectPrefix(bucket, userAvatarPrefix("user_1")),
		).toBe(2);
		expect(cursors).toEqual([undefined, "next"]);
		expect(deleted).toEqual([
			["user/user_1/avatar.jpg"],
			["user/user_1/avatar.webp"],
		]);
	});
});
