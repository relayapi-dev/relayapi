import { z } from "@hono/zod-openapi";
import { isContactPhone } from "../lib/contact-phone";
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
			message: "Only HTTPS URLs without embedded credentials are allowed",
		},
	);

const BlockId = z
	.string()
	.min(1)
	.max(80)
	.regex(/^[a-zA-Z0-9_-]+$/);

export const LandingPageTheme = z
	.object({
		mode: z.enum(["light", "dark"]),
		background_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		text_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
		font: z.enum(["sans", "serif"]),
	})
	.strict();

export const LandingPageFormField = z
	.object({
		key: z.enum(["name", "email", "phone"]),
		label: z.string().trim().min(1).max(100),
		required: z.boolean(),
		placeholder: z.string().trim().max(160).optional(),
	})
	.strict();

export const LandingPageBlock = z.discriminatedUnion("type", [
	z
		.object({
			id: BlockId,
			type: z.literal("heading"),
			level: z.number().int().min(1).max(3),
			text: z.string().trim().min(1).max(500),
		})
		.strict(),
	z
		.object({
			id: BlockId,
			type: z.literal("text"),
			text: z.string().trim().min(1).max(10_000),
		})
		.strict(),
	z
		.object({
			id: BlockId,
			type: z.literal("image"),
			url: HttpsUrl,
			alt: z.string().trim().max(500),
		})
		.strict(),
	z
		.object({
			id: BlockId,
			type: z.literal("form"),
			fields: z.array(LandingPageFormField).min(1).max(3),
			submit_label: z.string().trim().min(1).max(100),
			success_message: z.string().trim().min(1).max(500),
		})
		.strict(),
	z
		.object({
			id: BlockId,
			type: z.literal("cta"),
			label: z.string().trim().min(1).max(160),
			url: HttpsUrl,
		})
		.strict(),
]);

export const LandingPageConfig = z
	.object({
		version: z.literal(1),
		theme: LandingPageTheme,
		blocks: z.array(LandingPageBlock).max(50),
	})
	.strict()
	.superRefine((config, ctx) => {
		const blockIds = new Set<string>();
		let formCount = 0;
		for (const block of config.blocks) {
			if (blockIds.has(block.id)) {
				ctx.addIssue({
					code: "custom",
					message: `Duplicate block id '${block.id}'`,
					path: ["blocks"],
				});
			}
			blockIds.add(block.id);
			if (block.type !== "form") continue;
			formCount += 1;
			const fieldKeys = block.fields.map((field) => field.key);
			if (new Set(fieldKeys).size !== fieldKeys.length) {
				ctx.addIssue({
					code: "custom",
					message: "Form field keys must be unique",
					path: ["blocks"],
				});
			}
			if (!fieldKeys.includes("email") && !fieldKeys.includes("phone")) {
				ctx.addIssue({
					code: "custom",
					message: "A form must collect email or phone to resolve a contact",
					path: ["blocks"],
				});
			}
		}
		if (formCount > 1) {
			ctx.addIssue({
				code: "custom",
				message: "A landing page can contain at most one form",
				path: ["blocks"],
			});
		}
	});

export const LandingPageCreateSpec = z
	.object({
		workspace_id: z.string().optional(),
		slug: Slug,
		title: z.string().trim().min(1).max(255),
		config: LandingPageConfig,
		automation_id: z.string().nullable().optional(),
		enabled: z.boolean().default(true),
	})
	.strict();

export const LandingPageUpdateSpec = z
	.object({
		slug: Slug.optional(),
		title: z.string().trim().min(1).max(255).optional(),
		config: LandingPageConfig.optional(),
		automation_id: z.string().nullable().optional(),
		enabled: z.boolean().optional(),
	})
	.strict();

export const LandingPageResponse = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	slug: z.string(),
	title: z.string(),
	config: LandingPageConfig,
	automation_id: z.string().nullable(),
	visits: z.number().int().nonnegative(),
	conversions: z.number().int().nonnegative(),
	enabled: z.boolean(),
	public_url: z.string().url(),
	conversion_url: z.string().url(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const LandingPageListResponse = paginatedResponse(LandingPageResponse);

export const LandingPageConversionSpec = z
	.object({
		idempotency_key: z.string().min(1).max(200),
		fields: z
			.object({
				name: z.string().trim().min(1).max(255).optional(),
				email: z.string().trim().email().max(320).optional(),
				phone: z
					.string()
					.regex(/^\+[1-9]\d{6,14}$/)
					.refine((value) => isContactPhone(value), {
						message: "Phone must be a possible international number",
					})
					.optional(),
			})
			.strict(),
	})
	.strict();
