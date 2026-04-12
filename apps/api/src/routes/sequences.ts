import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	createDb,
	sequences,
	sequenceSteps,
	sequenceEnrollments,
	contacts,
	contactChannels,
} from "@relayapi/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import {
	CreateSequenceBody,
	EnrollBody,
	EnrollmentIdParams,
	EnrollmentListResponse,
	EnrollResponse,
	SequenceDetailResponse,
	SequenceIdParams,
	SequenceListResponse,
	SequenceResponse,
	UpdateSequenceBody,
} from "../schemas/sequences";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

function serializeSequence(
	s: typeof sequences.$inferSelect,
	stepsCount: number,
) {
	return {
		id: s.id,
		name: s.name,
		description: s.description ?? null,
		platform: s.platform,
		account_id: s.socialAccountId,
		status: s.status as "draft" | "active" | "paused",
		exit_on_reply: s.exitOnReply,
		exit_on_unsubscribe: s.exitOnUnsubscribe,
		steps_count: stepsCount,
		total_enrolled: s.totalEnrolled,
		total_completed: s.totalCompleted,
		total_exited: s.totalExited,
		created_at: s.createdAt.toISOString(),
	};
}

// --- Route definitions ---

const createSequence = createRoute({
	operationId: "createSequence",
	method: "post",
	path: "/",
	tags: ["Sequences"],
	summary: "Create a sequence",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateSequenceBody } } },
	},
	responses: {
		201: {
			description: "Sequence created",
			content: { "application/json": { schema: SequenceDetailResponse } },
		},
	},
});

const SequenceListQuery = z.object({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items per page"),
});

const listSequences = createRoute({
	operationId: "listSequences",
	method: "get",
	path: "/",
	tags: ["Sequences"],
	summary: "List sequences",
	security: [{ Bearer: [] }],
	request: { query: SequenceListQuery },
	responses: {
		200: {
			description: "Sequences list",
			content: { "application/json": { schema: SequenceListResponse } },
		},
	},
});

const getSequence = createRoute({
	operationId: "getSequence",
	method: "get",
	path: "/{id}",
	tags: ["Sequences"],
	summary: "Get sequence with steps",
	security: [{ Bearer: [] }],
	request: { params: SequenceIdParams },
	responses: {
		200: {
			description: "Sequence details",
			content: { "application/json": { schema: SequenceDetailResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateSequence = createRoute({
	operationId: "updateSequence",
	method: "patch",
	path: "/{id}",
	tags: ["Sequences"],
	summary: "Update sequence",
	security: [{ Bearer: [] }],
	request: {
		params: SequenceIdParams,
		body: { content: { "application/json": { schema: UpdateSequenceBody } } },
	},
	responses: {
		200: {
			description: "Updated sequence",
			content: { "application/json": { schema: SequenceDetailResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteSequence = createRoute({
	operationId: "deleteSequence",
	method: "delete",
	path: "/{id}",
	tags: ["Sequences"],
	summary: "Delete sequence",
	security: [{ Bearer: [] }],
	request: { params: SequenceIdParams },
	responses: { 204: { description: "Deleted" } },
});

const activateSequence = createRoute({
	operationId: "activateSequence",
	method: "post",
	path: "/{id}/activate",
	tags: ["Sequences"],
	summary: "Activate sequence",
	description: "Sequence must have at least one step.",
	security: [{ Bearer: [] }],
	request: { params: SequenceIdParams },
	responses: {
		200: {
			description: "Activated",
			content: { "application/json": { schema: SequenceResponse } },
		},
		400: {
			description: "No steps defined",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const pauseSequence = createRoute({
	operationId: "pauseSequence",
	method: "post",
	path: "/{id}/pause",
	tags: ["Sequences"],
	summary: "Pause sequence",
	security: [{ Bearer: [] }],
	request: { params: SequenceIdParams },
	responses: {
		200: {
			description: "Paused",
			content: { "application/json": { schema: SequenceResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const enrollContacts = createRoute({
	operationId: "enrollContacts",
	method: "post",
	path: "/{id}/enroll",
	tags: ["Sequences"],
	summary: "Enroll contacts into a sequence",
	security: [{ Bearer: [] }],
	request: {
		params: SequenceIdParams,
		body: { content: { "application/json": { schema: EnrollBody } } },
	},
	responses: {
		200: {
			description: "Enrollment result",
			content: { "application/json": { schema: EnrollResponse } },
		},
		400: {
			description: "Sequence not active",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const unenrollContact = createRoute({
	operationId: "unenrollContact",
	method: "delete",
	path: "/{id}/enrollments/{enrollment_id}",
	tags: ["Sequences"],
	summary: "Unenroll a contact",
	security: [{ Bearer: [] }],
	request: { params: EnrollmentIdParams },
	responses: { 204: { description: "Unenrolled" } },
});

const listEnrollments = createRoute({
	operationId: "listEnrollments",
	method: "get",
	path: "/{id}/enrollments",
	tags: ["Sequences"],
	summary: "List enrollments",
	security: [{ Bearer: [] }],
	request: {
		params: SequenceIdParams,
		query: PaginationParams,
	},
	responses: {
		200: {
			description: "Enrollments list",
			content: { "application/json": { schema: EnrollmentListResponse } },
		},
	},
});

// --- Handlers ---

// @ts-expect-error — handler returns 201 or 404
app.openapi(createSequence, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [seq] = await db
		.insert(sequences)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			socialAccountId: body.account_id,
			platform: body.platform,
			name: body.name,
			description: body.description ?? null,
			exitOnReply: body.exit_on_reply,
			exitOnUnsubscribe: body.exit_on_unsubscribe,
		})
		.returning();

	if (!seq) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Failed to create sequence" } },
			404,
		);
	}

	let steps: (typeof sequenceSteps.$inferSelect)[] = [];
	if (body.steps && body.steps.length > 0) {
		steps = await db
			.insert(sequenceSteps)
			.values(
				body.steps.map((s) => ({
					sequenceId: seq.id,
					order: s.order,
					delayMinutes: s.delay_minutes,
					messageType: s.message_type,
					messageText: s.message_text ?? null,
					templateName: s.template_name ?? null,
					templateLanguage: s.template_language ?? null,
					templateComponents: s.template_components ?? null,
				})),
			)
			.returning();
	}

	return c.json(
		{
			...serializeSequence(seq, steps.length),
			steps: steps.map((s) => ({
				id: s.id,
				order: s.order,
				delay_minutes: s.delayMinutes,
				message_type: s.messageType as "text" | "template",
				message_text: s.messageText ?? null,
				template_name: s.templateName ?? null,
				template_language: s.templateLanguage ?? null,
				template_components: s.templateComponents ?? null,
				created_at: s.createdAt.toISOString(),
			})),
		},
		201,
	);
});

app.openapi(listSequences, async (c) => {
	const orgId = c.get("orgId");
	const { workspace_id, cursor, limit } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const conditions = [eq(sequences.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, sequences.workspaceId);
	if (workspace_id) {
		conditions.push(eq(sequences.workspaceId, workspace_id));
	}

	// Cursor pagination (composite: createdAt DESC, id DESC to handle timestamp ties)
	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: sequences.createdAt })
			.from(sequences)
			.where(eq(sequences.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${sequences.createdAt} < ${cursorRow.createdAt} OR (${sequences.createdAt} = ${cursorRow.createdAt} AND ${sequences.id} < ${cursor}))`,
			);
		}
	}

	const seqs = await db
		.select()
		.from(sequences)
		.where(and(...conditions))
		.orderBy(desc(sequences.createdAt), desc(sequences.id))
		.limit(limit + 1);

	const hasMore = seqs.length > limit;
	const page = seqs.slice(0, limit);

	// Get step counts scoped to this page's sequences
	const seqIds = page.map((s) => s.id);
	const stepCounts =
		seqIds.length > 0
			? await db
					.select({
						sequenceId: sequenceSteps.sequenceId,
						count: sql<number>`count(*)::int`,
					})
					.from(sequenceSteps)
					.where(inArray(sequenceSteps.sequenceId, seqIds))
					.groupBy(sequenceSteps.sequenceId)
			: [];

	const countMap = new Map(stepCounts.map((s) => [s.sequenceId, s.count]));
	const data = page.map((s) => serializeSequence(s, countMap.get(s.id) ?? 0));

	return c.json(
		{
			data,
			next_cursor: hasMore ? data[data.length - 1]!.id : null,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(getSequence, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [seq] = await db
		.select()
		.from(sequences)
		.where(and(eq(sequences.id, id), eq(sequences.organizationId, orgId)))
		.limit(1);

	if (!seq) {
		return c.json({ error: { code: "NOT_FOUND", message: "Sequence not found" } }, 404);
	}

	const steps = await db
		.select()
		.from(sequenceSteps)
		.where(eq(sequenceSteps.sequenceId, id))
		.orderBy(asc(sequenceSteps.order));

	return c.json(
		{
			...serializeSequence(seq, steps.length),
			steps: steps.map((s) => ({
				id: s.id,
				order: s.order,
				delay_minutes: s.delayMinutes,
				message_type: s.messageType as "text" | "template",
				message_text: s.messageText ?? null,
				template_name: s.templateName ?? null,
				template_language: s.templateLanguage ?? null,
				template_components: s.templateComponents ?? null,
				created_at: s.createdAt.toISOString(),
			})),
		},
		200,
	);
});

app.openapi(updateSequence, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const updateSet: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updateSet.name = body.name;
	if (body.description !== undefined) updateSet.description = body.description;
	if (body.exit_on_reply !== undefined) updateSet.exitOnReply = body.exit_on_reply;
	if (body.exit_on_unsubscribe !== undefined) updateSet.exitOnUnsubscribe = body.exit_on_unsubscribe;

	const [updated] = await db
		.update(sequences)
		.set(updateSet)
		.where(and(eq(sequences.id, id), eq(sequences.organizationId, orgId)))
		.returning();

	if (!updated) {
		return c.json({ error: { code: "NOT_FOUND", message: "Sequence not found" } }, 404);
	}

	// Replace steps if provided
	let steps: (typeof sequenceSteps.$inferSelect)[];
	if (body.steps) {
		await db.delete(sequenceSteps).where(eq(sequenceSteps.sequenceId, id));
		steps =
			body.steps.length > 0
				? await db
						.insert(sequenceSteps)
						.values(
							body.steps.map((s) => ({
								sequenceId: id,
								order: s.order,
								delayMinutes: s.delay_minutes,
								messageType: s.message_type,
								messageText: s.message_text ?? null,
								templateName: s.template_name ?? null,
								templateLanguage: s.template_language ?? null,
								templateComponents: s.template_components ?? null,
							})),
						)
						.returning()
				: [];
	} else {
		steps = await db
			.select()
			.from(sequenceSteps)
			.where(eq(sequenceSteps.sequenceId, id))
			.orderBy(asc(sequenceSteps.order));
	}

	return c.json(
		{
			...serializeSequence(updated, steps.length),
			steps: steps.map((s) => ({
				id: s.id,
				order: s.order,
				delay_minutes: s.delayMinutes,
				message_type: s.messageType as "text" | "template",
				message_text: s.messageText ?? null,
				template_name: s.templateName ?? null,
				template_language: s.templateLanguage ?? null,
				template_components: s.templateComponents ?? null,
				created_at: s.createdAt.toISOString(),
			})),
		},
		200,
	);
});

app.openapi(deleteSequence, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: sequences.id, workspaceId: sequences.workspaceId })
		.from(sequences)
		.where(and(eq(sequences.id, id), eq(sequences.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json({ error: { code: "NOT_FOUND", message: "Sequence not found" } }, 404);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	await db.delete(sequences).where(eq(sequences.id, id));

	return c.body(null, 204);
});

app.openapi(activateSequence, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [seq] = await db
		.select()
		.from(sequences)
		.where(and(eq(sequences.id, id), eq(sequences.organizationId, orgId)))
		.limit(1);

	if (!seq) {
		return c.json({ error: { code: "NOT_FOUND", message: "Sequence not found" } }, 404);
	}

	const [stepCount] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(sequenceSteps)
		.where(eq(sequenceSteps.sequenceId, id));

	if (!stepCount || stepCount.count === 0) {
		return c.json(
			{ error: { code: "VALIDATION_ERROR", message: "Sequence must have at least one step" } },
			400,
		);
	}

	const [updated] = await db
		.update(sequences)
		.set({ status: "active", updatedAt: new Date() })
		.where(and(eq(sequences.id, id), eq(sequences.organizationId, orgId)))
		.returning();

	if (!updated) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Sequence not found" } },
			404,
		);
	}

	return c.json(serializeSequence(updated, stepCount.count), 200);
});

app.openapi(pauseSequence, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [updated] = await db
		.update(sequences)
		.set({ status: "paused", updatedAt: new Date() })
		.where(and(eq(sequences.id, id), eq(sequences.organizationId, orgId)))
		.returning();

	if (!updated) {
		return c.json({ error: { code: "NOT_FOUND", message: "Sequence not found" } }, 404);
	}

	const [stepCount] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(sequenceSteps)
		.where(eq(sequenceSteps.sequenceId, id));

	return c.json(serializeSequence(updated, stepCount?.count ?? 0), 200);
});

app.openapi(enrollContacts, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { contact_ids } = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Verify sequence is active
	const [seq] = await db
		.select()
		.from(sequences)
		.where(and(eq(sequences.id, id), eq(sequences.organizationId, orgId)))
		.limit(1);

	if (!seq) {
		return c.json({ error: { code: "NOT_FOUND", message: "Sequence not found" } }, 404);
	}
	if (seq.status !== "active") {
		return c.json(
			{ error: { code: "VALIDATION_ERROR", message: "Sequence must be active to enroll contacts" } },
			400,
		);
	}

	// Get first step to calculate nextStepAt
	const [firstStep] = await db
		.select()
		.from(sequenceSteps)
		.where(eq(sequenceSteps.sequenceId, id))
		.orderBy(asc(sequenceSteps.order))
		.limit(1);

	if (!firstStep) {
		return c.json(
			{ error: { code: "VALIDATION_ERROR", message: "Sequence has no steps" } },
			400,
		);
	}

	// Look up contacts to get their platform identifiers via channels
	const contactRows = await db
		.select({
			id: contacts.id,
			identifier: contactChannels.identifier,
		})
		.from(contacts)
		.innerJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
		.where(
			and(
				eq(contacts.organizationId, orgId),
				inArray(contacts.id, contact_ids),
				eq(contactChannels.socialAccountId, seq.socialAccountId),
			),
		);

	const contactMap = new Map(contactRows.map((c) => [c.id, c.identifier]));
	let enrolled = 0;
	let skipped = 0;

	const nextStepAt = new Date(Date.now() + firstStep.delayMinutes * 60 * 1000);

	for (const contactId of contact_ids) {
		const identifier = contactMap.get(contactId);
		if (!identifier) {
			skipped++;
			continue;
		}

		try {
			await db.insert(sequenceEnrollments).values({
				sequenceId: id,
				organizationId: orgId,
				contactId,
				contactIdentifier: identifier,
				nextStepAt,
			});
			enrolled++;
		} catch {
			// Unique constraint violation = already enrolled
			skipped++;
		}
	}

	// Update total enrolled
	if (enrolled > 0) {
		await db
			.update(sequences)
			.set({
				totalEnrolled: sql`${sequences.totalEnrolled} + ${enrolled}`,
				updatedAt: new Date(),
			})
			.where(eq(sequences.id, id));
	}

	return c.json({ enrolled, skipped }, 200);
});

app.openapi(unenrollContact, async (c) => {
	const orgId = c.get("orgId");
	const { enrollment_id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [enrollment] = await db
		.update(sequenceEnrollments)
		.set({
			status: "exited",
			exitReason: "manual",
			exitedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(sequenceEnrollments.id, enrollment_id),
				eq(sequenceEnrollments.organizationId, orgId),
				eq(sequenceEnrollments.status, "active"),
			),
		)
		.returning();

	if (enrollment) {
		await db
			.update(sequences)
			.set({ totalExited: sql`${sequences.totalExited} + 1` })
			.where(eq(sequences.id, enrollment.sequenceId));
	}

	return c.body(null, 204);
});

app.openapi(listEnrollments, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { limit, cursor } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const conditions = [
		eq(sequenceEnrollments.sequenceId, id),
		eq(sequenceEnrollments.organizationId, orgId),
	];

	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: sequenceEnrollments.createdAt })
			.from(sequenceEnrollments)
			.where(eq(sequenceEnrollments.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${sequenceEnrollments.createdAt} < ${cursorRow.createdAt} OR (${sequenceEnrollments.createdAt} = ${cursorRow.createdAt} AND ${sequenceEnrollments.id} < ${cursor}))`,
			);
		}
	}

	const enrollments = await db
		.select()
		.from(sequenceEnrollments)
		.where(and(...conditions))
		.orderBy(desc(sequenceEnrollments.createdAt), desc(sequenceEnrollments.id))
		.limit(limit + 1);

	const hasMore = enrollments.length > limit;
	const data = enrollments.slice(0, limit);

	return c.json(
		{
			data: data.map((e) => ({
				id: e.id,
				contact_id: e.contactId,
				contact_identifier: e.contactIdentifier,
				status: e.status as "active" | "completed" | "exited" | "paused",
				current_step_index: e.currentStepIndex,
				steps_sent: e.stepsSent,
				next_step_at: e.nextStepAt?.toISOString() ?? null,
				last_step_sent_at: e.lastStepSentAt?.toISOString() ?? null,
				exit_reason: e.exitReason ?? null,
				enrolled_at: e.enrolledAt.toISOString(),
			})),
			next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

export default app;
