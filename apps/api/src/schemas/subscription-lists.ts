import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

export const SubscriptionListChannel = z.enum([
	"instagram",
	"facebook",
	"whatsapp",
	"telegram",
	"tiktok",
]);

export const SubscriptionListCreateSpec = z
	.object({
		name: z.string().trim().min(1).max(200),
		channel: SubscriptionListChannel.describe(
			"The delivery channel this audience targets. List membership never grants send consent.",
		),
		description: z.string().trim().max(2000).optional(),
		workspace_id: z.string().optional(),
	})
	.strict();

/**
 * Channel is intentionally immutable. Moving an established audience to a
 * different channel would silently change the send-time consent authority
 * required for every member.
 */
export const SubscriptionListUpdateSpec = z
	.object({
		name: z.string().trim().min(1).max(200).optional(),
		description: z.string().trim().max(2000).nullable().optional(),
	})
	.strict();

export const SubscriptionListResponse = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	name: z.string(),
	channel: SubscriptionListChannel,
	description: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const SubscriptionListListQuery = z.object({
	cursor: z.string().optional().describe("Opaque pagination cursor"),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	workspace_id: z.string().optional(),
	channel: SubscriptionListChannel.optional(),
});

export const SubscriptionListListResponse = paginatedResponse(
	SubscriptionListResponse,
);

export const SubscriptionMemberStatus = z.enum([
	"active",
	"unsubscribed",
	"all",
]);

export const SubscriptionMemberListQuery = z.object({
	cursor: z.string().optional().describe("Opaque pagination cursor"),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	status: SubscriptionMemberStatus.default("active"),
});

export const SubscriptionMemberResponse = z.object({
	list_id: z.string(),
	channel: SubscriptionListChannel.describe(
		"Audience channel only; current channel/purpose consent is still required at send time.",
	),
	contact_id: z.string(),
	contact: z.object({
		id: z.string(),
		name: z.string().nullable(),
		email: z.string().nullable(),
		phone: z.string().nullable(),
	}),
	status: z.enum(["active", "unsubscribed"]),
	source: z.enum(["automation", "manual", "import", "api"]),
	subscribed_at: z.string().datetime(),
	unsubscribed_at: z.string().datetime().nullable(),
	updated_at: z.string().datetime(),
});

export const SubscriptionMemberListResponse = paginatedResponse(
	SubscriptionMemberResponse,
);

export const AddSubscriptionMemberSpec = z
	.object({
		contact_id: z.string().min(1),
	})
	.strict()
	.describe(
		"Add or re-add a contact to this channel-scoped list. This does not grant channel or purpose consent.",
	);

export const SubscriptionListIdParams = z.object({ id: z.string() });

export const SubscriptionMemberParams = z.object({
	id: z.string(),
	contact_id: z.string(),
});
