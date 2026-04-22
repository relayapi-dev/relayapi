// apps/api/src/routes/automation-entrypoints.ts
//
// Entrypoint CRUD for the Manychat-parity automation engine (spec §9.2).
//
// Entrypoints live under an automation (POST/GET /v1/automations/{id}/entrypoints)
// and are addressable by their own id (GET/PATCH/DELETE /v1/automation-entrypoints/{id}).
// The webhook-inbound kind auto-generates a slug + HMAC secret; the plaintext
// secret is returned once (on create / rotate) and never read back.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	automationEntrypoints,
	automations,
	generateId,
} from "@relayapi/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { encryptToken } from "../lib/crypto";
import { assertWorkspaceScope } from "../lib/workspace-scope";
import {
	EntrypointCreateSchema,
	EntrypointUpdateSchema,
	validateEntrypointConfig,
} from "../schemas/automation-entrypoints";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import { armScheduleEntrypoint } from "../services/automations/scheduler";
import { computeSpecificity } from "../services/automations/trigger-matcher";
import type { Env, Variables } from "../types";
import {
	aggregateInsights,
	EntrypointInsightsQuery,
	InsightsResponseSchema,
	type InsightsResponse,
} from "./_automation-insights";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET_MASK = "••••";

type EntrypointRow = typeof automationEntrypoints.$inferSelect;

function maskSecret(config: Record<string, unknown> | null): Record<string, unknown> | null {
	if (!config) return config;
	if (typeof config.webhook_secret === "string") {
		return { ...config, webhook_secret: SECRET_MASK };
	}
	return config;
}

const EntrypointResponseSchema = z.object({
	id: z.string(),
	automation_id: z.string(),
	channel: z.enum(["instagram", "facebook", "whatsapp", "telegram"]),
	kind: z.string(),
	status: z.string(),
	social_account_id: z.string().nullable(),
	config: z.record(z.string(), z.any()).nullable(),
	filters: z.record(z.string(), z.any()).nullable(),
	allow_reentry: z.boolean(),
	reentry_cooldown_min: z.number(),
	priority: z.number(),
	specificity: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
});

const EntrypointCreateResponseSchema = EntrypointResponseSchema.extend({
	webhook_secret_plaintext: z
		.string()
		.optional()
		.describe("Plaintext HMAC secret — returned only on create/rotate for webhook_inbound entrypoints."),
	scheduling: z
		.object({
			queued: z.boolean(),
			reason: z.string().optional(),
		})
		.optional()
		.describe(
			"Result of the auto-arm attempt for schedule entrypoints: queued=true means an initial scheduled_trigger job was inserted; queued=false carries a reason code (e.g. automation_not_active, invalid_cron, no_cron).",
		),
});

function serializeEntrypoint(
	row: EntrypointRow,
	opts: { revealSecret?: string } = {},
): z.infer<typeof EntrypointCreateResponseSchema> {
	const cfg = (row.config ?? {}) as Record<string, unknown>;
	const base = {
		id: row.id,
		automation_id: row.automationId,
		channel: row.channel as z.infer<typeof EntrypointResponseSchema>["channel"],
		kind: row.kind,
		status: row.status,
		social_account_id: row.socialAccountId ?? null,
		config: maskSecret(cfg),
		filters: (row.filters as Record<string, unknown> | null) ?? null,
		allow_reentry: row.allowReentry,
		reentry_cooldown_min: row.reentryCooldownMin,
		priority: row.priority,
		specificity: row.specificity,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
	if (opts.revealSecret) {
		return { ...base, webhook_secret_plaintext: opts.revealSecret };
	}
	return base;
}

function notFound(c: any, label = "Entrypoint") {
	return c.json(
		{ error: { code: "NOT_FOUND", message: `${label} not found` } },
		404,
	);
}

async function loadScopedAutomation(c: any, id: string) {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const [row] = await db
		.select()
		.from(automations)
		.where(and(eq(automations.id, id), eq(automations.organizationId, orgId)))
		.limit(1);
	if (!row) return null;
	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return { denied };
	return { row };
}

async function loadScopedEntrypoint(c: any, id: string) {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const [result] = await db
		.select({
			ep: automationEntrypoints,
			automation: automations,
		})
		.from(automationEntrypoints)
		.innerJoin(
			automations,
			eq(automationEntrypoints.automationId, automations.id),
		)
		.where(
			and(
				eq(automationEntrypoints.id, id),
				eq(automations.organizationId, orgId),
			),
		)
		.limit(1);
	if (!result) return null;
	const denied = assertWorkspaceScope(c, result.automation.workspaceId);
	if (denied) return { denied };
	return { ep: result.ep, automation: result.automation };
}

function randomSecretHex(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return Array.from(buf)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AutomationIdParams = z.object({ id: z.string() });
const EntrypointIdParams = z.object({ id: z.string() });

const ListResponse = z.object({
	data: z.array(EntrypointResponseSchema),
});

// ---------------------------------------------------------------------------
// Routes mounted under /v1/automations (automation-scoped list + create)
// ---------------------------------------------------------------------------

export const automationScopedEntrypoints = new OpenAPIHono<{
	Bindings: Env;
	Variables: Variables;
}>();

const listEntrypoints = createRoute({
	operationId: "listAutomationEntrypoints",
	method: "get",
	path: "/{id}/entrypoints",
	tags: ["Automation Entrypoints"],
	summary: "List entrypoints for an automation",
	security: [{ Bearer: [] }],
	request: { params: AutomationIdParams },
	responses: {
		200: {
			description: "Entrypoint list",
			content: { "application/json": { schema: ListResponse } },
		},
		404: {
			description: "Automation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

automationScopedEntrypoints.openapi(listEntrypoints, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedAutomation(c, id);
	if (!scoped) return notFound(c, "Automation");
	if ("denied" in scoped) return scoped.denied as never;

	const db = c.get("db");
	const rows = await db
		.select()
		.from(automationEntrypoints)
		.where(eq(automationEntrypoints.automationId, id))
		.orderBy(
			desc(automationEntrypoints.specificity),
			asc(automationEntrypoints.priority),
			asc(automationEntrypoints.createdAt),
		);

	return c.json({ data: rows.map((r) => serializeEntrypoint(r)) }, 200);
});

const createEntrypoint = createRoute({
	operationId: "createAutomationEntrypoint",
	method: "post",
	path: "/{id}/entrypoints",
	tags: ["Automation Entrypoints"],
	summary: "Create an entrypoint under an automation",
	security: [{ Bearer: [] }],
	request: {
		params: AutomationIdParams,
		body: {
			content: { "application/json": { schema: EntrypointCreateSchema } },
		},
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: EntrypointCreateResponseSchema } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Automation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

automationScopedEntrypoints.openapi(createEntrypoint, async (c) => {
	const { id: automationId } = c.req.valid("param");
	const body = c.req.valid("json");

	const scoped = await loadScopedAutomation(c, automationId);
	if (!scoped) return notFound(c, "Automation");
	if ("denied" in scoped) return scoped.denied as never;

	// For webhook_inbound, auto-generate slug + plaintext secret and inject them
	// into the config BEFORE validation so the schema sees the required keys.
	let config: Record<string, unknown> = { ...(body.config ?? {}) };
	let plaintextSecret: string | null = null;

	if (body.kind === "webhook_inbound") {
		if (typeof config.webhook_slug !== "string" || !config.webhook_slug) {
			// Drop the generateId prefix — the slug is user-visible in a URL and
			// shouldn't carry the internal resource prefix. Keep 16 hex chars of
			// entropy for uniqueness.
			config.webhook_slug = generateId("whk_").slice("whk_".length);
		}
		plaintextSecret = randomSecretHex(32);
		// The validator needs the secret to be a string; store plaintext here so
		// validation passes. We'll replace with the encrypted value before insert.
		config.webhook_secret = plaintextSecret;
	}

	const parsed = validateEntrypointConfig(body.kind, config);
	if (!parsed.success) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: `invalid config for kind ${body.kind}`,
					details: { errors: parsed.error.issues },
				},
			},
			400,
		);
	}
	config = parsed.data as Record<string, unknown>;

	if (body.kind === "webhook_inbound" && plaintextSecret) {
		// Store an encrypted secret at rest. If ENCRYPTION_KEY is missing we fall
		// back to plaintext so local dev without a key still works — the on-wire
		// response has already captured the plaintext separately.
		const envKey = (c.env as any).ENCRYPTION_KEY as string | undefined;
		config.webhook_secret = envKey
			? await encryptToken(plaintextSecret, envKey)
			: plaintextSecret;
	}

	const specificity = computeSpecificity(
		body.kind,
		config,
		body.filters ?? null,
		body.social_account_id ?? null,
	);

	const db = c.get("db");
	const [inserted] = await db
		.insert(automationEntrypoints)
		.values({
			automationId,
			channel: body.channel,
			kind: body.kind,
			socialAccountId: body.social_account_id ?? null,
			config,
			filters: body.filters ?? null,
			allowReentry: body.allow_reentry ?? true,
			reentryCooldownMin: body.reentry_cooldown_min ?? 60,
			priority: body.priority ?? 100,
			specificity,
		})
		.returning();
	if (!inserted) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "failed to create entrypoint",
				},
			},
			400,
		);
	}

	// Self-arm a newly created schedule entrypoint so the first cron tick
	// actually fires. Without this, the entrypoint just sits there until
	// something else (manual test job, unrelated deploy) happens to
	// enqueue a scheduled_trigger row.
	let scheduling: { queued: boolean; reason?: string } | undefined;
	if (inserted.kind === "schedule" && inserted.status === "active") {
		const result = await armScheduleEntrypoint(db, inserted.id);
		scheduling = {
			queued: result.queued,
			...(result.reason ? { reason: result.reason } : {}),
		};
	}

	const body201 = serializeEntrypoint(inserted, {
		revealSecret: plaintextSecret ?? undefined,
	});
	return c.json(
		scheduling ? { ...body201, scheduling } : body201,
		201,
	);
});

// ---------------------------------------------------------------------------
// Routes mounted under /v1/automation-entrypoints (id-addressed)
// ---------------------------------------------------------------------------

const getEntrypoint = createRoute({
	operationId: "getAutomationEntrypoint",
	method: "get",
	path: "/{id}",
	tags: ["Automation Entrypoints"],
	summary: "Get an entrypoint by id",
	security: [{ Bearer: [] }],
	request: { params: EntrypointIdParams },
	responses: {
		200: {
			description: "Entrypoint",
			content: { "application/json": { schema: EntrypointResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getEntrypoint, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedEntrypoint(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;
	return c.json(serializeEntrypoint(scoped.ep), 200);
});

const updateEntrypoint = createRoute({
	operationId: "updateAutomationEntrypoint",
	method: "patch",
	path: "/{id}",
	tags: ["Automation Entrypoints"],
	summary: "Update an entrypoint",
	security: [{ Bearer: [] }],
	request: {
		params: EntrypointIdParams,
		body: {
			content: { "application/json": { schema: EntrypointUpdateSchema } },
		},
	},
	responses: {
		200: {
			description: "Updated",
			content: {
				"application/json": { schema: EntrypointCreateResponseSchema },
			},
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateEntrypoint, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");

	const scoped = await loadScopedEntrypoint(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;
	const { ep: existing } = scoped;

	const patch: Partial<typeof automationEntrypoints.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (body.channel !== undefined) patch.channel = body.channel;
	if (body.kind !== undefined) patch.kind = body.kind;
	if (body.social_account_id !== undefined) {
		patch.socialAccountId = body.social_account_id ?? null;
	}
	if (body.allow_reentry !== undefined) patch.allowReentry = body.allow_reentry;
	if (body.reentry_cooldown_min !== undefined) {
		patch.reentryCooldownMin = body.reentry_cooldown_min;
	}
	if (body.priority !== undefined) patch.priority = body.priority;
	if (body.status !== undefined) patch.status = body.status;
	if (body.filters !== undefined) {
		patch.filters = body.filters ?? null;
	}

	// If config or the kind or filters changed, re-validate + recompute specificity.
	let resolvedConfig: Record<string, unknown> | null = null;
	if (body.config !== undefined || body.kind !== undefined) {
		const kind = body.kind ?? existing.kind;
		const config = (body.config ??
			(existing.config as Record<string, unknown>)) as Record<string, unknown>;
		const parsed = validateEntrypointConfig(kind, config);
		if (!parsed.success) {
			return c.json(
				{
					error: {
						code: "VALIDATION_ERROR",
						message: `invalid config for kind ${kind}`,
						details: { errors: parsed.error.issues },
					},
				},
				400,
			);
		}
		resolvedConfig = parsed.data as Record<string, unknown>;
		patch.config = resolvedConfig;
	}

	// Recompute specificity if any input changed.
	if (
		body.config !== undefined ||
		body.kind !== undefined ||
		body.filters !== undefined ||
		body.social_account_id !== undefined
	) {
		patch.specificity = computeSpecificity(
			body.kind ?? existing.kind,
			resolvedConfig ?? (existing.config as Record<string, unknown>),
			body.filters !== undefined
				? body.filters ?? null
				: (existing.filters as Record<string, unknown> | null),
			body.social_account_id !== undefined
				? body.social_account_id ?? null
				: existing.socialAccountId,
		);
	}

	const db = c.get("db");
	const [updated] = await db
		.update(automationEntrypoints)
		.set(patch)
		.where(eq(automationEntrypoints.id, id))
		.returning();
	if (!updated) return notFound(c);

	// Re-arm on transitions that could have introduced or changed a
	// schedule firing:
	//   - inactive → active (any kind — only fires when schedule)
	//   - kind changed while active
	//   - cron / timezone in config changed while active
	// The `insertNextScheduledJobIfNotExists` dedupe (±1s window) absorbs
	// double-arming, so we err on the side of arming more often.
	const wasActive = existing.status === "active";
	const isActive = updated.status === "active";
	const kindChanged = existing.kind !== updated.kind;
	const prevCfg = (existing.config ?? {}) as {
		cron?: string;
		timezone?: string;
	};
	const nextCfg = (updated.config ?? {}) as {
		cron?: string;
		timezone?: string;
	};
	const cronChanged =
		prevCfg.cron !== nextCfg.cron || prevCfg.timezone !== nextCfg.timezone;
	const becameActive = !wasActive && isActive;
	const shouldRearm =
		updated.kind === "schedule" &&
		isActive &&
		(becameActive || kindChanged || cronChanged);
	let scheduling: { queued: boolean; reason?: string } | undefined;
	if (shouldRearm) {
		const result = await armScheduleEntrypoint(db, updated.id);
		scheduling = {
			queued: result.queued,
			...(result.reason ? { reason: result.reason } : {}),
		};
	}

	const serialized = serializeEntrypoint(updated);
	return c.json(
		scheduling ? { ...serialized, scheduling } : serialized,
		200,
	);
});

const deleteEntrypoint = createRoute({
	operationId: "deleteAutomationEntrypoint",
	method: "delete",
	path: "/{id}",
	tags: ["Automation Entrypoints"],
	summary: "Delete an entrypoint",
	security: [{ Bearer: [] }],
	request: { params: EntrypointIdParams },
	responses: {
		204: { description: "Deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteEntrypoint, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedEntrypoint(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;

	const db = c.get("db");
	await db.delete(automationEntrypoints).where(eq(automationEntrypoints.id, id));
	return c.body(null, 204);
});

const rotateSecret = createRoute({
	operationId: "rotateAutomationEntrypointSecret",
	method: "post",
	path: "/{id}/rotate-secret",
	tags: ["Automation Entrypoints"],
	summary: "Rotate the HMAC secret for a webhook_inbound entrypoint",
	security: [{ Bearer: [] }],
	request: { params: EntrypointIdParams },
	responses: {
		200: {
			description: "Rotated",
			content: {
				"application/json": { schema: EntrypointCreateResponseSchema },
			},
		},
		400: {
			description: "Not a webhook entrypoint",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(rotateSecret, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedEntrypoint(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;
	const { ep } = scoped;

	if (ep.kind !== "webhook_inbound") {
		return c.json(
			{
				error: {
					code: "INVALID_KIND",
					message: "rotate-secret is only valid for webhook_inbound entrypoints",
				},
			},
			400,
		);
	}

	const plaintext = randomSecretHex(32);
	const envKey = (c.env as any).ENCRYPTION_KEY as string | undefined;
	const stored = envKey ? await encryptToken(plaintext, envKey) : plaintext;

	const nextConfig = {
		...((ep.config as Record<string, unknown> | null) ?? {}),
		webhook_secret: stored,
	};

	const db = c.get("db");
	const [updated] = await db
		.update(automationEntrypoints)
		.set({ config: nextConfig, updatedAt: new Date() })
		.where(eq(automationEntrypoints.id, id))
		.returning();
	if (!updated) return notFound(c);

	return c.json(
		serializeEntrypoint(updated, { revealSecret: plaintext }),
		200,
	);
});

// ---------------------------------------------------------------------------
// Entrypoint insights (G8)
// ---------------------------------------------------------------------------

const entrypointInsights = createRoute({
	operationId: "getAutomationEntrypointInsights",
	method: "get",
	path: "/{id}/insights",
	tags: ["Automation Entrypoints"],
	summary: "Aggregate run metrics scoped to an entrypoint",
	security: [{ Bearer: [] }],
	request: {
		params: EntrypointIdParams,
		query: EntrypointInsightsQuery,
	},
	responses: {
		200: {
			description: "Insights",
			content: { "application/json": { schema: InsightsResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(entrypointInsights, async (c) => {
	const { id } = c.req.valid("param");
	const query = c.req.valid("query");
	const scoped = await loadScopedEntrypoint(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;

	const db = c.get("db");
	const result = await aggregateInsights(db, query, {
		orgId: c.get("orgId"),
		entrypointId: id,
	});
	return c.json(result, 200);
});

export default app;
