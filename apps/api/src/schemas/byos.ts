import { z } from "@hono/zod-openapi";

export const ByosConfigSpec = z
	.object({
		endpoint: z
			.string()
			.url()
			.max(2_000)
			.refine((value) => {
				const url = new URL(value);
				return (
					url.protocol === "https:" &&
					url.username === "" &&
					url.password === "" &&
					url.search === "" &&
					url.hash === ""
				);
			}, "endpoint must be a credential-free HTTPS URL without query or fragment"),
		bucket: z.string().trim().min(1).max(255),
		region: z.string().trim().min(1).max(100).default("auto"),
		key_prefix: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.regex(/^(?!\/)(?!.*\.\.)(?!.*\/$).+$/)
			.default("relayapi"),
		force_path_style: z.boolean().default(false),
		access_key_id: z.string().min(1).max(1_000),
		secret_access_key: z.string().min(1).max(4_000),
	})
	.strict();

export const ByosConfigResponse = z.object({
	id: z.string(),
	location_id: z.string(),
	credential_id: z.string(),
	provider: z.literal("s3"),
	endpoint: z.string().url(),
	bucket: z.string(),
	region: z.string(),
	key_prefix: z.string(),
	force_path_style: z.boolean(),
	credential_version: z.number().int().positive(),
	credentials_present: z.literal(true),
	status: z.enum(["staged", "active", "retired", "failed"]),
	last_tested_at: z.string().datetime().nullable(),
	last_error_code: z.string().nullable(),
	activated_at: z.string().datetime().nullable(),
	retired_at: z.string().datetime().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});
