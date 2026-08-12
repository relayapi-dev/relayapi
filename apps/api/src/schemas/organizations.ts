import { z } from "@hono/zod-openapi";

export const OrganizationDeletionResponse = z.object({
	status: z
		.enum(["tombstoned", "held"])
		.describe("Durable local deletion state; held jobs resume after hold release"),
});
