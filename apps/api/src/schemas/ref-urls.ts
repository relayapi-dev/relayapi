import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

const Slug = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[a-z0-9][a-z0-9_-]*$/);

const HttpsUrl = z
	.string()
	.trim()
	.max(2048)
	.url()
	.refine(
		(value) => {
			const url = new URL(value);
			return (
				url.protocol === "https:" && url.username === "" && url.password === ""
			);
		},
		{
			message:
				"Only HTTPS destinations without embedded credentials are allowed",
		},
	);

export const RefUrlDestination = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("https_url"),
		url: HttpsUrl,
	}),
	z.object({
		type: z.literal("landing_page"),
		landing_page_id: z.string().min(1),
	}),
]);

export const RefUrlCreateSpec = z
	.object({
		slug: z
			.string()
			.pipe(Slug)
			.describe("URL-safe slug; unique within its exact scope"),
		workspace_id: z
			.string()
			.optional()
			.describe(
				"Workspace ID. Omission inherits the automation workspace in either policy mode; without an automation parent, strict mode requires an explicit value.",
			),
		automation_id: z
			.string()
			.nullable()
			.optional()
			.describe("Automation to enroll the contact into on click"),
		destination: RefUrlDestination.describe(
			"Exactly one HTTPS URL or same-scope landing page",
		),
		enabled: z.boolean().default(true),
	})
	.strict();

export const RefUrlUpdateSpec = z
	.object({
		slug: Slug.optional(),
		automation_id: z.string().nullable().optional(),
		destination: RefUrlDestination.optional(),
		enabled: z.boolean().optional(),
	})
	.strict();

export const RefUrlResponse = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	slug: z.string(),
	automation_id: z.string().nullable(),
	destination: RefUrlDestination,
	public_url: z.string().url(),
	uses: z.number().int(),
	enabled: z.boolean(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const RefUrlListResponse = paginatedResponse(RefUrlResponse);

export const RefUrlClickSpec = z
	.object({
		contact_id: z.string().min(1),
		idempotency_key: z.string().min(1).max(200),
	})
	.strict();
