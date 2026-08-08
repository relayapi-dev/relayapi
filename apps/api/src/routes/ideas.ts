import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	type createDb,
	type Database,
	generateId,
	ideaActivity,
	ideaComments,
	ideaConversionOperations,
	ideaGroups,
	ideaMedia,
	ideas,
	ideaTags,
	media,
	member,
	organizationPrincipals,
	posts,
	tags,
	user,
} from "@relayapi/db";
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	inArray,
	isNull,
	lt,
	sql,
} from "drizzle-orm";
import { mediaPublicHost } from "../lib/deployment-mode";
import {
	decodeTimestampIdCursor,
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
} from "../lib/pagination-cursor";
import { presignRelayMediaUrls } from "../lib/r2-presign";
import {
	loadRelayMediaPolicy,
	type RelayMediaPolicy,
} from "../lib/relay-media-policy";
import {
	resolveOperationalCreateScope,
	workspaceScopeKey,
} from "../lib/request-access";
import { thumbnailKeyFor, thumbnailStorageTarget } from "../lib/thumbnails";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import {
	markMutationInputNotApplied,
	multipartMutationInputPreflight,
} from "../middleware/mutation-validation";
import { ErrorResponse, IdParam } from "../schemas/common";
import {
	ConvertIdeaBody,
	CreateIdeaBody,
	CreateIdeaCommentBody,
	IdeaActivityListQuery,
	IdeaActivityListResponse,
	IdeaCommentListQuery,
	IdeaCommentListResponse,
	IdeaCommentResponse,
	IdeaListQuery,
	IdeaListResponse,
	IdeaMediaResponse,
	IdeaResponse,
	MoveIdeaBody,
	UpdateIdeaBody,
	UpdateIdeaCommentBody,
} from "../schemas/ideas";
import { processMediaDeletion } from "../services/media-reliability";
import type { Env, Variables } from "../types";
import {
	acquireAdvisoryLocks,
	ensureDefaultGroup,
	groupOrderLockKey,
	ideaOrderLockKey,
} from "./idea-groups";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function serializeTag(row: typeof tags.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		color: row.color,
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
	};
}

type IdeaMediaView = {
	id: string;
	ideaId: string;
	mediaId: string;
	organizationId: string;
	workspaceId: string | null;
	type: (typeof ideaMedia.$inferSelect)["type"];
	alt: string | null;
	position: number;
	deleteWithIdea: boolean;
	url: string | null;
	thumbnailUrl: string | null;
	status: (typeof media.$inferSelect)["status"];
	originalDeletedAt: Date | null;
};

const ideaMediaSelection = {
	id: ideaMedia.id,
	ideaId: ideaMedia.ideaId,
	mediaId: ideaMedia.mediaId,
	organizationId: ideaMedia.organizationId,
	workspaceId: ideaMedia.workspaceId,
	type: ideaMedia.type,
	alt: ideaMedia.alt,
	position: ideaMedia.position,
	deleteWithIdea: ideaMedia.deleteWithIdea,
	url: sql<string | null>`COALESCE(${media.url}, ${media.thumbnailUrl})`,
	thumbnailUrl: media.thumbnailUrl,
	status: media.status,
	originalDeletedAt: media.originalDeletedAt,
};

function serializeMedia(row: IdeaMediaView) {
	return {
		id: row.id,
		media_id: row.mediaId,
		url: row.url,
		thumbnail: row.thumbnailUrl,
		type: row.type,
		alt: row.alt ?? null,
		position: row.position,
		status: row.status,
		original_available:
			row.status === "ready" &&
			row.originalDeletedAt === null &&
			row.url !== null,
	};
}

function serializeIdea(
	row: typeof ideas.$inferSelect,
	tagRows: (typeof tags.$inferSelect)[],
	mediaRows: IdeaMediaView[],
) {
	return {
		id: row.id,
		title: row.title ?? null,
		content: row.content ?? null,
		group_id: row.groupId,
		position: row.position,
		assigned_to: row.assignedTo ?? null,
		converted_to_post_id: row.convertedToPostId ?? null,
		revision: row.revision,
		tags: tagRows.map(serializeTag),
		media: mediaRows.map(serializeMedia),
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

// The relayapi-media bucket is private; media.relayapi.dev URLs must be presigned
// before a browser <img>/<video> can fetch them (same as posts.ts). presignRelay-
// MediaUrls preserves every other row field, so serializeIdea reads them unchanged.
async function serializeIdeaWithMedia(
	db: ReturnType<typeof createDb>,
	env: Env,
	row: typeof ideas.$inferSelect,
	tagRows: (typeof tags.$inferSelect)[],
	mediaRows: IdeaMediaView[],
	preloadedPolicy?: RelayMediaPolicy,
) {
	const presigned =
		(await presignRelayMediaUrls(
			db,
			env,
			mediaRows,
			3600,
			row.organizationId,
			preloadedPolicy,
		)) ?? mediaRows;
	return serializeIdea(row, tagRows, presigned);
}

async function fetchIdeaTags(
	db: ReturnType<typeof createDb>,
	ideaId: string,
	organizationId: string,
	scopeKey: string,
): Promise<(typeof tags.$inferSelect)[]> {
	const rows = await db
		.select({
			id: tags.id,
			name: tags.name,
			color: tags.color,
			organizationId: tags.organizationId,
			workspaceId: tags.workspaceId,
			createdAt: tags.createdAt,
		})
		.from(ideaTags)
		.innerJoin(
			tags,
			and(
				eq(ideaTags.tagId, tags.id),
				eq(tags.organizationId, organizationId),
				eq(tags.scopeKey, ideaTags.tagScopeKey),
			),
		)
		.where(
			and(
				eq(ideaTags.ideaId, ideaId),
				eq(ideaTags.organizationId, organizationId),
				eq(ideaTags.scopeKey, scopeKey),
			),
		);
	return rows as (typeof tags.$inferSelect)[];
}

type IdeaRelationExecutor = Pick<Database, "execute">;

export class InvalidIdeaRelationError extends Error {
	constructor() {
		super("One or more idea relations are invalid for this scope");
		this.name = "InvalidIdeaRelationError";
	}
}

/**
 * Validates the target group and every tag in one organization/workspace-scoped
 * query. The transaction then writes the idea and its relations using the same
 * scope values, while composite FKs provide a final database-level guard.
 */
export async function validateIdeaRelations(
	db: IdeaRelationExecutor,
	organizationId: string,
	workspaceId: string | null,
	groupId: string,
	tagIds: string[],
): Promise<{ groupScopeKey: string; tagScopeKeys: Map<string, string> }> {
	const uniqueTagIds = [...new Set(tagIds)];
	const rows = await db.execute<{
		kind: "group" | "tag";
		id: string;
		scopeKey: string;
	}>(sql`
		WITH group_match AS (
			SELECT id, scope_key
			FROM idea_groups
			WHERE id = ${groupId}
				AND organization_id = ${organizationId}
				AND (workspace_id IS NULL OR workspace_id IS NOT DISTINCT FROM ${workspaceId})
			FOR KEY SHARE
		), tag_match AS (
			SELECT id, scope_key
			FROM tags
			WHERE organization_id = ${organizationId}
				AND (workspace_id IS NULL OR workspace_id IS NOT DISTINCT FROM ${workspaceId})
				AND ${
					uniqueTagIds.length > 0
						? sql`id IN (${sql.join(
								uniqueTagIds.map((tagId) => sql`${tagId}`),
								sql`, `,
							)})`
						: sql`FALSE`
				}
			FOR KEY SHARE
		)
		SELECT 'group'::text AS kind, id, scope_key AS "scopeKey"
		FROM group_match
		UNION ALL
		SELECT 'tag'::text AS kind, id, scope_key AS "scopeKey"
		FROM tag_match
	`);

	const groupFound = rows.some(
		(row) => row.kind === "group" && row.id === groupId,
	);
	const foundTagIds = new Set(
		rows.filter((row) => row.kind === "tag").map((row) => row.id),
	);
	if (!groupFound || uniqueTagIds.some((tagId) => !foundTagIds.has(tagId))) {
		throw new InvalidIdeaRelationError();
	}
	const group = rows.find((row) => row.kind === "group" && row.id === groupId);
	return {
		groupScopeKey: group?.scopeKey ?? workspaceScopeKey(workspaceId),
		tagScopeKeys: new Map(
			rows
				.filter((row) => row.kind === "tag")
				.map((row) => [row.id, row.scopeKey ?? workspaceScopeKey(workspaceId)]),
		),
	};
}

async function fetchIdeaMedia(
	db: ReturnType<typeof createDb>,
	ideaId: string,
	organizationId: string,
): Promise<IdeaMediaView[]> {
	return db
		.select(ideaMediaSelection)
		.from(ideaMedia)
		.innerJoin(
			media,
			and(
				eq(media.id, ideaMedia.mediaId),
				eq(media.organizationId, ideaMedia.organizationId),
				eq(media.scopeKey, ideaMedia.scopeKey),
			),
		)
		.where(
			and(
				eq(ideaMedia.ideaId, ideaId),
				eq(ideaMedia.organizationId, organizationId),
			),
		)
		.orderBy(asc(ideaMedia.position));
}

interface ActorInfo {
	id: string;
	kind: "member" | "service";
	user_id: string | null;
	name: string | null;
	image: string | null;
}

async function resolveActors(
	db: ReturnType<typeof createDb>,
	organizationId: string,
	actorIds: string[],
): Promise<Map<string, ActorInfo>> {
	const unique = [...new Set(actorIds.filter(Boolean))];
	if (unique.length === 0) return new Map();

	const rows = await db
		.select({
			id: organizationPrincipals.id,
			kind: organizationPrincipals.kind,
			serviceName: organizationPrincipals.serviceName,
			userId: member.userId,
			userName: user.name,
			userImage: user.image,
		})
		.from(organizationPrincipals)
		.leftJoin(
			member,
			and(
				eq(member.id, organizationPrincipals.memberId),
				eq(member.organizationId, organizationPrincipals.organizationId),
			),
		)
		.leftJoin(user, eq(user.id, member.userId))
		.where(
			and(
				eq(organizationPrincipals.organizationId, organizationId),
				inArray(organizationPrincipals.id, unique),
			),
		);

	return new Map(
		rows.map((row) => [
			row.id,
			{
				id: row.id,
				kind: row.kind,
				user_id: row.userId ?? null,
				name: row.kind === "service" ? row.serviceName : row.userName,
				image: row.kind === "member" ? row.userImage : null,
			},
		]),
	);
}

function serializeComment(
	row: typeof ideaComments.$inferSelect,
	author: ActorInfo | null,
) {
	return {
		id: row.id,
		author_id: row.authorPrincipalId,
		author,
		content: row.content,
		parent_id: row.parentId ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

async function logActivity(
	db: ReturnType<typeof createDb>,
	ideaId: string,
	organizationId: string,
	actorPrincipalId: string,
	action: (typeof ideaActivity.$inferInsert)["action"],
	metadata?: Record<string, unknown>,
): Promise<void> {
	await db.insert(ideaActivity).values({
		ideaId,
		organizationId,
		actorPrincipalId,
		action,
		metadata: metadata ?? null,
	});
}

// ── List ideas ────────────────────────────────────────────────────────────────

const listIdeas = createRoute({
	operationId: "listIdeas",
	method: "get",
	path: "/",
	tags: ["Ideas"],
	summary: "List ideas",
	security: [{ Bearer: [] }],
	request: { query: IdeaListQuery },
	responses: {
		200: {
			description: "List of ideas",
			content: { "application/json": { schema: IdeaListResponse } },
		},
		400: {
			description: "Invalid pagination cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listIdeas, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor, group_id, tag_id, assigned_to, workspace_id } =
		c.req.valid("query");
	const db = c.get("db");
	let decodedCursor: ReturnType<typeof decodeTimestampIdCursor> | null = null;
	if (cursor) {
		try {
			decodedCursor = decodeTimestampIdCursor(cursor);
		} catch {
			return c.json(INVALID_CURSOR_BODY, 400);
		}
	}

	const conditions = [eq(ideas.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, ideas.workspaceId);

	if (workspace_id) {
		conditions.push(eq(ideas.workspaceId, workspace_id));
	}
	if (group_id) {
		conditions.push(eq(ideas.groupId, group_id));
	}
	if (assigned_to) {
		conditions.push(eq(ideas.assignedTo, assigned_to));
	}
	if (decodedCursor) {
		conditions.push(
			sql`(${ideas.createdAt}, ${ideas.id}) < (${decodedCursor.timestamp}::timestamptz, ${decodedCursor.id})`,
		);
	}

	// Filter through the tenant-carrying join row in the main query, avoiding the
	// old unscoped pre-query and its extra Worker-to-Postgres round trip.
	if (tag_id) {
		conditions.push(sql`EXISTS (
			SELECT 1
			FROM idea_tags scoped_idea_tags
			JOIN tags scoped_tags
				ON scoped_tags.id = scoped_idea_tags.tag_id
				AND scoped_tags.organization_id = ${orgId}
				AND scoped_tags.scope_key = scoped_idea_tags.tag_scope_key
			WHERE scoped_idea_tags.idea_id = ${ideas.id}
				AND scoped_idea_tags.tag_id = ${tag_id}
				AND scoped_idea_tags.organization_id = ${orgId}
				AND scoped_idea_tags.scope_key = ${ideas.scopeKey}
		)`);
	}

	const rows = await db
		.select({
			...getTableColumns(ideas),
			cursorTimestamp: sql<string>`to_char(${ideas.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(ideas)
		.where(and(...conditions))
		.orderBy(desc(ideas.createdAt), desc(ideas.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	if (data.length === 0) {
		return c.json({ data: [], next_cursor: null, has_more: false }, 200);
	}

	// Batch-fetch tags and media to avoid N+1
	const ideaIds = data.map((r) => r.id);

	// Tags and media both key only on ideaIds and are independent — fetch in
	// parallel (one Worker->Postgres RTT instead of two), matching the sibling
	// idea handlers (getIdea/createIdea/update) that already Promise.all this pair.
	const [allTagRows, allMediaRows] = await Promise.all([
		db
			.select({
				ideaId: ideaTags.ideaId,
				id: tags.id,
				name: tags.name,
				color: tags.color,
				organizationId: tags.organizationId,
				workspaceId: tags.workspaceId,
				createdAt: tags.createdAt,
			})
			.from(ideaTags)
			.innerJoin(
				tags,
				and(
					eq(ideaTags.tagId, tags.id),
					eq(tags.organizationId, orgId),
					eq(tags.scopeKey, ideaTags.tagScopeKey),
				),
			)
			.where(
				and(
					inArray(ideaTags.ideaId, ideaIds),
					eq(ideaTags.organizationId, orgId),
				),
			),
		db
			.select(ideaMediaSelection)
			.from(ideaMedia)
			.innerJoin(
				media,
				and(
					eq(media.id, ideaMedia.mediaId),
					eq(media.organizationId, ideaMedia.organizationId),
					eq(media.scopeKey, ideaMedia.scopeKey),
				),
			)
			.where(
				and(
					inArray(ideaMedia.ideaId, ideaIds),
					eq(ideaMedia.organizationId, orgId),
				),
			)
			.orderBy(asc(ideaMedia.position)),
	]);

	// Group by idea ID
	const tagsByIdeaId = new Map<string, (typeof tags.$inferSelect)[]>();
	for (const row of allTagRows) {
		const { ideaId, ...tagRow } = row;
		let group = tagsByIdeaId.get(ideaId);
		if (!group) {
			group = [];
			tagsByIdeaId.set(ideaId, group);
		}
		group.push(tagRow as typeof tags.$inferSelect);
	}

	const mediaByIdeaId = new Map<string, IdeaMediaView[]>();
	for (const row of allMediaRows) {
		let group = mediaByIdeaId.get(row.ideaId);
		if (!group) {
			group = [];
			mediaByIdeaId.set(row.ideaId, group);
		}
		group.push(row);
	}
	const pageRelayMediaPolicy = await loadRelayMediaPolicy(
		db,
		orgId,
		allMediaRows,
		mediaPublicHost(c.env),
	);

	return c.json(
		{
			data: await Promise.all(
				data.map((row) =>
					serializeIdeaWithMedia(
						db,
						c.env,
						row,
						tagsByIdeaId.get(row.id) ?? [],
						mediaByIdeaId.get(row.id) ?? [],
						pageRelayMediaPolicy,
					),
				),
			),
			next_cursor: hasMore
				? (() => {
						const last = data.at(-1);
						return last
							? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
							: null;
					})()
				: null,
			has_more: hasMore,
		},
		200,
	);
});

// ── Get idea ──────────────────────────────────────────────────────────────────

const getIdea = createRoute({
	operationId: "getIdea",
	method: "get",
	path: "/{id}",
	tags: ["Ideas"],
	summary: "Get an idea",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Idea details",
			content: { "application/json": { schema: IdeaResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getIdea, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [row] = await db
		.select()
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return denied as never;

	const [tagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id, orgId, row.scopeKey),
		fetchIdeaMedia(db, id, orgId),
	]);

	return c.json(
		await serializeIdeaWithMedia(db, c.env, row, tagRows, mediaRows),
		200,
	);
});

// ── Create idea ───────────────────────────────────────────────────────────────

const createIdea = createRoute({
	operationId: "createIdea",
	method: "post",
	path: "/",
	tags: ["Ideas"],
	summary: "Create an idea",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateIdeaBody } },
		},
	},
	responses: {
		201: {
			description: "Idea created",
			content: { "application/json": { schema: IdeaResponse } },
		},
		400: {
			description: "Invalid group or tag association",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createIdea, async (c) => {
	const orgId = c.get("orgId");
	const principalId = c.get("principalId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"idea",
	);
	if (!scope.ok) return scope.response as never;

	const workspaceId = scope.workspaceId;
	const tagIds = [...new Set(body.tag_ids ?? [])];
	let result: { row: typeof ideas.$inferSelect };
	try {
		result = await db.transaction(async (tx) => {
			let groupId = body.group_id;
			if (!groupId) {
				// Groups are shared definitions. Provisioning creates this row, while
				// the upsert is a durable fallback for imported/legacy organizations.
				await acquireAdvisoryLocks(tx, [groupOrderLockKey(orgId, null)]);
				groupId = await ensureDefaultGroup(tx, orgId, null);
			}
			const relationScopes = await validateIdeaRelations(
				tx,
				orgId,
				workspaceId,
				groupId,
				tagIds,
			);
			await acquireAdvisoryLocks(tx, [
				ideaOrderLockKey(orgId, workspaceScopeKey(workspaceId), groupId),
			]);

			// The scalar subquery uses the same complete scope as the validated
			// group, so a foreign group's positions cannot affect this tenant.
			const [row] = await tx
				.insert(ideas)
				.values({
					organizationId: orgId,
					workspaceId,
					groupId,
					groupScopeKey: relationScopes.groupScopeKey,
					title: body.title ?? null,
					content: body.content ?? null,
					position: sql`COALESCE((
						SELECT MAX(position)
						FROM ideas
						WHERE group_id = ${groupId}
							AND organization_id = ${orgId}
							AND workspace_id IS NOT DISTINCT FROM ${workspaceId}
					), -1) + 1`,
					assignedTo: body.assigned_to ?? null,
				})
				.returning();

			if (!row) throw new Error("Failed to create idea");

			if (tagIds.length > 0) {
				await tx.insert(ideaTags).values(
					tagIds.map((tagId) => ({
						ideaId: row.id,
						tagId,
						tagScopeKey:
							relationScopes.tagScopeKeys.get(tagId) ??
							workspaceScopeKey(workspaceId),
						organizationId: orgId,
						scopeKey: row.scopeKey,
					})),
				);
			}

			await tx.insert(ideaActivity).values({
				ideaId: row.id,
				organizationId: orgId,
				actorPrincipalId: principalId,
				action: "created",
			});

			return { row };
		});
	} catch (error) {
		if (error instanceof InvalidIdeaRelationError) {
			return c.json(
				{
					error: {
						code: "INVALID_IDEA_RELATION",
						message:
							"The group and tags must belong to the idea's organization and workspace",
					},
				},
				400,
			);
		}
		throw error;
	}

	const tagRows =
		tagIds.length > 0
			? await fetchIdeaTags(db, result.row.id, orgId, result.row.scopeKey)
			: [];

	return c.json(
		await serializeIdeaWithMedia(db, c.env, result.row, tagRows, []),
		201,
	);
});

// ── Update idea ───────────────────────────────────────────────────────────────

const updateIdea = createRoute({
	operationId: "updateIdea",
	method: "patch",
	path: "/{id}",
	tags: ["Ideas"],
	summary: "Update an idea",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateIdeaBody } },
		},
	},
	responses: {
		200: {
			description: "Idea updated",
			content: { "application/json": { schema: IdeaResponse } },
		},
		400: {
			description: "Invalid tag association",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Revision conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateIdea, async (c) => {
	const orgId = c.get("orgId");
	const principalId = c.get("principalId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const updates: Record<string, unknown> = {};
	const activities: Array<(typeof ideaActivity.$inferInsert)["action"]> = [];

	if (body.title !== undefined) updates.title = body.title;
	if (body.content !== undefined) updates.content = body.content;
	if (body.assigned_to !== undefined) {
		updates.assignedTo = body.assigned_to;
		activities.push("assigned");
	}

	if (Object.keys(updates).length > 0) activities.push("updated");
	const tagIds =
		body.tag_ids === undefined ? undefined : [...new Set(body.tag_ids)];
	if (Object.keys(updates).length === 0 && tagIds === undefined) {
		const [current] = await db
			.select()
			.from(ideas)
			.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
			.limit(1);
		if (!current) {
			return c.json(
				{ error: { code: "idea_not_found", message: "Idea not found" } },
				404,
			);
		}
		const denied = assertWorkspaceScope(c, current.workspaceId);
		if (denied) return denied as never;
		if (current.revision !== body.expected_revision) {
			return c.json(
				{
					error: {
						code: "REVISION_CONFLICT",
						message: "The Idea changed; reload it and retry.",
					},
				},
				409 as never,
			);
		}
		const [tagRows, mediaRows] = await Promise.all([
			fetchIdeaTags(db, id, orgId, current.scopeKey),
			fetchIdeaMedia(db, id, orgId),
		]);
		return c.json(
			await serializeIdeaWithMedia(db, c.env, current, tagRows, mediaRows),
			200,
		);
	}

	let updateResult:
		| { kind: "missing" }
		| { kind: "denied"; response: Response }
		| { kind: "conflict" }
		| { kind: "updated"; row: typeof ideas.$inferSelect };
	try {
		updateResult = await db.transaction(async (tx) => {
			const [current] = await tx
				.select()
				.from(ideas)
				.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
				.for("update")
				.limit(1);
			if (!current) return { kind: "missing" } as const;
			const denied = assertWorkspaceScope(c, current.workspaceId);
			if (denied) return { kind: "denied", response: denied } as const;
			if (current.revision !== body.expected_revision) {
				return { kind: "conflict" } as const;
			}

			let tagScopeKeys: Map<string, string> | undefined;
			if (tagIds !== undefined) {
				const relationScopes = await validateIdeaRelations(
					tx,
					orgId,
					current.workspaceId,
					current.groupId,
					tagIds,
				);
				tagScopeKeys = relationScopes.tagScopeKeys;
			}

			if (tagIds !== undefined) {
				await tx
					.delete(ideaTags)
					.where(
						and(eq(ideaTags.ideaId, id), eq(ideaTags.organizationId, orgId)),
					);
				if (tagIds.length > 0) {
					await tx.insert(ideaTags).values(
						tagIds.map((tagId) => ({
							ideaId: id,
							tagId,
							tagScopeKey:
								tagScopeKeys?.get(tagId) ??
								workspaceScopeKey(current.workspaceId),
							organizationId: orgId,
							scopeKey: current.scopeKey,
						})),
					);
				}
			}

			if (activities.length > 0) {
				await tx.insert(ideaActivity).values(
					activities.map((action) => ({
						ideaId: id,
						organizationId: orgId,
						actorPrincipalId: principalId,
						action,
					})),
				);
			}

			const [row] = await tx
				.update(ideas)
				.set({
					...updates,
					revision: sql`${ideas.revision} + 1`,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(ideas.id, id),
						eq(ideas.organizationId, orgId),
						eq(ideas.revision, body.expected_revision),
					),
				)
				.returning();
			if (!row) return { kind: "conflict" } as const;

			return { kind: "updated", row } as const;
		});
	} catch (error) {
		if (error instanceof InvalidIdeaRelationError) {
			return c.json(
				{
					error: {
						code: "INVALID_IDEA_RELATION",
						message:
							"Every tag must belong to the idea's organization and workspace",
					},
				},
				400,
			);
		}
		throw error;
	}

	if (updateResult.kind === "missing") {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}
	if (updateResult.kind === "denied") return updateResult.response as never;
	if (updateResult.kind === "conflict") {
		return c.json(
			{
				error: {
					code: "REVISION_CONFLICT",
					message: "The Idea changed; reload it and retry.",
				},
			},
			409 as never,
		);
	}
	const updatedRow = updateResult.row;

	const [tagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id, orgId, updatedRow.scopeKey),
		fetchIdeaMedia(db, id, orgId),
	]);

	return c.json(
		await serializeIdeaWithMedia(db, c.env, updatedRow, tagRows, mediaRows),
		200,
	);
});

// ── Delete idea ───────────────────────────────────────────────────────────────

const deleteIdea = createRoute({
	operationId: "deleteIdea",
	method: "delete",
	path: "/{id}",
	tags: ["Ideas"],
	summary: "Delete an idea",
	description:
		"Deletes an idea and durably schedules deletion of media still owned by it. Media copied to a converted post is retained.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Idea deleted" },
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteIdea, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const result = await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({ id: ideas.id, workspaceId: ideas.workspaceId })
			.from(ideas)
			.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
			.for("update")
			.limit(1);
		if (!existing) return { kind: "missing" } as const;
		const denied = assertWorkspaceScope(c, existing.workspaceId);
		if (denied) return { kind: "denied", response: denied } as const;

		const owned = await tx
			.select({
				id: media.id,
				storageKey: media.storageKey,
				thumbnailKey: media.thumbnailKey,
				status: media.status,
			})
			.from(ideaMedia)
			.innerJoin(
				media,
				and(
					eq(media.id, ideaMedia.mediaId),
					eq(media.organizationId, ideaMedia.organizationId),
					eq(media.scopeKey, ideaMedia.scopeKey),
				),
			)
			.where(
				and(
					eq(ideaMedia.ideaId, id),
					eq(ideaMedia.organizationId, orgId),
					eq(ideaMedia.deleteWithIdea, true),
				),
			)
			.for("update", { of: media });
		const now = new Date();
		const thumbnailTarget = thumbnailStorageTarget(c.env);
		for (const row of owned) {
			const uploadMayStillFinish =
				row.status === "uploading" || row.status === "upload_failed";
			await tx
				.update(media)
				.set({
					status: "deleting",
					url: null,
					thumbnailKey: row.thumbnailKey ?? thumbnailKeyFor(row.storageKey),
					...(row.thumbnailKey
						? {}
						: {
								thumbnailStorageProvider: thumbnailTarget.provider,
								thumbnailStorageBucketLocator: thumbnailTarget.bucket,
								thumbnailStorageRegion: thumbnailTarget.region,
							}),
					deletionRequestedAt: sql`COALESCE(${media.deletionRequestedAt}, ${now})`,
					deletionNextRetryAt: uploadMayStillFinish
						? new Date(now.getTime() + 5 * 60_000)
						: now,
					deletionLastError: null,
				})
				.where(and(eq(media.id, row.id), eq(media.organizationId, orgId)));
		}
		await tx
			.delete(ideas)
			.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)));
		return {
			kind: "deleted",
			mediaIds: owned
				.filter(
					(row) => row.status !== "uploading" && row.status !== "upload_failed",
				)
				.map((row) => row.id),
		} as const;
	});

	if (result.kind === "missing") {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}
	if (result.kind === "denied") return result.response;

	// The database tombstone is already committed. Provider failures cannot
	// resurrect the Idea; the scheduled reconciler resumes unfinished phases.
	await Promise.allSettled(
		result.mediaIds.map((mediaId) => processMediaDeletion(db, c.env, mediaId)),
	);

	return c.body(null, 204);
});

// ── Move idea ─────────────────────────────────────────────────────────────────

const moveIdea = createRoute({
	operationId: "moveIdea",
	method: "post",
	path: "/{id}/move",
	tags: ["Ideas"],
	summary: "Move an idea",
	description:
		"Reposition an idea within its group or move it to a different group.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: MoveIdeaBody } },
		},
	},
	responses: {
		200: {
			description: "Idea moved",
			content: { "application/json": { schema: IdeaResponse } },
		},
		400: {
			description: "Invalid target group or relative idea",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Revision conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(moveIdea, async (c) => {
	const orgId = c.get("orgId");
	const principalId = c.get("principalId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	let moveResult:
		| { kind: "missing" }
		| { kind: "denied"; response: Response }
		| { kind: "conflict" }
		| { kind: "updated"; row: typeof ideas.$inferSelect };
	try {
		moveResult = await db.transaction(async (tx) => {
			const [observed] = await tx
				.select()
				.from(ideas)
				.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
				.limit(1);
			if (!observed) return { kind: "missing" } as const;
			const denied = assertWorkspaceScope(c, observed.workspaceId);
			if (denied) return { kind: "denied", response: denied } as const;
			if (observed.revision !== body.expected_revision) {
				return { kind: "conflict" } as const;
			}

			const targetGroupId = body.group_id ?? observed.groupId;
			// Group rows are locked in stable ID order before the ordering advisory
			// locks. Group deletion uses the same order, avoiding move/delete cycles.
			const groupIds = [...new Set([observed.groupId, targetGroupId])].sort();
			const lockedGroups = await tx
				.select({ id: ideaGroups.id })
				.from(ideaGroups)
				.where(
					and(
						eq(ideaGroups.organizationId, orgId),
						inArray(ideaGroups.id, groupIds),
					),
				)
				.orderBy(asc(ideaGroups.id))
				.for("share");
			if (lockedGroups.length !== groupIds.length) {
				throw new InvalidIdeaRelationError();
			}
			const scopeKey = workspaceScopeKey(observed.workspaceId);
			await acquireAdvisoryLocks(tx, [
				ideaOrderLockKey(orgId, scopeKey, observed.groupId),
				ideaOrderLockKey(orgId, scopeKey, targetGroupId),
			]);

			const [current] = await tx
				.select()
				.from(ideas)
				.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
				.for("update")
				.limit(1);
			if (
				!current ||
				current.revision !== body.expected_revision ||
				current.groupId !== observed.groupId ||
				current.workspaceId !== observed.workspaceId
			) {
				return { kind: "conflict" } as const;
			}
			const relationScopes = await validateIdeaRelations(
				tx,
				orgId,
				current.workspaceId,
				targetGroupId,
				[],
			);

			const rows = await tx
				.select({
					id: ideas.id,
					groupId: ideas.groupId,
					position: ideas.position,
				})
				.from(ideas)
				.where(
					and(
						eq(ideas.organizationId, orgId),
						sql`${ideas.workspaceId} IS NOT DISTINCT FROM ${current.workspaceId}`,
						inArray(ideas.groupId, groupIds),
					),
				)
				.orderBy(asc(ideas.groupId), asc(ideas.position), asc(ideas.id))
				.for("update");
			const sourceRows = rows.filter((row) => row.groupId === current.groupId);
			const targetRows = rows.filter(
				(row) => row.groupId === targetGroupId && row.id !== id,
			);
			let insertIndex = targetRows.length;
			if (body.after_idea_id === null) {
				insertIndex = 0;
			} else if (body.after_idea_id !== undefined) {
				if (body.after_idea_id === id) throw new InvalidIdeaRelationError();
				const afterIndex = targetRows.findIndex(
					(row) => row.id === body.after_idea_id,
				);
				if (afterIndex < 0) throw new InvalidIdeaRelationError();
				insertIndex = afterIndex + 1;
			} else if (body.position !== undefined) {
				insertIndex = Math.min(body.position, targetRows.length);
			}
			const finalTargetIds = targetRows.map((row) => row.id);
			finalTargetIds.splice(insertIndex, 0, id);
			const finalSourceIds = sourceRows
				.filter((row) => row.id !== id)
				.map((row) => row.id);
			const maximumPosition = Math.max(-1, ...rows.map((row) => row.position));
			const temporaryBase = maximumPosition + rows.length + 1;

			const moveToTemporaryPositions = async (
				groupId: string,
				orderedRows: typeof sourceRows,
			): Promise<void> => {
				if (orderedRows.length === 0) return;
				const values = sql.join(
					orderedRows.map(
						(row, index) =>
							sql`(${row.id}::text, ${temporaryBase + index}::integer)`,
					),
					sql`, `,
				);
				await tx.execute(sql`
					UPDATE ideas AS target
					SET position = value.position
					FROM (VALUES ${values}) AS value(id, position)
					WHERE target.id = value.id
						AND target.organization_id = ${orgId}
						AND target.group_id = ${groupId}
				`);
			};

			await moveToTemporaryPositions(current.groupId, sourceRows);
			if (targetGroupId !== current.groupId) {
				await moveToTemporaryPositions(targetGroupId, targetRows);
				await tx
					.update(ideas)
					.set({
						groupId: targetGroupId,
						groupScopeKey: relationScopes.groupScopeKey,
						position: temporaryBase + rows.length + 1,
					})
					.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)));
			}

			const applyFinalOrder = async (
				groupId: string,
				orderedIds: string[],
			): Promise<void> => {
				if (orderedIds.length === 0) return;
				const values = sql.join(
					orderedIds.map(
						(ideaId, index) => sql`(${ideaId}::text, ${index}::integer)`,
					),
					sql`, `,
				);
				await tx.execute(sql`
					UPDATE ideas AS target
					SET position = value.position,
						revision = target.revision + 1,
						updated_at = now()
					FROM (VALUES ${values}) AS value(id, position)
					WHERE target.id = value.id
						AND target.organization_id = ${orgId}
						AND target.group_id = ${groupId}
				`);
			};

			if (targetGroupId === current.groupId) {
				await applyFinalOrder(targetGroupId, finalTargetIds);
			} else {
				await applyFinalOrder(current.groupId, finalSourceIds);
				await applyFinalOrder(targetGroupId, finalTargetIds);
			}
			const [changed] = await tx
				.select()
				.from(ideas)
				.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
				.limit(1);
			if (!changed) return { kind: "missing" } as const;

			await tx.insert(ideaActivity).values({
				ideaId: id,
				organizationId: orgId,
				actorPrincipalId: principalId,
				action: "moved",
				metadata: {
					from_group: current.groupId,
					to_group: targetGroupId,
				},
			});
			return { kind: "updated", row: changed } as const;
		});
	} catch (error) {
		if (error instanceof InvalidIdeaRelationError) {
			return c.json(
				{
					error: {
						code: "INVALID_IDEA_RELATION",
						message:
							"The target group and relative idea must belong to the same organization and workspace",
					},
				},
				400,
			);
		}
		throw error;
	}

	if (moveResult.kind === "missing") {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}
	if (moveResult.kind === "denied") return moveResult.response as never;
	if (moveResult.kind === "conflict") {
		return c.json(
			{
				error: {
					code: "REVISION_CONFLICT",
					message: "The Idea order changed; reload and retry.",
				},
			},
			409 as never,
		);
	}
	const updatedRow = moveResult.row;

	const [tagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id, orgId, updatedRow.scopeKey),
		fetchIdeaMedia(db, id, orgId),
	]);

	return c.json(
		await serializeIdeaWithMedia(db, c.env, updatedRow, tagRows, mediaRows),
		200,
	);
});

// ── Convert idea ──────────────────────────────────────────────────────────────

const convertIdea = createRoute({
	operationId: "convertIdea",
	method: "post",
	path: "/{id}/convert",
	tags: ["Ideas"],
	summary: "Convert an idea to a post",
	description:
		"Idempotently creates one draft post in the Idea's exact scope. Ready original media is copied into the draft in the same transaction.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: ConvertIdeaBody } },
		},
	},
	responses: {
		200: {
			description: "Idea converted to post",
			content: {
				"application/json": {
					schema: z.object({
						idea: IdeaResponse,
						post_id: z
							.string()
							.describe("Created or previously converted post ID"),
						media_copied: z.number().int().nonnegative(),
					}),
				},
			},
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Revision or idempotency conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(convertIdea, async (c) => {
	const orgId = c.get("orgId");
	const principalId = c.get("principalId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const result = await db.transaction(async (tx) => {
		// Serialize the caller-supplied identity across Ideas before taking an
		// Idea row lock. The database unique key remains the final fence.
		await acquireAdvisoryLocks(tx, [
			`idea-conversion:${orgId}:${body.idempotency_key}`,
		]);
		const [existing] = await tx
			.select()
			.from(ideas)
			.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
			.for("update")
			.limit(1);
		if (!existing) return { kind: "missing" } as const;
		const denied = assertWorkspaceScope(c, existing.workspaceId);
		if (denied) return { kind: "denied", response: denied } as const;

		const [keyOwner] = await tx
			.select({ ideaId: ideaConversionOperations.ideaId })
			.from(ideaConversionOperations)
			.where(
				and(
					eq(ideaConversionOperations.organizationId, orgId),
					eq(ideaConversionOperations.idempotencyKey, body.idempotency_key),
				),
			)
			.limit(1);
		if (keyOwner && keyOwner.ideaId !== id) {
			return { kind: "idempotency_conflict" } as const;
		}
		const [operation] = await tx
			.select()
			.from(ideaConversionOperations)
			.where(
				and(
					eq(ideaConversionOperations.ideaId, id),
					eq(ideaConversionOperations.organizationId, orgId),
				),
			)
			.limit(1);
		if (operation && operation.idempotencyKey !== body.idempotency_key) {
			return { kind: "idempotency_conflict" } as const;
		}
		if (operation?.status === "succeeded" && operation.postId) {
			if (existing.convertedToPostId !== operation.postId) {
				throw new Error("Idea conversion ledger disagrees with the Idea row");
			}
			return {
				kind: "converted",
				row: existing,
				postId: operation.postId,
				mediaCopied: 0,
			} as const;
		}
		if (existing.convertedToPostId) {
			if (!operation) {
				await tx.insert(ideaConversionOperations).values({
					ideaId: id,
					organizationId: orgId,
					scopeKey: existing.scopeKey,
					idempotencyKey: body.idempotency_key,
					postId: existing.convertedToPostId,
					status: "succeeded",
					attempts: 1,
					completedAt: new Date(),
				});
			} else {
				await tx
					.update(ideaConversionOperations)
					.set({
						postId: existing.convertedToPostId,
						status: "succeeded",
						completedAt: new Date(),
						updatedAt: new Date(),
						lastError: null,
					})
					.where(
						and(
							eq(ideaConversionOperations.id, operation.id),
							eq(ideaConversionOperations.organizationId, orgId),
						),
					);
			}
			return {
				kind: "converted",
				row: existing,
				postId: existing.convertedToPostId,
				mediaCopied: 0,
			} as const;
		}
		if (existing.revision !== body.expected_revision) {
			return { kind: "revision_conflict" } as const;
		}

		if (operation) {
			await tx
				.update(ideaConversionOperations)
				.set({
					status: "processing",
					attempts: sql`${ideaConversionOperations.attempts} + 1`,
					revision: sql`${ideaConversionOperations.revision} + 1`,
					lastError: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(ideaConversionOperations.id, operation.id),
						eq(ideaConversionOperations.organizationId, orgId),
					),
				);
		} else {
			await tx.insert(ideaConversionOperations).values({
				ideaId: id,
				organizationId: orgId,
				scopeKey: existing.scopeKey,
				idempotencyKey: body.idempotency_key,
				status: "processing",
				attempts: 1,
			});
		}

		const convertibleMedia = await tx
			.select({
				attachmentId: ideaMedia.id,
				url: media.url,
				thumbnail: media.thumbnailUrl,
				type: ideaMedia.type,
				position: ideaMedia.position,
			})
			.from(ideaMedia)
			.innerJoin(
				media,
				and(
					eq(media.id, ideaMedia.mediaId),
					eq(media.organizationId, ideaMedia.organizationId),
					eq(media.scopeKey, ideaMedia.scopeKey),
				),
			)
			.where(
				and(
					eq(ideaMedia.ideaId, id),
					eq(ideaMedia.organizationId, orgId),
					eq(media.status, "ready"),
					isNull(media.originalDeletedAt),
					isNull(media.deletionRequestedAt),
					sql`${media.url} IS NOT NULL`,
				),
			)
			.orderBy(asc(ideaMedia.position));
		const copiedMedia = convertibleMedia.flatMap((item) =>
			item.url
				? [
						{
							url: item.url,
							type: item.type,
							...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
						},
					]
				: [],
		);
		const [newPost] = await tx
			.insert(posts)
			.values({
				organizationId: orgId,
				workspaceId: existing.workspaceId,
				content: body.content ?? existing.content ?? null,
				status: "draft",
				timezone: body.timezone ?? "UTC",
				platformOverrides:
					copiedMedia.length > 0 ? { _media: copiedMedia } : null,
			})
			.returning({ id: posts.id });
		if (!newPost) throw new Error("Failed to create converted draft");
		const [updated] = await tx
			.update(ideas)
			.set({
				convertedToPostId: newPost.id,
				revision: sql`${ideas.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(ideas.id, id),
					eq(ideas.organizationId, orgId),
					eq(ideas.revision, body.expected_revision),
				),
			)
			.returning();
		if (!updated) throw new Error("Lost Idea conversion revision fence");
		if (convertibleMedia.length > 0) {
			await tx
				.update(ideaMedia)
				.set({ deleteWithIdea: false })
				.where(
					and(
						eq(ideaMedia.ideaId, id),
						eq(ideaMedia.organizationId, orgId),
						inArray(
							ideaMedia.id,
							convertibleMedia.map((item) => item.attachmentId),
						),
					),
				);
		}
		await tx.insert(ideaActivity).values({
			ideaId: id,
			organizationId: orgId,
			actorPrincipalId: principalId,
			action: "converted",
			metadata: { post_id: newPost.id, media_copied: copiedMedia.length },
		});
		await tx
			.update(ideaConversionOperations)
			.set({
				postId: newPost.id,
				status: "succeeded",
				completedAt: new Date(),
				updatedAt: new Date(),
				lastError: null,
			})
			.where(
				and(
					eq(ideaConversionOperations.ideaId, id),
					eq(ideaConversionOperations.organizationId, orgId),
				),
			);
		return {
			kind: "converted",
			row: updated,
			postId: newPost.id,
			mediaCopied: copiedMedia.length,
		} as const;
	});

	if (result.kind === "missing") {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}
	if (result.kind === "denied") return result.response as never;
	if (result.kind === "idempotency_conflict") {
		return c.json(
			{
				error: {
					code: "IDEMPOTENCY_KEY_REUSED",
					message: "This idempotency key belongs to another Idea conversion.",
				},
			},
			409 as never,
		);
	}
	if (result.kind === "revision_conflict") {
		return c.json(
			{
				error: {
					code: "REVISION_CONFLICT",
					message: "The Idea changed; reload it and retry conversion.",
				},
			},
			409 as never,
		);
	}

	const [tagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id, orgId, result.row.scopeKey),
		fetchIdeaMedia(db, id, orgId),
	]);

	return c.json(
		{
			idea: await serializeIdeaWithMedia(
				db,
				c.env,
				result.row,
				tagRows,
				mediaRows,
			),
			post_id: result.postId,
			media_copied: result.mediaCopied,
		},
		200,
	);
});

// ── Upload idea media ─────────────────────────────────────────────────────────

const uploadIdeaMedia = createRoute({
	operationId: "uploadIdeaMedia",
	method: "post",
	path: "/{id}/media",
	tags: ["Ideas"],
	summary: "Upload media to an idea",
	description:
		"Multipart upload (max 2MB). The database upload intent is committed before R2 and recovered from object events or the scheduled reconciler.",
	security: [{ Bearer: [] }],
	middleware: multipartMutationInputPreflight,
	request: {
		params: IdParam,
		body: {
			content: {
				"multipart/form-data": {
					schema: z.object({
						file: z.any().describe("File to upload"),
						alt: z.string().optional().describe("Alt text"),
					}),
				},
			},
			required: true,
		},
	},
	responses: {
		201: {
			description: "Media uploaded",
			content: { "application/json": { schema: IdeaMediaResponse } },
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — handler may return additional error statuses
app.openapi(uploadIdeaMedia, async (c) => {
	const orgId = c.get("orgId");
	const principalId = c.get("principalId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	// Parse multipart form
	let formData: FormData;
	try {
		formData = await c.req.formData();
	} catch {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: "Request must be multipart/form-data",
				},
			},
			400,
		);
	}

	const file = formData.get("file");
	if (!file || !(file instanceof File)) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "BAD_REQUEST", message: "Missing 'file' field" } },
			400,
		);
	}

	const MAX_SIZE = 2 * 1024 * 1024; // 2MB
	if (file.size <= 0 || file.size > MAX_SIZE) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: file.size <= 0 ? "BAD_REQUEST" : "FILE_TOO_LARGE",
					message: file.size <= 0 ? "File is empty" : "Max upload size is 2MB",
				},
			},
			400,
		);
	}

	const altText = formData.get("alt");
	const alt = typeof altText === "string" ? altText : null;

	const mime = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
	let mediaType: "image" | "video" | "gif" | "document";
	if (mime === "image/gif") {
		mediaType = "gif";
	} else if (
		[
			"image/jpeg",
			"image/png",
			"image/webp",
			"image/heic",
			"image/heif",
			"image/avif",
		].includes(mime)
	) {
		mediaType = "image";
	} else if (
		["video/mp4", "video/webm", "video/quicktime", "video/mpeg"].includes(mime)
	) {
		mediaType = "video";
	} else if (mime === "application/pdf") {
		mediaType = "document";
	} else {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "INVALID_CONTENT_TYPE",
					message:
						"Supported Idea media types are images, videos, GIFs, and PDF.",
				},
			},
			400,
		);
	}

	const safeFilename = file.name
		.replace(/[/\\]/g, "_")
		.replace(/\.\./g, "_")
		.replace(/\0/g, "")
		.replace(/[<>"'&]/g, "_")
		.replace(/[%#?]/g, "_");
	const coreMediaId = generateId("med_");
	const storageKey = `${orgId}/ideas/${id}/${generateId("file_")}/${safeFilename}`;
	const canonicalUrl = `https://${mediaPublicHost(c.env)}/${storageKey}`;

	const arrayBuffer = await file.arrayBuffer();
	const intent = await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({
				id: ideas.id,
				workspaceId: ideas.workspaceId,
				scopeKey: ideas.scopeKey,
			})
			.from(ideas)
			.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
			.for("update")
			.limit(1);
		if (!existing) return { kind: "missing" } as const;
		const denied = assertWorkspaceScope(c, existing.workspaceId);
		if (denied) return { kind: "denied", response: denied } as const;
		await tx.insert(media).values({
			id: coreMediaId,
			organizationId: orgId,
			workspaceId: existing.workspaceId,
			filename: safeFilename,
			mimeType: mime,
			size: file.size,
			storageKey,
			storageProvider: "r2",
			storageBucketLocator: c.env.R2_MEDIA_BUCKET_NAME,
			storageRegion: c.env.R2_MEDIA_BUCKET_JURISDICTION,
			url: canonicalUrl,
			status: "uploading",
		});
		const [attachment] = await tx
			.insert(ideaMedia)
			.values({
				ideaId: id,
				mediaId: coreMediaId,
				organizationId: orgId,
				workspaceId: existing.workspaceId,
				type: mediaType,
				alt,
				position: sql`COALESCE((
					SELECT MAX(position) + 1
					FROM idea_media
					WHERE idea_id = ${id}
				), 0)`,
				deleteWithIdea: true,
			})
			.returning({ id: ideaMedia.id });
		if (!attachment) throw new Error("Failed to persist Idea media intent");
		await tx.insert(ideaActivity).values({
			ideaId: id,
			organizationId: orgId,
			actorPrincipalId: principalId,
			action: "media_added",
			metadata: {
				media_id: attachment.id,
				core_media_id: coreMediaId,
				filename: file.name,
				state: "uploading",
			},
		});
		return { kind: "ready", attachmentId: attachment.id } as const;
	});
	if (intent.kind === "missing") {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}
	if (intent.kind === "denied") {
		markMutationInputNotApplied(c);
		return intent.response;
	}

	try {
		await c.env.MEDIA_BUCKET.put(storageKey, arrayBuffer, {
			httpMetadata: { contentType: mime },
			customMetadata: { orgId, ideaId: id, mediaId: coreMediaId },
		});
	} catch (error) {
		await db
			.update(media)
			.set({ status: "upload_failed" })
			.where(
				and(
					eq(media.id, coreMediaId),
					eq(media.organizationId, orgId),
					eq(media.status, "uploading"),
				),
			)
			.catch(() => {});
		throw error;
	}

	const completed = await db
		.update(media)
		.set({ status: "ready", size: arrayBuffer.byteLength })
		.where(
			and(
				eq(media.id, coreMediaId),
				eq(media.organizationId, orgId),
				eq(media.status, "uploading"),
				isNull(media.deletionRequestedAt),
			),
		)
		.returning({ id: media.id });
	if (completed.length === 0) {
		// The Idea or attachment was deleted while R2 accepted the bytes. Its
		// durable tombstone wins; immediately resume deletion to avoid an orphan.
		await processMediaDeletion(db, c.env, coreMediaId).catch(() => {});
		return c.json(
			{
				error: {
					code: "MEDIA_UPLOAD_CANCELLED",
					message: "The Idea media attachment was deleted during upload.",
				},
			},
			409 as never,
		);
	}
	const uploaded = (await fetchIdeaMedia(db, id, orgId)).find(
		(row) => row.id === intent.attachmentId,
	);
	if (!uploaded) throw new Error("Uploaded Idea media relation disappeared");
	const [presigned] = (await presignRelayMediaUrls(
		db,
		c.env,
		[uploaded],
		3600,
		orgId,
	)) ?? [uploaded];
	return c.json(serializeMedia(presigned ?? uploaded), 201);
});

// ── Delete idea media ─────────────────────────────────────────────────────────

const IdeaMediaParam = z.object({ id: z.string(), media_id: z.string() });

const deleteIdeaMedia = createRoute({
	operationId: "deleteIdeaMedia",
	method: "delete",
	path: "/{id}/media/{media_id}",
	tags: ["Ideas"],
	summary: "Delete idea media",
	security: [{ Bearer: [] }],
	request: { params: IdeaMediaParam },
	responses: {
		204: { description: "Media deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteIdeaMedia, async (c) => {
	const orgId = c.get("orgId");
	const principalId = c.get("principalId");
	const { id, media_id } = c.req.valid("param");
	const db = c.get("db");

	const result = await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({ id: ideas.id, workspaceId: ideas.workspaceId })
			.from(ideas)
			.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
			.for("update")
			.limit(1);
		if (!existing) return { kind: "idea_missing" } as const;
		const denied = assertWorkspaceScope(c, existing.workspaceId);
		if (denied) return { kind: "denied", response: denied } as const;

		const [attachment] = await tx
			.select({
				id: ideaMedia.id,
				coreMediaId: ideaMedia.mediaId,
				deleteWithIdea: ideaMedia.deleteWithIdea,
				storageKey: media.storageKey,
				thumbnailKey: media.thumbnailKey,
				status: media.status,
			})
			.from(ideaMedia)
			.innerJoin(
				media,
				and(
					eq(media.id, ideaMedia.mediaId),
					eq(media.organizationId, ideaMedia.organizationId),
					eq(media.scopeKey, ideaMedia.scopeKey),
				),
			)
			.where(
				and(
					eq(ideaMedia.id, media_id),
					eq(ideaMedia.ideaId, id),
					eq(ideaMedia.organizationId, orgId),
				),
			)
			.for("update", { of: media })
			.limit(1);
		if (!attachment) return { kind: "media_missing" } as const;

		await tx
			.delete(ideaMedia)
			.where(
				and(eq(ideaMedia.id, media_id), eq(ideaMedia.organizationId, orgId)),
			);
		let processNow = false;
		if (attachment.deleteWithIdea) {
			const now = new Date();
			const thumbnailTarget = thumbnailStorageTarget(c.env);
			const uploadMayStillFinish =
				attachment.status === "uploading" ||
				attachment.status === "upload_failed";
			await tx
				.update(media)
				.set({
					status: "deleting",
					url: null,
					thumbnailKey:
						attachment.thumbnailKey ?? thumbnailKeyFor(attachment.storageKey),
					...(attachment.thumbnailKey
						? {}
						: {
								thumbnailStorageProvider: thumbnailTarget.provider,
								thumbnailStorageBucketLocator: thumbnailTarget.bucket,
								thumbnailStorageRegion: thumbnailTarget.region,
							}),
					deletionRequestedAt: sql`COALESCE(${media.deletionRequestedAt}, ${now})`,
					deletionNextRetryAt: uploadMayStillFinish
						? new Date(now.getTime() + 5 * 60_000)
						: now,
					deletionLastError: null,
				})
				.where(
					and(
						eq(media.id, attachment.coreMediaId),
						eq(media.organizationId, orgId),
					),
				);
			processNow = !uploadMayStillFinish;
		}
		await tx.insert(ideaActivity).values({
			ideaId: id,
			organizationId: orgId,
			actorPrincipalId: principalId,
			action: "media_removed",
			metadata: {
				media_id,
				core_media_id: attachment.coreMediaId,
				object_deleted: attachment.deleteWithIdea,
			},
		});
		return {
			kind: "deleted",
			coreMediaId: attachment.coreMediaId,
			processNow,
		} as const;
	});

	if (result.kind === "idea_missing") {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}
	if (result.kind === "denied") return result.response;
	if (result.kind === "media_missing") {
		return c.json(
			{ error: { code: "media_not_found", message: "Media not found" } },
			404,
		);
	}
	if (result.processNow) {
		await processMediaDeletion(db, c.env, result.coreMediaId).catch(() => {});
	}

	return c.body(null, 204);
});

// ── List comments ─────────────────────────────────────────────────────────────

const listComments = createRoute({
	operationId: "listIdeaComments",
	method: "get",
	path: "/{id}/comments",
	tags: ["Ideas"],
	summary: "List comments on an idea",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		query: IdeaCommentListQuery,
	},
	responses: {
		200: {
			description: "List of comments",
			content: { "application/json": { schema: IdeaCommentListResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listComments, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { limit, cursor } = c.req.valid("query");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const conditions = [
		eq(ideaComments.organizationId, orgId),
		eq(ideaComments.ideaId, id),
	];
	if (cursor) {
		conditions.push(lt(ideaComments.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(ideaComments)
		.where(and(...conditions))
		.orderBy(desc(ideaComments.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	const actors = await resolveActors(
		db,
		orgId,
		data.map((row) => row.authorPrincipalId),
	);

	return c.json(
		{
			data: data.map((row) =>
				serializeComment(row, actors.get(row.authorPrincipalId) ?? null),
			),
			next_cursor: hasMore
				? (data.at(-1)?.createdAt.toISOString() ?? null)
				: null,
			has_more: hasMore,
		},
		200,
	);
});

// ── Create comment ────────────────────────────────────────────────────────────

const createComment = createRoute({
	operationId: "createIdeaComment",
	method: "post",
	path: "/{id}/comments",
	tags: ["Ideas"],
	summary: "Add a comment to an idea",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: CreateIdeaCommentBody } },
		},
	},
	responses: {
		201: {
			description: "Comment created",
			content: { "application/json": { schema: IdeaCommentResponse } },
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — handler may return 400 from threading validation
app.openapi(createComment, async (c) => {
	const orgId = c.get("orgId");
	const principalId = c.get("principalId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	let parentId: string | null = null;
	if (body.parent_id) {
		// Validate parent exists and belongs to same idea
		const [parent] = await db
			.select({
				id: ideaComments.id,
				parentId: ideaComments.parentId,
				ideaId: ideaComments.ideaId,
			})
			.from(ideaComments)
			.where(
				and(
					eq(ideaComments.id, body.parent_id),
					eq(ideaComments.ideaId, id),
					eq(ideaComments.organizationId, orgId),
				),
			)
			.limit(1);

		if (!parent) {
			return c.json(
				{
					error: {
						code: "parent_not_found",
						message: "Parent comment not found on this idea",
					},
				},
				400,
			);
		}

		// Enforce one level of threading — parent must be a root comment
		if (parent.parentId !== null) {
			return c.json(
				{
					error: {
						code: "THREADING_DEPTH_EXCEEDED",
						message: "Only one level of comment threading is supported",
					},
				},
				400,
			);
		}

		parentId = body.parent_id;
	}

	const [row] = await db
		.insert(ideaComments)
		.values({
			ideaId: id,
			organizationId: orgId,
			authorPrincipalId: principalId,
			content: body.content,
			parentId,
		})
		.returning();

	if (!row) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to create comment" },
			} as never,
			500 as never,
		);
	}

	await logActivity(db, id, orgId, principalId, "commented", {
		comment_id: row.id,
	});

	const actors = await resolveActors(db, orgId, [row.authorPrincipalId]);

	return c.json(
		serializeComment(row, actors.get(row.authorPrincipalId) ?? null),
		201,
	);
});

// ── Update comment ────────────────────────────────────────────────────────────

const IdeaCommentParam = z.object({ id: z.string(), comment_id: z.string() });

const updateComment = createRoute({
	operationId: "updateIdeaComment",
	method: "patch",
	path: "/{id}/comments/{comment_id}",
	tags: ["Ideas"],
	summary: "Edit a comment",
	security: [{ Bearer: [] }],
	request: {
		params: IdeaCommentParam,
		body: {
			content: { "application/json": { schema: UpdateIdeaCommentBody } },
		},
	},
	responses: {
		200: {
			description: "Comment updated",
			content: { "application/json": { schema: IdeaCommentResponse } },
		},
		403: {
			description: "Forbidden — not the comment author",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateComment, async (c) => {
	const orgId = c.get("orgId");
	const principalId = c.get("principalId");
	const { id, comment_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const [comment] = await db
		.select()
		.from(ideaComments)
		.where(
			and(
				eq(ideaComments.id, comment_id),
				eq(ideaComments.ideaId, id),
				eq(ideaComments.organizationId, orgId),
			),
		)
		.limit(1);

	if (!comment) {
		return c.json(
			{ error: { code: "comment_not_found", message: "Comment not found" } },
			404,
		);
	}

	// Only the author can edit
	if (comment.authorPrincipalId !== principalId) {
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message: "You can only edit your own comments",
				},
			},
			403,
		);
	}

	const [updated] = await db
		.update(ideaComments)
		.set({ content: body.content, updatedAt: new Date() })
		.where(
			and(
				eq(ideaComments.id, comment_id),
				eq(ideaComments.ideaId, id),
				eq(ideaComments.organizationId, orgId),
			),
		)
		.returning();

	const row = updated ?? comment;
	const actors = await resolveActors(db, orgId, [row.authorPrincipalId]);
	return c.json(
		serializeComment(row, actors.get(row.authorPrincipalId) ?? null),
		200,
	);
});

// ── Delete comment ────────────────────────────────────────────────────────────

const deleteComment = createRoute({
	operationId: "deleteIdeaComment",
	method: "delete",
	path: "/{id}/comments/{comment_id}",
	tags: ["Ideas"],
	summary: "Delete a comment",
	description: "Deletes own comment. FK cascade handles child replies.",
	security: [{ Bearer: [] }],
	request: { params: IdeaCommentParam },
	responses: {
		204: { description: "Comment deleted" },
		403: {
			description: "Forbidden — not the comment author",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteComment, async (c) => {
	const orgId = c.get("orgId");
	const principalId = c.get("principalId");
	const { id, comment_id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	const [comment] = await db
		.select({
			id: ideaComments.id,
			authorPrincipalId: ideaComments.authorPrincipalId,
		})
		.from(ideaComments)
		.where(
			and(
				eq(ideaComments.id, comment_id),
				eq(ideaComments.ideaId, id),
				eq(ideaComments.organizationId, orgId),
			),
		)
		.limit(1);

	if (!comment) {
		return c.json(
			{ error: { code: "comment_not_found", message: "Comment not found" } },
			404,
		);
	}

	// Only the author can delete
	if (comment.authorPrincipalId !== principalId) {
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message: "You can only delete your own comments",
				},
			},
			403,
		);
	}

	await db
		.delete(ideaComments)
		.where(
			and(
				eq(ideaComments.id, comment_id),
				eq(ideaComments.ideaId, id),
				eq(ideaComments.organizationId, orgId),
			),
		);

	return c.body(null, 204);
});

// ── List activity ─────────────────────────────────────────────────────────────

const listActivity = createRoute({
	operationId: "listIdeaActivity",
	method: "get",
	path: "/{id}/activity",
	tags: ["Ideas"],
	summary: "List activity for an idea",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		query: IdeaActivityListQuery,
	},
	responses: {
		200: {
			description: "List of activity events",
			content: { "application/json": { schema: IdeaActivityListResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listActivity, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { limit, cursor } = c.req.valid("query");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: ideas.id, workspaceId: ideas.workspaceId })
		.from(ideas)
		.where(and(eq(ideas.id, id), eq(ideas.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "idea_not_found", message: "Idea not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const conditions = [
		eq(ideaActivity.organizationId, orgId),
		eq(ideaActivity.ideaId, id),
	];
	if (cursor) {
		conditions.push(lt(ideaActivity.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(ideaActivity)
		.where(and(...conditions))
		.orderBy(desc(ideaActivity.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);
	const actors = await resolveActors(
		db,
		orgId,
		data.map((row) => row.actorPrincipalId),
	);

	return c.json(
		{
			data: data.map((row) => ({
				id: row.id,
				actor_id: row.actorPrincipalId,
				actor: actors.get(row.actorPrincipalId) ?? null,
				action: row.action,
				metadata: row.metadata ?? null,
				created_at: row.createdAt.toISOString(),
			})),
			next_cursor: hasMore
				? (data.at(-1)?.createdAt.toISOString() ?? null)
				: null,
			has_more: hasMore,
		},
		200,
	);
});

export { fetchIdeaMedia, fetchIdeaTags, logActivity, serializeIdea };
export default app;
