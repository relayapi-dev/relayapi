import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

const CampaignKey = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[a-z0-9][a-z0-9_-]*$/);

export const QrCodeCreateSpec = z
	.object({
		ref_url_id: z.string().min(1),
		label: z.string().trim().min(1).max(120),
		campaign_key: CampaignKey.nullable().optional(),
	})
	.strict();

export const QrCodeUpdateSpec = z
	.object({
		label: z.string().trim().min(1).max(120).optional(),
		campaign_key: CampaignKey.nullable().optional(),
	})
	.strict();

export const QrCodeResponse = z.object({
	id: z.string(),
	public_id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	ref_url_id: z.string(),
	label: z.string(),
	campaign_key: z.string().nullable(),
	scan_count: z.number().int().nonnegative(),
	scan_url: z.string().url(),
	image_url: z.string().url(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const QrCodeListResponse = paginatedResponse(QrCodeResponse);
