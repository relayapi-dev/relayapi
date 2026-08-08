import {
	createDb,
	landingPages,
	organization,
	qrCodes,
	refUrls,
	workspaces,
} from "@relayapi/db";
import { and, eq, isNull } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import {
	materializeBoundedRequestBody,
	preflightBoundedRequestBody,
	seedBoundedRequestBody,
	UnsupportedRequestMediaTypeError,
} from "../lib/bounded-request-body";
import { sha256Hex } from "../lib/durable-operation";
import { ResponseTooLargeError } from "../lib/fetch-public-url";
import {
	landingPagePublicUrl,
	type PublicResourceScope,
	publicGrowthIdempotencyKey,
	qrScanUrl,
} from "../lib/public-growth";
import { renderQrSvg } from "../lib/qr-renderer";
import {
	LandingPageConfig,
	LandingPageConversionSpec,
} from "../schemas/landing-pages";
import {
	recordLandingConversion,
	recordLandingView,
	recordQrScan,
	recordRefVisit,
} from "../services/public-growth-events";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();
type PublicContext = Context<{ Bindings: Env }>;
export const LANDING_CONVERSION_MAX_BODY_BYTES = 16 * 1024;
const LANDING_CONVERSION_MEDIA_TYPES = [
	"application/json",
	"application/x-www-form-urlencoded",
	"multipart/form-data",
] as const;

const publicGrowthRateLimit: MiddlewareHandler<{ Bindings: Env }> = async (
	c,
	next,
) => {
	const connectingIp = c.req.header("CF-Connecting-IP")?.trim() || "local";
	const digest = await sha256Hex(`public-growth-rate-limit:v1:${connectingIp}`);
	const { success } = await c.env.FREE_RATE_LIMITER.limit({
		key: `pg:${digest.slice(0, 48)}`,
	});
	if (!success) {
		c.header("Retry-After", "60");
		return c.json(
			{
				error: {
					code: "RATE_LIMITED",
					message: "Too many public-link requests. Please try again shortly.",
				},
			},
			429,
		);
	}
	await next();
};

app.use("/r/*", publicGrowthRateLimit);
app.use("/q/*", publicGrowthRateLimit);
app.use("/l/*", publicGrowthRateLimit);

type ResolvedScope =
	| {
			kind: "organization";
			organizationId: string;
			organizationSlug: string;
	  }
	| {
			kind: "workspace";
			organizationId: string;
			organizationSlug: string;
			workspaceId: string;
			workspaceSlug: string;
	  };

function notFound(): Response {
	return new Response("Not found", {
		status: 404,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function scopeFromParams(
	organizationId: string,
	organizationSlug: string,
	workspaceId?: string,
	workspaceSlug?: string,
): ResolvedScope {
	return workspaceId && workspaceSlug
		? {
				kind: "workspace",
				organizationId,
				organizationSlug,
				workspaceId,
				workspaceSlug,
			}
		: { kind: "organization", organizationId, organizationSlug };
}

async function resolveRef(
	db: ReturnType<typeof createDb>,
	input: {
		organizationId: string;
		workspaceId?: string;
		refId: string;
	},
) {
	const [row] = await db
		.select({
			ref: refUrls,
			organizationSlug: organization.slug,
			workspaceSlug: workspaces.slug,
			landingEnabled: landingPages.enabled,
			landingSlug: landingPages.slug,
		})
		.from(refUrls)
		.innerJoin(organization, eq(organization.id, refUrls.organizationId))
		.leftJoin(
			workspaces,
			and(
				eq(workspaces.id, refUrls.workspaceId),
				eq(workspaces.organizationId, refUrls.organizationId),
			),
		)
		.leftJoin(
			landingPages,
			and(
				eq(landingPages.id, refUrls.landingPageId),
				eq(landingPages.organizationId, refUrls.organizationId),
				eq(landingPages.scopeKey, refUrls.scopeKey),
			),
		)
		.where(
			and(
				eq(organization.id, input.organizationId),
				eq(organization.lifecycleStatus, "active"),
				eq(refUrls.id, input.refId),
				eq(refUrls.enabled, true),
				input.workspaceId
					? and(
							eq(workspaces.id, input.workspaceId),
							eq(workspaces.lifecycleStatus, "active"),
						)
					: isNull(refUrls.workspaceId),
			),
		)
		.limit(1);
	return row;
}

async function resolvePage(
	db: ReturnType<typeof createDb>,
	input: {
		organizationId: string;
		workspaceId?: string;
		pageId: string;
	},
) {
	const [row] = await db
		.select({
			page: landingPages,
			organizationSlug: organization.slug,
			workspaceSlug: workspaces.slug,
		})
		.from(landingPages)
		.innerJoin(organization, eq(organization.id, landingPages.organizationId))
		.leftJoin(
			workspaces,
			and(
				eq(workspaces.id, landingPages.workspaceId),
				eq(workspaces.organizationId, landingPages.organizationId),
			),
		)
		.where(
			and(
				eq(organization.id, input.organizationId),
				eq(organization.lifecycleStatus, "active"),
				eq(landingPages.id, input.pageId),
				eq(landingPages.enabled, true),
				input.workspaceId
					? and(
							eq(workspaces.id, input.workspaceId),
							eq(workspaces.lifecycleStatus, "active"),
						)
					: isNull(landingPages.workspaceId),
			),
		)
		.limit(1);
	return row;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderLandingPage(input: {
	title: string;
	config: ReturnType<typeof LandingPageConfig.parse>;
	conversionPath: string;
	idempotencyKey: string;
}): string {
	const { theme } = input.config;
	const font =
		theme.font === "serif"
			? "ui-serif, Georgia, Cambria, serif"
			: "ui-sans-serif, system-ui, sans-serif";
	const blocks = input.config.blocks
		.map((block) => {
			switch (block.type) {
				case "heading": {
					const tag = `h${block.level}`;
					return `<${tag}>${escapeHtml(block.text)}</${tag}>`;
				}
				case "text":
					return `<p class="copy">${escapeHtml(block.text)}</p>`;
				case "image":
					return `<img src="${escapeHtml(block.url)}" alt="${escapeHtml(block.alt)}" loading="lazy" referrerpolicy="no-referrer">`;
				case "cta":
					return `<p><a class="cta" href="${escapeHtml(block.url)}" rel="noopener noreferrer">${escapeHtml(block.label)}</a></p>`;
				case "form":
					return `<form method="post" action="${escapeHtml(input.conversionPath)}">
						<input type="hidden" name="idempotency_key" value="${escapeHtml(input.idempotencyKey)}">
						${block.fields
							.map((field) => {
								const type =
									field.key === "email"
										? "email"
										: field.key === "phone"
											? "tel"
											: "text";
								const autocomplete =
									field.key === "name"
										? "name"
										: field.key === "email"
											? "email"
											: "tel";
								return `<label>${escapeHtml(field.label)}
									<input name="${field.key}" type="${type}" autocomplete="${autocomplete}"${field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : ""}${field.required ? " required" : ""}>
								</label>`;
							})
							.join("")}
						<button type="submit">${escapeHtml(block.submit_label)}</button>
					</form>`;
				default: {
					const unreachable: never = block;
					return unreachable;
				}
			}
		})
		.join("");
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escapeHtml(input.title)}</title>
	<style>
		:root { color-scheme: ${theme.mode}; }
		* { box-sizing: border-box; }
		body { margin: 0; background: ${theme.background_color}; color: ${theme.text_color}; font-family: ${font}; }
		main { width: min(100% - 2rem, 44rem); margin: 0 auto; padding: 4rem 0; }
		h1, h2, h3 { line-height: 1.15; }
		.copy { white-space: pre-wrap; line-height: 1.65; }
		img { display: block; max-width: 100%; height: auto; border-radius: .75rem; }
		.cta, button { display: inline-block; border: 0; border-radius: .55rem; background: ${theme.accent_color}; color: #fff; padding: .8rem 1.1rem; font: inherit; font-weight: 650; text-decoration: none; cursor: pointer; }
		form { display: grid; gap: 1rem; margin-top: 1.5rem; }
		label { display: grid; gap: .4rem; font-weight: 600; }
		input { width: 100%; border: 1px solid color-mix(in srgb, ${theme.text_color} 28%, transparent); border-radius: .5rem; background: ${theme.background_color}; color: ${theme.text_color}; padding: .75rem; font: inherit; }
	</style>
</head>
<body><main>${blocks}</main></body>
</html>`;
}

function landingHeaders(): Record<string, string> {
	return {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy":
			"default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	};
}

async function handleRef(c: PublicContext, workspaceId?: string) {
	const db = createDb(c.env.HYPERDRIVE.connectionString);
	const params = c.req.param();
	if (!params.organizationId || !params.refId) return notFound();
	const row = await resolveRef(db, {
		organizationId: params.organizationId,
		workspaceId,
		refId: params.refId,
	});
	if (
		!row ||
		(row.ref.destinationType === "landing_page" &&
			(!row.landingEnabled || !row.landingSlug))
	) {
		return notFound();
	}
	const recorded = await recordRefVisit(db, {
		organizationId: row.ref.organizationId,
		refUrlId: row.ref.id,
		idempotencyKey: publicGrowthIdempotencyKey(c.req.raw.headers),
	});
	if (!recorded.ok) return notFound();
	const scope = scopeFromParams(
		row.ref.organizationId,
		row.organizationSlug,
		row.ref.workspaceId ?? undefined,
		row.workspaceSlug ?? undefined,
	);
	const destination =
		row.ref.destinationType === "https_url"
			? row.ref.destinationUrl
			: landingPagePublicUrl(
					c.env,
					scope as PublicResourceScope,
					row.ref.landingPageId ?? "",
					row.landingSlug ?? "",
				);
	if (!destination) return notFound();
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	return c.redirect(destination, 302);
}

app.get("/r/:organizationId/:organizationSlug/o/:refId/:slug", (c) =>
	handleRef(c),
);
app.get(
	"/r/:organizationId/:organizationSlug/w/:workspaceId/:workspaceSlug/:refId/:slug",
	(c) => handleRef(c, c.req.param("workspaceId")),
);

app.get("/q/:publicId", async (c) => {
	const db = createDb(c.env.HYPERDRIVE.connectionString);
	const rawPublicId = c.req.param("publicId");
	if (!rawPublicId) return notFound();
	const wantsSvg = rawPublicId.endsWith(".svg");
	const publicId = wantsSvg ? rawPublicId.slice(0, -4) : rawPublicId;
	if (!publicId) return notFound();
	if (wantsSvg) {
		const [qr] = await db
			.select({ id: qrCodes.id })
			.from(qrCodes)
			.where(eq(qrCodes.publicId, publicId))
			.limit(1);
		if (!qr) return notFound();
		const svg = await renderQrSvg(qrScanUrl(c.env, publicId));
		return c.body(svg, 200, {
			"Content-Type": "image/svg+xml; charset=utf-8",
			"Cache-Control": "public, max-age=31536000, immutable",
			"Content-Security-Policy": "default-src 'none'; sandbox",
			"X-Content-Type-Options": "nosniff",
		});
	}
	const recorded = await recordQrScan(db, {
		publicId,
		idempotencyKey: publicGrowthIdempotencyKey(c.req.raw.headers),
	});
	if (!recorded.ok) return notFound();
	const ref = recorded.value.refUrl;
	let destination = ref.destinationUrl;
	if (ref.destinationType === "landing_page" && ref.landingPageId) {
		const [page] = await db
			.select({
				id: landingPages.id,
				slug: landingPages.slug,
				enabled: landingPages.enabled,
				organizationId: landingPages.organizationId,
				organizationSlug: organization.slug,
				workspaceId: landingPages.workspaceId,
				workspaceSlug: workspaces.slug,
			})
			.from(landingPages)
			.innerJoin(organization, eq(organization.id, landingPages.organizationId))
			.leftJoin(
				workspaces,
				and(
					eq(workspaces.id, landingPages.workspaceId),
					eq(workspaces.organizationId, landingPages.organizationId),
				),
			)
			.where(eq(landingPages.id, ref.landingPageId))
			.limit(1);
		if (!page?.enabled) return notFound();
		const scope = scopeFromParams(
			page.organizationId,
			page.organizationSlug,
			page.workspaceId ?? undefined,
			page.workspaceSlug ?? undefined,
		);
		destination = landingPagePublicUrl(
			c.env,
			scope as PublicResourceScope,
			page.id,
			page.slug,
		);
	}
	if (!destination) return notFound();
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	return c.redirect(destination, 302);
});

async function handleLanding(c: PublicContext, workspaceId?: string) {
	const db = createDb(c.env.HYPERDRIVE.connectionString);
	const params = c.req.param();
	if (!params.organizationId || !params.pageId) return notFound();
	const row = await resolvePage(db, {
		organizationId: params.organizationId,
		workspaceId,
		pageId: params.pageId,
	});
	if (!row) return notFound();
	const config = LandingPageConfig.safeParse(row.page.config);
	if (!config.success) return notFound();
	const recorded = await recordLandingView(db, {
		organizationId: row.page.organizationId,
		landingPageId: row.page.id,
		idempotencyKey: publicGrowthIdempotencyKey(c.req.raw.headers),
	});
	if (!recorded.ok) return notFound();
	const conversionPath = `${new URL(c.req.url).pathname}/conversions`;
	return c.html(
		renderLandingPage({
			title: row.page.title,
			config: config.data,
			conversionPath,
			idempotencyKey: crypto.randomUUID(),
		}),
		200,
		landingHeaders(),
	);
}

app.get("/l/:organizationId/:organizationSlug/o/:pageId/:slug", (c) =>
	handleLanding(c),
);
app.get(
	"/l/:organizationId/:organizationSlug/w/:workspaceId/:workspaceSlug/:pageId/:slug",
	(c) => handleLanding(c, c.req.param("workspaceId")),
);

export async function parseConversionRequest(c: PublicContext): Promise<
	| {
			ok: true;
			parsed: ReturnType<typeof LandingPageConversionSpec.safeParse>;
			wantsJson: boolean;
	  }
	| { ok: false; response: Response }
> {
	let mediaType: (typeof LANDING_CONVERSION_MEDIA_TYPES)[number];
	try {
		mediaType = preflightBoundedRequestBody(
			c.req.raw,
			LANDING_CONVERSION_MAX_BODY_BYTES,
			LANDING_CONVERSION_MEDIA_TYPES,
		);
	} catch (error) {
		if (error instanceof ResponseTooLargeError) {
			return {
				ok: false,
				response: c.json(
					{
						error: {
							code: "PAYLOAD_TOO_LARGE",
							message: "The request body is too large",
						},
					},
					413,
				),
			};
		}
		if (error instanceof UnsupportedRequestMediaTypeError) {
			return {
				ok: false,
				response: c.json(
					{
						error: {
							code: "UNSUPPORTED_MEDIA_TYPE",
							message: "The request media type is not supported",
						},
					},
					415,
				),
			};
		}
		throw error;
	}

	let bytes: ArrayBuffer;
	try {
		bytes = await materializeBoundedRequestBody(
			c.req.raw,
			LANDING_CONVERSION_MAX_BODY_BYTES,
		);
	} catch (error) {
		if (!(error instanceof ResponseTooLargeError)) throw error;
		return {
			ok: false,
			response: c.json(
				{
					error: {
						code: "PAYLOAD_TOO_LARGE",
						message: "The request body is too large",
					},
				},
				413,
			),
		};
	}
	seedBoundedRequestBody(c.req, bytes);

	try {
		if (mediaType === "application/json") {
			return {
				ok: true,
				parsed: LandingPageConversionSpec.safeParse(await c.req.json()),
				wantsJson: true,
			};
		}

		const entries: Array<readonly [string, unknown]> =
			mediaType === "application/x-www-form-urlencoded"
				? Array.from(
						new URLSearchParams(new TextDecoder().decode(bytes)).entries(),
					)
				: Object.entries(await c.req.parseBody({ all: true }));
		const values: Partial<
			Record<"idempotency_key" | "name" | "email" | "phone", string>
		> = {};
		const allowedFields = new Set([
			"idempotency_key",
			"name",
			"email",
			"phone",
		]);
		for (const [key, value] of entries) {
			if (
				!allowedFields.has(key) ||
				Object.hasOwn(values, key) ||
				Array.isArray(value) ||
				typeof value !== "string"
			) {
				// Reject unknown/duplicate fields and multipart File values before
				// schema parsing. The bounded byte read has already capped parser cost.
				return {
					ok: true,
					parsed: LandingPageConversionSpec.safeParse({}),
					wantsJson: false,
				};
			}
			values[key as keyof typeof values] = value;
		}
		if (entries.length > 4) {
			return {
				ok: true,
				parsed: LandingPageConversionSpec.safeParse({}),
				wantsJson: false,
			};
		}

		return {
			ok: true,
			parsed: LandingPageConversionSpec.safeParse({
				idempotency_key: values.idempotency_key ?? "",
				fields: {
					name: values.name || undefined,
					email: values.email || undefined,
					phone: values.phone || undefined,
				},
			}),
			wantsJson: false,
		};
	} catch {
		return {
			ok: true,
			parsed: LandingPageConversionSpec.safeParse({}),
			wantsJson: mediaType === "application/json",
		};
	}
}

async function handleConversion(c: PublicContext, workspaceId?: string) {
	const request = await parseConversionRequest(c);
	if (!request.ok) return request.response;
	const { parsed, wantsJson } = request;
	if (!parsed.success) {
		return wantsJson
			? c.json(
					{
						error: {
							code: "INVALID_FORM",
							message: "Submitted form fields are invalid.",
						},
					},
					400,
				)
			: c.html("<h1>Invalid form submission</h1>", 400, landingHeaders());
	}
	const db = createDb(c.env.HYPERDRIVE.connectionString);
	const params = c.req.param();
	if (!params.organizationId || !params.pageId) return notFound();
	const row = await resolvePage(db, {
		organizationId: params.organizationId,
		workspaceId,
		pageId: params.pageId,
	});
	if (!row) return notFound();
	const result = await recordLandingConversion(db, {
		organizationId: row.page.organizationId,
		landingPageId: row.page.id,
		idempotencyKey: parsed.data.idempotency_key,
		fields: parsed.data.fields,
		keyConfig: c.env.ENCRYPTION_KEY,
	});
	if (!result.ok) {
		const message = result.message ?? "Form submission was not accepted.";
		return wantsJson
			? c.json({ error: { code: "INVALID_FORM", message } }, 400)
			: c.html(`<h1>${escapeHtml(message)}</h1>`, 400, landingHeaders());
	}
	return wantsJson
		? c.json({ ok: true, replayed: !result.inserted }, 201)
		: c.html(
				`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title></head><body><main><h1>${escapeHtml(result.value.successMessage)}</h1></main></body></html>`,
				200,
				landingHeaders(),
			);
}

app.post(
	"/l/:organizationId/:organizationSlug/o/:pageId/:slug/conversions",
	(c) => handleConversion(c),
);
app.post(
	"/l/:organizationId/:organizationSlug/w/:workspaceId/:workspaceSlug/:pageId/:slug/conversions",
	(c) => handleConversion(c, c.req.param("workspaceId")),
);

export default app;
