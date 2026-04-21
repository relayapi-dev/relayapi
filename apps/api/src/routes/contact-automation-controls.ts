// apps/api/src/routes/contact-automation-controls.ts
//
// Per-contact automation pause controls (spec §9.6).
//
// Supports both global pauses (automation_id = NULL → blocks ALL automations
// for the contact) and per-automation pauses. The unique partial indices on
// automation_contact_controls enforce at most one global row and one row per
// (contact_id, automation_id).

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	automationContactControls,
	automations,
	contacts,
} from "@relayapi/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { assertWorkspaceScope } from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ControlRow = typeof automationContactControls.$inferSelect;

const ControlResponseSchema = z.object({
	id: z.string(),
	organization_id: z.string(),
	contact_id: z.string(),
	automation_id: z.string().nullable(),
	pause_reason: z.string().nullable(),
	paused_until: z.string().nullable(),
	paused_by_user_id: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
});

function serializeControl(
	row: ControlRow,
): z.infer<typeof ControlResponseSchema> {
	return {
		id: row.id,
		organization_id: row.organizationId,
		contact_id: row.contactId,
		automation_id: row.automationId ?? null,
		pause_reason: row.pauseReason ?? null,
		paused_until: row.pausedUntil?.toISOString() ?? null,
		paused_by_user_id: row.pausedByUserId ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

async function loadScopedContact(c: any, id: string) {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const [row] = await db
		.select({ id: contacts.id, workspaceId: contacts.workspaceId })
		.from(contacts)
		.where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
		.limit(1);
	if (!row) return null;
	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return { denied };
	return { row };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ContactIdParams = z.object({ id: z.string() });

const PauseBody = z.object({
	automation_id: z
		.string()
		.optional()
		.describe("Omit for a global pause (blocks all automations for this contact)"),
	pause_reason: z.string().optional(),
	paused_until: z.string().datetime({ offset: true }).optional(),
});

const ResumeBody = z.object({
	automation_id: z
		.string()
		.optional()
		.describe("Omit to clear the global pause"),
});

const ListResponse = z.object({ data: z.array(ControlResponseSchema) });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listControls = createRoute({
	operationId: "listContactAutomationControls",
	method: "get",
	path: "/{id}/automation-controls",
	tags: ["Contact Automation Controls"],
	summary: "List automation pause controls for a contact",
	security: [{ Bearer: [] }],
	request: { params: ContactIdParams },
	responses: {
		200: {
			description: "Controls list",
			content: { "application/json": { schema: ListResponse } },
		},
		404: {
			description: "Contact not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listControls, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedContact(c, id);
	if (!scoped) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}
	if ("denied" in scoped) return scoped.denied as never;

	const db = c.get("db");
	const rows = await db
		.select()
		.from(automationContactControls)
		.where(
			and(
				eq(automationContactControls.contactId, id),
				eq(automationContactControls.organizationId, c.get("orgId")),
			),
		);

	return c.json({ data: rows.map(serializeControl) }, 200);
});

const pauseContact = createRoute({
	operationId: "pauseContactAutomation",
	method: "post",
	path: "/{id}/automation-pause",
	tags: ["Contact Automation Controls"],
	summary: "Pause automations for a contact (global or per-automation)",
	security: [{ Bearer: [] }],
	request: {
		params: ContactIdParams,
		body: { content: { "application/json": { schema: PauseBody } } },
	},
	responses: {
		200: {
			description: "Paused",
			content: { "application/json": { schema: ControlResponseSchema } },
		},
		404: {
			description: "Contact or automation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — handler may return 403 from assertWorkspaceScope
app.openapi(pauseContact, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const orgId = c.get("orgId");

	const scoped = await loadScopedContact(c, id);
	if (!scoped) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}
	if ("denied" in scoped) return scoped.denied as never;

	const db = c.get("db");

	// If automation_id is provided, verify it belongs to this org.
	if (body.automation_id) {
		const [row] = await db
			.select({ id: automations.id, workspaceId: automations.workspaceId })
			.from(automations)
			.where(
				and(
					eq(automations.id, body.automation_id),
					eq(automations.organizationId, orgId),
				),
			)
			.limit(1);
		if (!row) {
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Automation not found" } },
				404,
			);
		}
		const denied = assertWorkspaceScope(c, row.workspaceId);
		if (denied) return denied;
	}

	const pausedUntil = body.paused_until ? new Date(body.paused_until) : null;
	const pauseReason = body.pause_reason ?? null;

	// Find existing row (partial-unique indices enforce at most one global and
	// at most one per-automation row per contact).
	const existingConds = body.automation_id
		? [
				eq(automationContactControls.contactId, id),
				eq(automationContactControls.automationId, body.automation_id),
		  ]
		: [
				eq(automationContactControls.contactId, id),
				isNull(automationContactControls.automationId),
		  ];
	const [existing] = await db
		.select()
		.from(automationContactControls)
		.where(and(...existingConds))
		.limit(1);

	let row: ControlRow | undefined;
	if (existing) {
		const [updated] = await db
			.update(automationContactControls)
			.set({
				pauseReason,
				pausedUntil,
				updatedAt: new Date(),
			})
			.where(eq(automationContactControls.id, existing.id))
			.returning();
		row = updated;
	} else {
		const [inserted] = await db
			.insert(automationContactControls)
			.values({
				organizationId: orgId,
				contactId: id,
				automationId: body.automation_id ?? null,
				pauseReason,
				pausedUntil,
				pausedByUserId: null,
			})
			.returning();
		row = inserted;
	}

	if (!row) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "failed to upsert automation control",
				},
			},
			404,
		);
	}

	return c.json(serializeControl(row), 200);
});

const resumeContact = createRoute({
	operationId: "resumeContactAutomation",
	method: "post",
	path: "/{id}/automation-resume",
	tags: ["Contact Automation Controls"],
	summary: "Remove a pause (global or per-automation) for a contact",
	security: [{ Bearer: [] }],
	request: {
		params: ContactIdParams,
		body: { content: { "application/json": { schema: ResumeBody } } },
	},
	responses: {
		204: { description: "Resumed" },
		404: {
			description: "Contact not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(resumeContact, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const orgId = c.get("orgId");

	const scoped = await loadScopedContact(c, id);
	if (!scoped) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Contact not found" } },
			404,
		);
	}
	if ("denied" in scoped) return scoped.denied as never;

	const db = c.get("db");

	if (body.automation_id) {
		await db
			.delete(automationContactControls)
			.where(
				and(
					eq(automationContactControls.organizationId, orgId),
					eq(automationContactControls.contactId, id),
					eq(automationContactControls.automationId, body.automation_id),
				),
			);
	} else {
		await db
			.delete(automationContactControls)
			.where(
				and(
					eq(automationContactControls.organizationId, orgId),
					eq(automationContactControls.contactId, id),
					isNull(automationContactControls.automationId),
				),
			);
	}

	return c.body(null, 204);
});

export default app;
