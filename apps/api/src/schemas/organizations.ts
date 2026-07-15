import { z } from "@hono/zod-openapi";

export const OrganizationDeletionResponse = z.object({
	status: z.literal("tombstoned").describe("Durable local deletion state"),
});
