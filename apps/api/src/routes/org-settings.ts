// ---------------------------------------------------------------------------
// Organization Settings API — /v1/org-settings
// ---------------------------------------------------------------------------

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, organizationSubscriptions, eq } from "@relayapi/db";
import type { Env, Variables } from "../types";
import { ErrorResponse } from "../schemas/common";
import { requireAllWorkspaceScopeMiddleware } from "../middleware/permissions";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.use("*", requireAllWorkspaceScopeMiddleware);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const OrgSettingsResponse = z.object({
	require_workspace_id: z
		.boolean()
		.describe(
			"When enabled, all create requests must include workspace_id. Default: false.",
		),
});

const UpdateOrgSettingsBody = z.object({
	require_workspace_id: z
		.boolean()
		.optional()
		.describe(
			"When enabled, all create requests must include workspace_id.",
		),
});

// ---------------------------------------------------------------------------
// GET /v1/org-settings — retrieve org settings
// ---------------------------------------------------------------------------

const getSettings = createRoute({
	operationId: "getOrgSettings",
	method: "get",
	path: "/",
	tags: ["Organization Settings"],
	summary: "Get organization settings",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Organization settings",
			content: {
				"application/json": {
					schema: z.object({ data: OrgSettingsResponse }),
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(getSettings, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");

	const [sub] = await db
		.select({
			requireWorkspaceId: organizationSubscriptions.requireWorkspaceId,
		})
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, orgId))
		.limit(1);

	return c.json({
		data: {
			require_workspace_id: sub?.requireWorkspaceId ?? false,
		},
	});
});

// ---------------------------------------------------------------------------
// PATCH /v1/org-settings — update org settings
// ---------------------------------------------------------------------------

const updateSettings = createRoute({
	operationId: "updateOrgSettings",
	method: "patch",
	path: "/",
	tags: ["Organization Settings"],
	summary: "Update organization settings",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: UpdateOrgSettingsBody },
			},
		},
	},
	responses: {
		200: {
			description: "Settings updated",
			content: {
				"application/json": {
					schema: z.object({ data: OrgSettingsResponse }),
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(updateSettings, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.require_workspace_id !== undefined) {
		updates.requireWorkspaceId = body.require_workspace_id;
	}

	// Upsert — create subscription row if it doesn't exist
	await db
		.insert(organizationSubscriptions)
		.values({
			organizationId: orgId,
			...updates,
		})
		.onConflictDoUpdate({
			target: [organizationSubscriptions.organizationId],
			set: updates,
		});

	// Sync the setting to all KV keys for this org
	// This ensures the middleware picks it up immediately
	await syncOrgSettingToKV(c.env, orgId, body.require_workspace_id ?? false);

	return c.json({
		data: {
			require_workspace_id: body.require_workspace_id ?? false,
		},
	});
});

// ---------------------------------------------------------------------------
// Helper: sync require_workspace_id to all KV keys for an org
// ---------------------------------------------------------------------------

async function syncOrgSettingToKV(
	env: Env,
	orgId: string,
	requireWorkspaceId: boolean,
): Promise<void> {
	// List all KV keys with the org prefix pattern
	// KV keys are stored as apikey:{hash} — we need to scan them
	// Since we can't efficiently list by org, we update the setting
	// in the DB and it will be picked up on next key sync
	// For immediate effect, the caller should trigger a key re-sync

	// The existing syncOrgKeysToKV pattern (used by Stripe webhooks)
	// handles this — but for a lightweight immediate update,
	// we rely on the DB value and the middleware checks it.

	// Actually, the auth middleware reads from KV only.
	// We need to update all KV entries for this org.
	// The cleanest approach: store the setting in a dedicated KV key.
	await env.KV.put(
		`org-settings:${orgId}`,
		JSON.stringify({ require_workspace_id: requireWorkspaceId }),
	);
}

export default app;
