// apps/api/src/routes/automation-bindings.ts
//
// Binding CRUD for the Manychat-parity automation engine (spec §9.4).
//
// Bindings connect a social account + binding slot (default_reply, welcome,
// conversation_starter, main_menu, ice_breaker) to a specific automation.
// Live types (default_reply, welcome_message) become "active" immediately;
// stubbed types (conversation_starter, main_menu, ice_breaker) start in
// "pending_sync" and get reconciled by the platform sync worker later.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	automationBindings,
	automations,
	socialAccounts,
} from "@relayapi/db";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import {
	BindingConfigByType,
	BindingCreateSchema,
	BindingUpdateSchema,
} from "../schemas/automation-bindings";
import { ErrorResponse } from "../schemas/common";
import type { Env, Variables } from "../types";
import {
	aggregateInsights,
	BindingInsightsQuery,
	InsightsResponseSchema,
} from "./_automation-insights";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BindingRow = typeof automationBindings.$inferSelect;

const STUBBED_TYPES = new Set([
	"conversation_starter",
	"main_menu",
	"ice_breaker",
]);

function defaultStatusFor(bindingType: string): "active" | "pending_sync" {
	return STUBBED_TYPES.has(bindingType) ? "pending_sync" : "active";
}

const BindingWarningSchema = z.object({
	code: z.string(),
	message: z.string(),
});

const BindingResponseSchema = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	social_account_id: z.string(),
	channel: z.enum(["instagram", "facebook", "whatsapp", "telegram"]),
	binding_type: z.enum([
		"default_reply",
		"welcome_message",
		"conversation_starter",
		"main_menu",
		"ice_breaker",
	]),
	automation_id: z.string(),
	config: z.record(z.string(), z.any()).nullable(),
	status: z.string(),
	last_synced_at: z.string().nullable(),
	sync_error: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	// Optional account hydration — populated by list/get via a left-join so the
	// dashboard (canvas binding cards, bindings panel) can render a real handle
	// instead of a truncated id. Omitted on create/update responses.
	social_account: z
		.object({
			id: z.string(),
			handle: z.string().nullable(),
			display_name: z.string().nullable(),
			avatar_url: z.string().nullable(),
		})
		.nullable()
		.optional(),
	warnings: z.array(BindingWarningSchema).optional(),
});

type BindingAccountSummary = {
	id: string;
	username: string | null;
	displayName: string | null;
	avatarUrl: string | null;
};

/**
 * Stubbed binding types don't actually push to the platform yet — the
 * persistence layer accepts the config but the platform sync worker that
 * would reconcile it into Messenger/WhatsApp UX ships in v1.1. Surface this
 * explicitly on create/update responses so the dashboard can render a banner
 * instead of claiming the binding is live.
 */
export function buildBindingWarnings(
	bindingType: string,
): z.infer<typeof BindingWarningSchema>[] | undefined {
	if (!STUBBED_TYPES.has(bindingType)) return undefined;
	return [
		{
			code: "binding_pending_sync",
			message:
				"Platform sync ships in v1.1; configuration is saved but not yet pushed to the platform.",
		},
	];
}

function serializeBinding(
	row: BindingRow,
	opts?: { includeWarnings?: boolean; account?: BindingAccountSummary | null },
): z.infer<typeof BindingResponseSchema> {
	const base: z.infer<typeof BindingResponseSchema> = {
		id: row.id,
		organization_id: row.organizationId,
		workspace_id: row.workspaceId ?? null,
		social_account_id: row.socialAccountId,
		channel: row.channel as z.infer<typeof BindingResponseSchema>["channel"],
		binding_type: row.bindingType as z.infer<
			typeof BindingResponseSchema
		>["binding_type"],
		automation_id: row.automationId,
		config: (row.config as Record<string, unknown> | null) ?? null,
		status: row.status,
		last_synced_at: row.lastSyncedAt?.toISOString() ?? null,
		sync_error: row.syncError ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
	// `account.id` is null when a left-join finds no row — guard so we omit
	// the field rather than emit an account with a null id.
	if (opts?.account?.id) {
		base.social_account = {
			id: opts.account.id,
			handle: opts.account.username ?? null,
			display_name: opts.account.displayName ?? null,
			avatar_url: opts.account.avatarUrl ?? null,
		};
	}
	if (opts?.includeWarnings) {
		const warnings = buildBindingWarnings(row.bindingType);
		if (warnings) base.warnings = warnings;
	}
	return base;
}

function notFound(c: AppContext) {
	return c.json(
		{ error: { code: "NOT_FOUND", message: "Binding not found" } },
		404,
	);
}

async function loadScopedBinding(c: AppContext, id: string) {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const [row] = await db
		.select()
		.from(automationBindings)
		.where(
			and(
				eq(automationBindings.id, id),
				eq(automationBindings.organizationId, orgId),
			),
		)
		.limit(1);
	if (!row) return null;
	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return { denied };
	return { row };
}

function validateBindingConfig(bindingType: string, config: unknown) {
	const schema = BindingConfigByType[bindingType];
	if (!schema) {
		return {
			success: false,
			error: { issues: [{ message: `unknown binding_type ${bindingType}` }] },
		} as const;
	}
	return schema.safeParse(config);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const IdParams = z.object({ id: z.string() });

const ListQuery = z.object({
	social_account_id: z.string().optional(),
	binding_type: z.string().optional(),
	automation_id: z.string().optional(),
	workspace_id: z.string().optional(),
});

const ListResponse = z.object({ data: z.array(BindingResponseSchema) });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listBindings = createRoute({
	operationId: "listAutomationBindings",
	method: "get",
	path: "/",
	tags: ["Automation Bindings"],
	summary: "List bindings with filters",
	security: [{ Bearer: [] }],
	request: { query: ListQuery },
	responses: {
		200: {
			description: "Binding list",
			content: { "application/json": { schema: ListResponse } },
		},
	},
});

app.openapi(listBindings, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const q = c.req.valid("query");

	const conditions: SQL[] = [eq(automationBindings.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, automationBindings.workspaceId);
	if (q.workspace_id) {
		conditions.push(eq(automationBindings.workspaceId, q.workspace_id));
	}
	if (q.social_account_id) {
		conditions.push(eq(automationBindings.socialAccountId, q.social_account_id));
	}
	if (q.binding_type) {
		conditions.push(
			eq(
				automationBindings.bindingType,
				q.binding_type as typeof automationBindings.$inferSelect.bindingType,
			),
		);
	}
	if (q.automation_id) {
		conditions.push(eq(automationBindings.automationId, q.automation_id));
	}

	const rows = await db
		.select({
			binding: automationBindings,
			account: {
				id: socialAccounts.id,
				username: socialAccounts.username,
				displayName: socialAccounts.displayName,
				avatarUrl: socialAccounts.avatarUrl,
			},
		})
		.from(automationBindings)
		.leftJoin(
			socialAccounts,
			and(
				eq(automationBindings.socialAccountId, socialAccounts.id),
				// Scope the joined account to this org so a binding pointing at a
				// foreign account id hydrates to null instead of leaking identity.
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(automationBindings.createdAt));

	return c.json(
		{
			data: rows.map((r) =>
				serializeBinding(r.binding, { account: r.account }),
			),
		},
		200,
	);
});

const createBinding = createRoute({
	operationId: "createAutomationBinding",
	method: "post",
	path: "/",
	tags: ["Automation Bindings"],
	summary: "Create a binding for a social account",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: BindingCreateSchema } } },
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: BindingResponseSchema } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Automation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description:
				"A binding already exists for this (social_account_id, binding_type)",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(createBinding, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const body = c.req.valid("json");

	// Validate binding config against per-type schema.
	const parsed = validateBindingConfig(body.binding_type, body.config ?? {});
	if (!parsed.success) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: `invalid config for binding_type ${body.binding_type}`,
					details: {
						errors: "error" in parsed ? (parsed.error?.issues ?? []) : [],
					},
				},
			},
			400,
		);
	}

	// Verify the automation belongs to this org + workspace scope.
	const [automation] = await db
		.select()
		.from(automations)
		.where(
			and(
				eq(automations.id, body.automation_id),
				eq(automations.organizationId, orgId),
			),
		)
		.limit(1);
	if (!automation) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Automation not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, automation.workspaceId);
	if (denied) return denied;

	// Verify the social account belongs to this org. Without this, a caller can
	// bind to another org's account id and then read its handle/display name/
	// avatar back via GET /{id} (account-identity disclosure).
	const [boundAccount] = await db
		.select({ id: socialAccounts.id })
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, body.social_account_id),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!boundAccount) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Social account not found" } },
			404,
		);
	}

	try {
		const [inserted] = await db
			.insert(automationBindings)
			.values({
				organizationId: orgId,
				workspaceId: body.workspace_id ?? automation.workspaceId ?? null,
				socialAccountId: body.social_account_id,
				channel: body.channel,
				bindingType: body.binding_type,
				automationId: body.automation_id,
				config: parsed.data as Record<string, unknown>,
				status: defaultStatusFor(body.binding_type),
			})
			.returning();
		if (!inserted) {
			return c.json(
				{
					error: {
						code: "INTERNAL_ERROR",
						message: "failed to create binding",
					},
				},
				400,
			);
		}
		return c.json(serializeBinding(inserted, { includeWarnings: true }), 201);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/uniq|duplicate|unique/i.test(message)) {
			return c.json(
				{
					error: {
						code: "CONFLICT",
						message:
							"A binding already exists for this (social_account_id, binding_type)",
					},
				},
				409,
			);
		}
		throw err;
	}
});

const getBinding = createRoute({
	operationId: "getAutomationBinding",
	method: "get",
	path: "/{id}",
	tags: ["Automation Bindings"],
	summary: "Get a binding",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Binding",
			content: { "application/json": { schema: BindingResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getBinding, async (c) => {
	const { id } = c.req.valid("param");
	const orgId = c.get("orgId");
	const scoped = await loadScopedBinding(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;
	const db = c.get("db");
	// Scope the account hydration to this org so a binding that (via legacy data)
	// points at a foreign account never leaks that account's identity.
	const [account] = await db
		.select({
			id: socialAccounts.id,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			avatarUrl: socialAccounts.avatarUrl,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, scoped.row.socialAccountId),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	return c.json(serializeBinding(scoped.row, { account: account ?? null }), 200);
});

const updateBinding = createRoute({
	operationId: "updateAutomationBinding",
	method: "patch",
	path: "/{id}",
	tags: ["Automation Bindings"],
	summary: "Update a binding",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: BindingUpdateSchema } } },
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: BindingResponseSchema } },
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

app.openapi(updateBinding, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const scoped = await loadScopedBinding(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;
	const existing = scoped.row;
	const orgId = c.get("orgId");
	const db = c.get("db");

	const patch: Partial<typeof automationBindings.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (body.channel !== undefined) patch.channel = body.channel;
	if (body.binding_type !== undefined) patch.bindingType = body.binding_type;
	if (body.social_account_id !== undefined) {
		// Re-validate account ownership on update too — otherwise a PATCH can
		// repoint a binding at another org's account id and leak its identity.
		const [acct] = await db
			.select({ id: socialAccounts.id })
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.id, body.social_account_id),
					eq(socialAccounts.organizationId, orgId),
				),
			)
			.limit(1);
		if (!acct) {
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Social account not found" } },
				404,
			);
		}
		patch.socialAccountId = body.social_account_id;
	}
	if (body.automation_id !== undefined) {
		// Re-validate automation ownership too — the original code patched
		// automationId straight from the body with no org check.
		const [auto] = await db
			.select({ id: automations.id })
			.from(automations)
			.where(
				and(
					eq(automations.id, body.automation_id),
					eq(automations.organizationId, orgId),
				),
			)
			.limit(1);
		if (!auto) {
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Automation not found" } },
				404,
			);
		}
		patch.automationId = body.automation_id;
	}
	if (body.status !== undefined) patch.status = body.status;
	if (body.workspace_id !== undefined) {
		patch.workspaceId = body.workspace_id ?? null;
	}

	if (body.config !== undefined || body.binding_type !== undefined) {
		const bindingType = body.binding_type ?? existing.bindingType;
		const cfg = body.config ?? (existing.config as Record<string, unknown>);
		const parsed = validateBindingConfig(bindingType, cfg);
		if (!parsed.success) {
			return c.json(
				{
					error: {
						code: "VALIDATION_ERROR",
						message: `invalid config for binding_type ${bindingType}`,
						details: {
							errors: "error" in parsed ? (parsed.error?.issues ?? []) : [],
						},
					},
				},
				400,
			);
		}
		patch.config = parsed.data as Record<string, unknown>;
	}

	const [updated] = await db
		.update(automationBindings)
		.set(patch)
		.where(eq(automationBindings.id, id))
		.returning();
	if (!updated) return notFound(c);
	return c.json(serializeBinding(updated, { includeWarnings: true }), 200);
});

const deleteBinding = createRoute({
	operationId: "deleteAutomationBinding",
	method: "delete",
	path: "/{id}",
	tags: ["Automation Bindings"],
	summary: "Delete a binding",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		204: { description: "Deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteBinding, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedBinding(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;

	const db = c.get("db");
	await db.delete(automationBindings).where(eq(automationBindings.id, id));
	return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Binding insights (G8)
// ---------------------------------------------------------------------------

const bindingInsights = createRoute({
	operationId: "getAutomationBindingInsights",
	method: "get",
	path: "/{id}/insights",
	tags: ["Automation Bindings"],
	summary: "Aggregate run metrics scoped to a binding",
	security: [{ Bearer: [] }],
	request: { params: IdParams, query: BindingInsightsQuery },
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

app.openapi(bindingInsights, async (c) => {
	const { id } = c.req.valid("param");
	const query = c.req.valid("query");
	const scoped = await loadScopedBinding(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;

	const db = c.get("db");
	const result = await aggregateInsights(db, query, {
		orgId: c.get("orgId"),
		bindingId: id,
	});
	return c.json(result, 200);
});

export default app;
