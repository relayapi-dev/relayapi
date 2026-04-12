import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

export const CrossPostActionTypeEnum = z.enum(["repost", "comment", "quote"]);

export const CrossPostActionStatusEnum = z.enum(["pending", "executed", "failed", "cancelled"]);

export const CrossPostActionInput = z.object({
	action_type: CrossPostActionTypeEnum.describe("Type of cross-post action"),
	target_account_id: z.string().describe("Account to perform the action from"),
	content: z.string().optional().describe("Text content for comment/quote actions (required for comment and quote)"),
	delay_minutes: z.number().int().min(0).max(1440).default(0).describe("Delay in minutes after publishing"),
}).refine(
	(v) => v.action_type === "repost" || (v.content && v.content.length > 0),
	{ message: "content is required for comment and quote actions", path: ["content"] },
);

export const CrossPostActionResponse = z.object({
	id: z.string().describe("Action ID"),
	post_id: z.string(),
	action_type: CrossPostActionTypeEnum,
	target_account_id: z.string(),
	content: z.string().nullable(),
	delay_minutes: z.number(),
	status: CrossPostActionStatusEnum,
	execute_at: z.string().datetime(),
	executed_at: z.string().datetime().nullable(),
	result_post_id: z.string().nullable(),
	error: z.string().nullable(),
	created_at: z.string().datetime(),
});

export const CrossPostActionListResponse = paginatedResponse(CrossPostActionResponse);
