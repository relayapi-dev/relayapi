# Content Planning Feature — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a content planning/ideation system with Ideas, customizable kanban boards, tags, comments, and idea-to-post conversion.

**Architecture:** Separate `ideas` resource (not extending posts). New Drizzle tables, Hono routes with Zod-OpenAPI schemas, SDK resources, and tests. Ideas are channel-agnostic content cards organized in user-defined groups. Conversion to posts uses `idea_id` on `POST /v1/posts` and a dedicated `/convert` endpoint.

**Tech Stack:** Drizzle ORM (PostgreSQL), Hono + @hono/zod-openapi, Zod, Bun test, Stainless SDK generation.

**Spec:** `docs/superpowers/specs/2026-04-15-content-planning-design.md`

---

## Task 1: Database Schema — Enums and Tables

**Files:**
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Add the `idea_media_type` and `idea_activity_action` enums**

At the end of the existing enum definitions in `packages/db/src/schema.ts`, add:

```typescript
export const ideaMediaTypeEnum = pgEnum("idea_media_type", [
	"image",
	"video",
	"gif",
	"document",
]);

export const ideaActivityActionEnum = pgEnum("idea_activity_action", [
	"created",
	"moved",
	"assigned",
	"commented",
	"converted",
	"updated",
	"media_added",
	"media_removed",
	"tagged",
	"untagged",
]);
```

- [ ] **Step 2: Add `real` to the Drizzle imports**

Update the import from `drizzle-orm/pg-core` to include `real`:

```typescript
import {
	type AnyPgColumn,
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgSchema,
	pgTable,
	primaryKey,
	real,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 3: Add the `tags` table**

```typescript
export const tags = pgTable(
	"tags",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("tag_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		color: text("color").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("tags_org_idx").on(table.organizationId),
		index("tags_workspace_idx").on(table.workspaceId),
	],
);
```

- [ ] **Step 4: Add the `idea_groups` table**

```typescript
export const ideaGroups = pgTable(
	"idea_groups",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("idg_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),
		name: text("name").notNull(),
		position: real("position").notNull().default(0),
		color: text("color"),
		isDefault: boolean("is_default").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idea_groups_org_idx").on(table.organizationId),
		index("idea_groups_workspace_idx").on(table.workspaceId),
		index("idea_groups_workspace_position_idx").on(
			table.workspaceId,
			table.position,
		),
	],
);
```

- [ ] **Step 5: Add the `ideas` table**

```typescript
export const ideas = pgTable(
	"ideas",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("idea_")),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		workspaceId: text("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),
		title: text("title"),
		content: text("content"),
		groupId: text("group_id")
			.notNull()
			.references(() => ideaGroups.id),
		position: real("position").notNull().default(0),
		assignedTo: text("assigned_to").references(() => user.id, {
			onDelete: "set null",
		}),
		convertedToPostId: text("converted_to_post_id").references(
			() => posts.id,
			{ onDelete: "set null" },
		),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("ideas_org_idx").on(table.organizationId),
		index("ideas_workspace_idx").on(table.workspaceId),
		index("ideas_group_position_idx").on(table.groupId, table.position),
		index("ideas_assigned_to_idx").on(table.assignedTo),
		index("ideas_org_created_idx").on(table.organizationId, table.createdAt),
	],
);
```

- [ ] **Step 6: Add the `idea_media` table**

```typescript
export const ideaMedia = pgTable(
	"idea_media",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("idm_")),
		ideaId: text("idea_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		url: text("url").notNull(),
		type: ideaMediaTypeEnum("type").notNull(),
		alt: text("alt"),
		position: integer("position").notNull().default(0),
	},
	(table) => [index("idea_media_idea_idx").on(table.ideaId)],
);
```

- [ ] **Step 7: Add the `idea_comments` table**

```typescript
export const ideaComments = pgTable(
	"idea_comments",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("idc_")),
		ideaId: text("idea_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		authorId: text("author_id")
			.notNull()
			.references(() => user.id),
		content: text("content").notNull(),
		parentId: text("parent_id").references(
			(): AnyPgColumn => ideaComments.id,
			{ onDelete: "cascade" },
		),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idea_comments_idea_idx").on(table.ideaId),
		index("idea_comments_parent_idx").on(table.parentId),
	],
);
```

- [ ] **Step 8: Add the `idea_tags` junction table**

```typescript
export const ideaTags = pgTable(
	"idea_tags",
	{
		ideaId: text("idea_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		tagId: text("tag_id")
			.notNull()
			.references(() => tags.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.ideaId, table.tagId] })],
);
```

- [ ] **Step 9: Add the `post_tags` junction table**

This enables shared tags between ideas and posts:

```typescript
export const postTags = pgTable(
	"post_tags",
	{
		postId: text("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		tagId: text("tag_id")
			.notNull()
			.references(() => tags.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.postId, table.tagId] })],
);
```

- [ ] **Step 10: Add the `idea_activity` table**

```typescript
export const ideaActivity = pgTable(
	"idea_activity",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("ida_")),
		ideaId: text("idea_id")
			.notNull()
			.references(() => ideas.id, { onDelete: "cascade" }),
		actorId: text("actor_id")
			.notNull()
			.references(() => user.id),
		action: ideaActivityActionEnum("action").notNull(),
		metadata: jsonb("metadata").$type<Record<string, unknown>>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idea_activity_idea_idx").on(table.ideaId),
		index("idea_activity_idea_created_idx").on(
			table.ideaId,
			table.createdAt,
		),
	],
);
```

- [ ] **Step 11: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors in `packages/db`

---

## Task 2: Generate Database Migration

**Files:**
- Creates: `packages/db/drizzle/XXXX_*.sql` (auto-generated)

- [ ] **Step 1: Generate the Drizzle migration**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run db:generate`
Expected: New migration file created in `packages/db/drizzle/`

- [ ] **Step 2: Review the generated SQL**

Read the generated migration file. Verify it contains:
- `CREATE TYPE idea_media_type`
- `CREATE TYPE idea_activity_action`
- `CREATE TABLE tags`
- `CREATE TABLE idea_groups`
- `CREATE TABLE ideas`
- `CREATE TABLE idea_media`
- `CREATE TABLE idea_comments`
- `CREATE TABLE idea_tags`
- `CREATE TABLE post_tags`
- `CREATE TABLE idea_activity`
- All indexes and foreign keys

- [ ] **Step 3: Run the migration**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run db:migrate`
Expected: Migration applies successfully

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/
git commit -m "feat: add database schema for content planning (ideas, groups, tags, comments, activity)"
```

---

## Task 3: Tags — Schemas, Routes, and Registration

Tags are a shared resource used by both ideas and posts. Build this first since ideas depend on it.

**Files:**
- Create: `apps/api/src/schemas/tags.ts`
- Create: `apps/api/src/routes/tags.ts`
- Modify: `apps/api/src/index.ts` (register route)

- [ ] **Step 1: Create the tags schema file**

Create `apps/api/src/schemas/tags.ts`:

```typescript
import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

export const CreateTagBody = z
	.object({
		name: z.string().min(1).max(100).describe("Tag name"),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #FF0000")
			.describe("Hex color"),
		workspace_id: z
			.string()
			.optional()
			.describe("Workspace ID to scope this tag to"),
	})
	.describe("Create a tag");

export const UpdateTagBody = z
	.object({
		name: z.string().min(1).max(100).optional().describe("Tag name"),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #FF0000")
			.optional()
			.describe("Hex color"),
	})
	.describe("Update a tag");

export const TagResponse = z.object({
	id: z.string().describe("Tag ID"),
	name: z.string().describe("Tag name"),
	color: z.string().describe("Hex color"),
	workspace_id: z.string().nullable().describe("Workspace ID"),
	created_at: z.string().datetime().describe("Creation timestamp"),
});

export const TagListQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Items per page"),
	workspace_id: z.string().optional().describe("Filter by workspace"),
});

export const TagListResponse = paginatedResponse(TagResponse);
```

- [ ] **Step 2: Create the tags route file**

Create `apps/api/src/routes/tags.ts`:

```typescript
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, tags, ideaTags, postTags } from "@relayapi/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { ErrorResponse, IdParam } from "../schemas/common";
import {
	CreateTagBody,
	UpdateTagBody,
	TagResponse,
	TagListQuery,
	TagListResponse,
} from "../schemas/tags";
import type { Env, Variables } from "../types";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import { assertScopedCreateWorkspace } from "../lib/request-access";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

function serialize(row: typeof tags.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		color: row.color,
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
	};
}

// ── List tags ────────────────────────────────────────────────────────────────

const listTags = createRoute({
	operationId: "listTags",
	method: "get",
	path: "/",
	tags: ["Tags"],
	summary: "List tags",
	security: [{ Bearer: [] }],
	request: { query: TagListQuery },
	responses: {
		200: {
			description: "List of tags",
			content: { "application/json": { schema: TagListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listTags, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor, workspace_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const conditions = [eq(tags.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, tags.workspaceId);
	if (workspace_id) {
		conditions.push(eq(tags.workspaceId, workspace_id));
	}
	if (cursor) {
		conditions.push(lt(tags.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(tags)
		.where(and(...conditions))
		.orderBy(desc(tags.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map(serialize),
			next_cursor: hasMore
				? (data.at(-1)?.createdAt.toISOString() ?? null)
				: null,
			has_more: hasMore,
		},
		200,
	);
});

// ── Create tag ───────────────────────────────────────────────────────────────

const createTag = createRoute({
	operationId: "createTag",
	method: "post",
	path: "/",
	tags: ["Tags"],
	summary: "Create a tag",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateTagBody } },
		},
	},
	responses: {
		201: {
			description: "Tag created",
			content: { "application/json": { schema: TagResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createTag, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "tag");
	if (denied) return denied;

	const [row] = await db
		.insert(tags)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			color: body.color,
		})
		.returning();

	if (!row) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create tag",
				},
			} as never,
			500 as never,
		);
	}

	return c.json(serialize(row), 201);
});

// ── Update tag ───────────────────────────────────────────────────────────────

const updateTag = createRoute({
	operationId: "updateTag",
	method: "patch",
	path: "/{id}",
	tags: ["Tags"],
	summary: "Update a tag",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateTagBody } },
		},
	},
	responses: {
		200: {
			description: "Tag updated",
			content: { "application/json": { schema: TagResponse } },
		},
		404: {
			description: "Tag not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateTag, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select()
		.from(tags)
		.where(and(eq(tags.id, id), eq(tags.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "tag_not_found", message: "Tag not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const updates: Record<string, unknown> = {};
	if (body.name !== undefined) updates.name = body.name;
	if (body.color !== undefined) updates.color = body.color;

	if (Object.keys(updates).length === 0) {
		return c.json(serialize(existing), 200);
	}

	const [updated] = await db
		.update(tags)
		.set(updates)
		.where(eq(tags.id, id))
		.returning();

	return c.json(serialize(updated ?? existing), 200);
});

// ── Delete tag ───────────────────────────────────────────────────────────────

const deleteTag = createRoute({
	operationId: "deleteTag",
	method: "delete",
	path: "/{id}",
	tags: ["Tags"],
	summary: "Delete a tag",
	description:
		"Deletes a tag and removes it from all associated ideas and posts.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Tag deleted" },
		404: {
			description: "Tag not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteTag, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: tags.id, workspaceId: tags.workspaceId })
		.from(tags)
		.where(and(eq(tags.id, id), eq(tags.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "tag_not_found", message: "Tag not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	// Cascade deletes idea_tags and post_tags rows via FK onDelete
	await db.delete(tags).where(eq(tags.id, id));

	return c.body(null, 204);
});

export default app;
```

- [ ] **Step 3: Register the tags route in index.ts**

In `apps/api/src/index.ts`, add the import and mount:

```typescript
import tagsRouter from "./routes/tags";
// ...
app.route("/v1/tags", tagsRouter);
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/schemas/tags.ts apps/api/src/routes/tags.ts apps/api/src/index.ts
git commit -m "feat: add tags CRUD endpoints (shared across ideas and posts)"
```

---

## Task 4: Idea Groups — Schemas, Routes, and Registration

**Files:**
- Create: `apps/api/src/schemas/idea-groups.ts`
- Create: `apps/api/src/routes/idea-groups.ts`
- Modify: `apps/api/src/index.ts` (register route)

- [ ] **Step 1: Create the idea-groups schema file**

Create `apps/api/src/schemas/idea-groups.ts`:

```typescript
import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

export const CreateIdeaGroupBody = z
	.object({
		name: z.string().min(1).max(200).describe("Group name"),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #FF0000")
			.optional()
			.describe("Hex color for column header"),
		position: z.number().optional().describe("Position (float). Defaults to end."),
		workspace_id: z
			.string()
			.optional()
			.describe("Workspace ID to scope this group to"),
	})
	.describe("Create an idea group (kanban column)");

export const UpdateIdeaGroupBody = z
	.object({
		name: z.string().min(1).max(200).optional().describe("Group name"),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #FF0000")
			.nullable()
			.optional()
			.describe("Hex color for column header"),
	})
	.describe("Update an idea group");

export const ReorderIdeaGroupsBody = z
	.object({
		groups: z
			.array(
				z.object({
					id: z.string().describe("Group ID"),
					position: z.number().describe("New position (float)"),
				}),
			)
			.min(1)
			.describe("Groups with new positions"),
	})
	.describe("Reorder idea groups");

export const IdeaGroupResponse = z.object({
	id: z.string().describe("Group ID"),
	name: z.string().describe("Group name"),
	position: z.number().describe("Position for ordering"),
	color: z.string().nullable().describe("Hex color"),
	is_default: z.boolean().describe("Whether this is the default group"),
	workspace_id: z.string().nullable().describe("Workspace ID"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

export const IdeaGroupListQuery = z.object({
	workspace_id: z.string().optional().describe("Filter by workspace"),
});

export const IdeaGroupListResponse = z.object({
	data: z.array(IdeaGroupResponse),
});
```

- [ ] **Step 2: Create the idea-groups route file**

Create `apps/api/src/routes/idea-groups.ts`:

```typescript
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, ideaGroups, ideas } from "@relayapi/db";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { ErrorResponse, IdParam } from "../schemas/common";
import {
	CreateIdeaGroupBody,
	UpdateIdeaGroupBody,
	ReorderIdeaGroupsBody,
	IdeaGroupResponse,
	IdeaGroupListQuery,
	IdeaGroupListResponse,
} from "../schemas/idea-groups";
import type { Env, Variables } from "../types";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import { assertScopedCreateWorkspace } from "../lib/request-access";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

function serialize(row: typeof ideaGroups.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		position: row.position,
		color: row.color ?? null,
		is_default: row.isDefault,
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

/**
 * Ensures the workspace has a default "Unassigned" group.
 * Returns the default group ID.
 */
async function ensureDefaultGroup(
	db: ReturnType<typeof createDb>,
	orgId: string,
	workspaceId: string | null,
): Promise<string> {
	const conditions = [
		eq(ideaGroups.organizationId, orgId),
		eq(ideaGroups.isDefault, true),
	];
	if (workspaceId) {
		conditions.push(eq(ideaGroups.workspaceId, workspaceId));
	} else {
		conditions.push(sql`${ideaGroups.workspaceId} IS NULL`);
	}

	const [existing] = await db
		.select({ id: ideaGroups.id })
		.from(ideaGroups)
		.where(and(...conditions))
		.limit(1);

	if (existing) return existing.id;

	const [created] = await db
		.insert(ideaGroups)
		.values({
			organizationId: orgId,
			workspaceId: workspaceId,
			name: "Unassigned",
			position: 0,
			isDefault: true,
		})
		.returning({ id: ideaGroups.id });

	return created!.id;
}

// ── List groups ──────────────────────────────────────────────────────────────

const listGroups = createRoute({
	operationId: "listIdeaGroups",
	method: "get",
	path: "/",
	tags: ["Idea Groups"],
	summary: "List idea groups",
	description:
		"Returns all idea groups (kanban columns) for the workspace, ordered by position. Creates a default 'Unassigned' group if none exist.",
	security: [{ Bearer: [] }],
	request: { query: IdeaGroupListQuery },
	responses: {
		200: {
			description: "List of idea groups",
			content: { "application/json": { schema: IdeaGroupListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listGroups, async (c) => {
	const orgId = c.get("orgId");
	const { workspace_id } = c.req.valid("query");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Ensure default group exists
	await ensureDefaultGroup(db, orgId, workspace_id ?? null);

	const conditions = [eq(ideaGroups.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, ideaGroups.workspaceId);
	if (workspace_id) {
		conditions.push(eq(ideaGroups.workspaceId, workspace_id));
	}

	const rows = await db
		.select()
		.from(ideaGroups)
		.where(and(...conditions))
		.orderBy(asc(ideaGroups.position));

	return c.json({ data: rows.map(serialize) }, 200);
});

// ── Create group ─────────────────────────────────────────────────────────────

const createGroup = createRoute({
	operationId: "createIdeaGroup",
	method: "post",
	path: "/",
	tags: ["Idea Groups"],
	summary: "Create an idea group",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateIdeaGroupBody } },
		},
	},
	responses: {
		201: {
			description: "Group created",
			content: { "application/json": { schema: IdeaGroupResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createGroup, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "idea group");
	if (denied) return denied;

	// If no position provided, place at the end
	let position = body.position;
	if (position === undefined) {
		const [result] = await db
			.select({ maxPos: max(ideaGroups.position) })
			.from(ideaGroups)
			.where(eq(ideaGroups.organizationId, orgId));
		position = (result?.maxPos ?? 0) + 1;
	}

	const [row] = await db
		.insert(ideaGroups)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			position,
			color: body.color ?? null,
		})
		.returning();

	if (!row) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create idea group",
				},
			} as never,
			500 as never,
		);
	}

	return c.json(serialize(row), 201);
});

// ── Update group ─────────────────────────────────────────────────────────────

const updateGroup = createRoute({
	operationId: "updateIdeaGroup",
	method: "patch",
	path: "/{id}",
	tags: ["Idea Groups"],
	summary: "Update an idea group",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateIdeaGroupBody } },
		},
	},
	responses: {
		200: {
			description: "Group updated",
			content: { "application/json": { schema: IdeaGroupResponse } },
		},
		404: {
			description: "Group not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateGroup, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select()
		.from(ideaGroups)
		.where(and(eq(ideaGroups.id, id), eq(ideaGroups.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{
				error: {
					code: "idea_group_not_found",
					message: "Idea group not found",
				},
			},
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updates.name = body.name;
	if (body.color !== undefined) updates.color = body.color;

	const [updated] = await db
		.update(ideaGroups)
		.set(updates)
		.where(eq(ideaGroups.id, id))
		.returning();

	return c.json(serialize(updated ?? existing), 200);
});

// ── Delete group ─────────────────────────────────────────────────────────────

const deleteGroup = createRoute({
	operationId: "deleteIdeaGroup",
	method: "delete",
	path: "/{id}",
	tags: ["Idea Groups"],
	summary: "Delete an idea group",
	description:
		"Deletes an idea group. Ideas in the group are moved to the default 'Unassigned' group. The default group cannot be deleted.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Group deleted" },
		400: {
			description: "Cannot delete default group",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Group not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteGroup, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select()
		.from(ideaGroups)
		.where(and(eq(ideaGroups.id, id), eq(ideaGroups.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{
				error: {
					code: "idea_group_not_found",
					message: "Idea group not found",
				},
			},
			404,
		);
	}

	if (existing.isDefault) {
		return c.json(
			{
				error: {
					code: "cannot_delete_default_group",
					message: "The default group cannot be deleted",
				},
			},
			400,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	// Move ideas to the default group
	const defaultGroupId = await ensureDefaultGroup(
		db,
		orgId,
		existing.workspaceId,
	);

	await db
		.update(ideas)
		.set({ groupId: defaultGroupId, updatedAt: new Date() })
		.where(eq(ideas.groupId, id));

	await db.delete(ideaGroups).where(eq(ideaGroups.id, id));

	return c.body(null, 204);
});

// ── Reorder groups ───────────────────────────────────────────────────────────

const reorderGroups = createRoute({
	operationId: "reorderIdeaGroups",
	method: "post",
	path: "/reorder",
	tags: ["Idea Groups"],
	summary: "Reorder idea groups",
	description: "Bulk update positions for idea groups.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ReorderIdeaGroupsBody } },
		},
	},
	responses: {
		200: {
			description: "Groups reordered",
			content: { "application/json": { schema: IdeaGroupListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(reorderGroups, async (c) => {
	const orgId = c.get("orgId");
	const { groups } = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Update each group's position
	for (const { id, position } of groups) {
		await db
			.update(ideaGroups)
			.set({ position, updatedAt: new Date() })
			.where(
				and(eq(ideaGroups.id, id), eq(ideaGroups.organizationId, orgId)),
			);
	}

	// Return the full updated list
	const conditions = [eq(ideaGroups.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, ideaGroups.workspaceId);

	const rows = await db
		.select()
		.from(ideaGroups)
		.where(and(...conditions))
		.orderBy(asc(ideaGroups.position));

	return c.json({ data: rows.map(serialize) }, 200);
});

export { ensureDefaultGroup };
export default app;
```

- [ ] **Step 3: Register the idea-groups route in index.ts**

In `apps/api/src/index.ts`, add:

```typescript
import ideaGroupsRouter from "./routes/idea-groups";
// ...
app.route("/v1/idea-groups", ideaGroupsRouter);
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/schemas/idea-groups.ts apps/api/src/routes/idea-groups.ts apps/api/src/index.ts
git commit -m "feat: add idea groups (kanban columns) CRUD and reorder endpoints"
```

---

## Task 5: Ideas — Schemas

**Files:**
- Create: `apps/api/src/schemas/ideas.ts`

- [ ] **Step 1: Create the ideas schema file**

Create `apps/api/src/schemas/ideas.ts`:

```typescript
import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";
import { TagResponse } from "./tags";

// ── Idea Media ───────────────────────────────────────────────────────────────

export const IdeaMediaResponse = z.object({
	id: z.string().describe("Media ID"),
	url: z.string().describe("Media URL"),
	type: z
		.enum(["image", "video", "gif", "document"])
		.describe("Media type"),
	alt: z.string().nullable().describe("Alt text"),
	position: z.number().int().describe("Ordering position"),
});

// ── Idea Response ────────────────────────────────────────────────────────────

export const IdeaResponse = z.object({
	id: z.string().describe("Idea ID"),
	title: z.string().nullable().describe("Short title"),
	content: z.string().nullable().describe("Content/copy"),
	group_id: z.string().describe("Idea group (kanban column) ID"),
	position: z.number().describe("Position within group"),
	assigned_to: z.string().nullable().describe("Assigned user ID"),
	converted_to_post_id: z
		.string()
		.nullable()
		.describe("Post ID if converted (most recent)"),
	tags: z.array(TagResponse).describe("Associated tags"),
	media: z.array(IdeaMediaResponse).describe("Attached media"),
	workspace_id: z.string().nullable().describe("Workspace ID"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

// ── Create / Update ──────────────────────────────────────────────────────────

export const CreateIdeaBody = z
	.object({
		title: z.string().max(500).optional().describe("Short title"),
		content: z.string().max(10000).optional().describe("Content/copy"),
		group_id: z
			.string()
			.optional()
			.describe(
				"Idea group ID. If omitted, placed in the default 'Unassigned' group.",
			),
		tag_ids: z
			.array(z.string())
			.max(20)
			.optional()
			.describe("Tag IDs to associate"),
		assigned_to: z
			.string()
			.optional()
			.describe("User ID to assign this idea to"),
		workspace_id: z
			.string()
			.optional()
			.describe("Workspace ID to scope this idea to"),
	})
	.describe("Create an idea");

export const UpdateIdeaBody = z
	.object({
		title: z
			.string()
			.max(500)
			.nullable()
			.optional()
			.describe("Short title"),
		content: z
			.string()
			.max(10000)
			.nullable()
			.optional()
			.describe("Content/copy"),
		assigned_to: z
			.string()
			.nullable()
			.optional()
			.describe("User ID to assign"),
		tag_ids: z
			.array(z.string())
			.max(20)
			.optional()
			.describe("Replace all tag associations"),
	})
	.describe("Update an idea");

// ── Move ─────────────────────────────────────────────────────────────────────

export const MoveIdeaBody = z
	.object({
		group_id: z
			.string()
			.optional()
			.describe("Target group ID. Omit to reorder within current group."),
		position: z
			.number()
			.optional()
			.describe("Target position (float). Omit to place at end."),
		after_idea_id: z
			.string()
			.optional()
			.describe(
				"Place after this idea. Takes precedence over position.",
			),
	})
	.describe("Move an idea to a different group or position");

// ── Convert ──────────────────────────────────────────────────────────────────

export const ConvertIdeaBody = z
	.object({
		targets: z
			.array(
				z.object({
					account_id: z.string().describe("Social account ID"),
				}),
			)
			.min(1)
			.describe("Target social accounts"),
		scheduled_at: z
			.string()
			.optional()
			.describe(
				'When to publish: ISO 8601 timestamp, "now", "draft", or "auto"',
			),
		timezone: z
			.string()
			.optional()
			.describe("IANA timezone for scheduling"),
		content: z
			.string()
			.optional()
			.describe("Override the idea content for the post"),
	})
	.describe(
		"Convert an idea to a post. Content and media are pre-filled from the idea.",
	);

// ── List Query ───────────────────────────────────────────────────────────────

export const IdeaListQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Items per page"),
	group_id: z.string().optional().describe("Filter by idea group"),
	tag_id: z.string().optional().describe("Filter by tag"),
	assigned_to: z.string().optional().describe("Filter by assigned user"),
	workspace_id: z.string().optional().describe("Filter by workspace"),
});

export const IdeaListResponse = paginatedResponse(IdeaResponse);

// ── Activity ─────────────────────────────────────────────────────────────────

export const IdeaActivityResponse = z.object({
	id: z.string().describe("Activity ID"),
	actor_id: z.string().describe("User who performed the action"),
	action: z
		.enum([
			"created",
			"moved",
			"assigned",
			"commented",
			"converted",
			"updated",
			"media_added",
			"media_removed",
			"tagged",
			"untagged",
		])
		.describe("Action type"),
	metadata: z
		.record(z.string(), z.unknown())
		.nullable()
		.describe("Action context"),
	created_at: z.string().datetime().describe("When the action occurred"),
});

export const IdeaActivityListQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Items per page"),
});

export const IdeaActivityListResponse = paginatedResponse(
	IdeaActivityResponse,
);

// ── Comments ─────────────────────────────────────────────────────────────────

export const IdeaCommentResponse = z.object({
	id: z.string().describe("Comment ID"),
	author_id: z.string().describe("Author user ID"),
	content: z.string().describe("Comment body"),
	parent_id: z.string().nullable().describe("Parent comment ID (for replies)"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

export const CreateIdeaCommentBody = z
	.object({
		content: z.string().min(1).max(5000).describe("Comment body"),
		parent_id: z
			.string()
			.optional()
			.describe("Parent comment ID to reply to"),
	})
	.describe("Add a comment to an idea");

export const UpdateIdeaCommentBody = z
	.object({
		content: z.string().min(1).max(5000).describe("Comment body"),
	})
	.describe("Edit a comment");

export const IdeaCommentListQuery = z.object({
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Items per page"),
});

export const IdeaCommentListResponse = paginatedResponse(
	IdeaCommentResponse,
);
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/schemas/ideas.ts
git commit -m "feat: add Zod-OpenAPI schemas for ideas, comments, activity, and conversion"
```

---

## Task 6: Ideas — Core CRUD Routes

**Files:**
- Create: `apps/api/src/routes/ideas.ts`
- Modify: `apps/api/src/index.ts` (register route)

- [ ] **Step 1: Create the ideas route file with helpers and CRUD**

Create `apps/api/src/routes/ideas.ts`:

```typescript
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	createDb,
	ideas,
	ideaGroups,
	ideaMedia,
	ideaTags,
	ideaComments,
	ideaActivity,
	tags,
	posts,
} from "@relayapi/db";
import { and, asc, desc, eq, inArray, lt, max, sql } from "drizzle-orm";
import { ErrorResponse, IdParam } from "../schemas/common";
import {
	CreateIdeaBody,
	UpdateIdeaBody,
	MoveIdeaBody,
	ConvertIdeaBody,
	IdeaResponse,
	IdeaListQuery,
	IdeaListResponse,
	IdeaMediaResponse,
	IdeaActivityResponse,
	IdeaActivityListQuery,
	IdeaActivityListResponse,
	IdeaCommentResponse,
	CreateIdeaCommentBody,
	UpdateIdeaCommentBody,
	IdeaCommentListQuery,
	IdeaCommentListResponse,
} from "../schemas/ideas";
import { TagResponse } from "../schemas/tags";
import type { Env, Variables } from "../types";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import { assertScopedCreateWorkspace } from "../lib/request-access";
import { ensureDefaultGroup } from "./idea-groups";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ── Helpers ──────────────────────────────────────────────────────────────────

type IdeaRow = typeof ideas.$inferSelect;
type TagRow = typeof tags.$inferSelect;
type MediaRow = typeof ideaMedia.$inferSelect;

function serializeTag(row: TagRow) {
	return {
		id: row.id,
		name: row.name,
		color: row.color,
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
	};
}

function serializeMedia(row: MediaRow) {
	return {
		id: row.id,
		url: row.url,
		type: row.type,
		alt: row.alt ?? null,
		position: row.position,
	};
}

function serializeIdea(
	row: IdeaRow,
	ideaTagRows: TagRow[],
	mediaRows: MediaRow[],
) {
	return {
		id: row.id,
		title: row.title ?? null,
		content: row.content ?? null,
		group_id: row.groupId,
		position: row.position,
		assigned_to: row.assignedTo ?? null,
		converted_to_post_id: row.convertedToPostId ?? null,
		tags: ideaTagRows.map(serializeTag),
		media: mediaRows.map(serializeMedia),
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

async function fetchIdeaTags(
	db: ReturnType<typeof createDb>,
	ideaId: string,
): Promise<TagRow[]> {
	const rows = await db
		.select({ tag: tags })
		.from(ideaTags)
		.innerJoin(tags, eq(ideaTags.tagId, tags.id))
		.where(eq(ideaTags.ideaId, ideaId));
	return rows.map((r) => r.tag);
}

async function fetchIdeaMedia(
	db: ReturnType<typeof createDb>,
	ideaId: string,
): Promise<MediaRow[]> {
	return db
		.select()
		.from(ideaMedia)
		.where(eq(ideaMedia.ideaId, ideaId))
		.orderBy(asc(ideaMedia.position));
}

async function logActivity(
	db: ReturnType<typeof createDb>,
	ideaId: string,
	actorId: string,
	action: (typeof ideaActivity.$inferInsert)["action"],
	metadata?: Record<string, unknown>,
) {
	await db.insert(ideaActivity).values({
		ideaId,
		actorId,
		action,
		metadata: metadata ?? null,
	});
}

// ── List ideas ───────────────────────────────────────────────────────────────

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
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const conditions = [eq(ideas.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, ideas.workspaceId);
	if (workspace_id) conditions.push(eq(ideas.workspaceId, workspace_id));
	if (group_id) conditions.push(eq(ideas.groupId, group_id));
	if (assigned_to) conditions.push(eq(ideas.assignedTo, assigned_to));
	if (cursor) conditions.push(lt(ideas.createdAt, new Date(cursor)));

	// If filtering by tag, join through idea_tags
	let rows: IdeaRow[];
	if (tag_id) {
		const result = await db
			.select({ idea: ideas })
			.from(ideas)
			.innerJoin(ideaTags, eq(ideas.id, ideaTags.ideaId))
			.where(and(...conditions, eq(ideaTags.tagId, tag_id)))
			.orderBy(desc(ideas.createdAt))
			.limit(limit + 1);
		rows = result.map((r) => r.idea);
	} else {
		rows = await db
			.select()
			.from(ideas)
			.where(and(...conditions))
			.orderBy(desc(ideas.createdAt))
			.limit(limit + 1);
	}

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	// Batch fetch tags and media for all ideas
	const ideaIds = data.map((r) => r.id);
	let allTags: { ideaId: string; tag: TagRow }[] = [];
	let allMedia: MediaRow[] = [];

	if (ideaIds.length > 0) {
		const tagRows = await db
			.select({ ideaId: ideaTags.ideaId, tag: tags })
			.from(ideaTags)
			.innerJoin(tags, eq(ideaTags.tagId, tags.id))
			.where(inArray(ideaTags.ideaId, ideaIds));
		allTags = tagRows.map((r) => ({
			ideaId: r.ideaId,
			tag: r.tag,
		}));

		allMedia = await db
			.select()
			.from(ideaMedia)
			.where(inArray(ideaMedia.ideaId, ideaIds))
			.orderBy(asc(ideaMedia.position));
	}

	const serialized = data.map((row) =>
		serializeIdea(
			row,
			allTags.filter((t) => t.ideaId === row.id).map((t) => t.tag),
			allMedia.filter((m) => m.ideaId === row.id),
		),
	);

	return c.json(
		{
			data: serialized,
			next_cursor: hasMore
				? (data.at(-1)?.createdAt.toISOString() ?? null)
				: null,
			has_more: hasMore,
		},
		200,
	);
});

// ── Get idea ─────────────────────────────────────────────────────────────────

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
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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

	const [ideaTagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id),
		fetchIdeaMedia(db, id),
	]);

	return c.json(serializeIdea(row, ideaTagRows, mediaRows), 200);
});

// ── Create idea ──────────────────────────────────────────────────────────────

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
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createIdea, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "idea");
	if (denied) return denied;

	// Resolve group ID — use provided or default
	let groupId = body.group_id;
	if (!groupId) {
		groupId = await ensureDefaultGroup(
			db,
			orgId,
			body.workspace_id ?? null,
		);
	}

	// Place at end of group
	const [posResult] = await db
		.select({ maxPos: max(ideas.position) })
		.from(ideas)
		.where(eq(ideas.groupId, groupId));
	const position = (posResult?.maxPos ?? 0) + 1;

	const [row] = await db
		.insert(ideas)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			title: body.title ?? null,
			content: body.content ?? null,
			groupId,
			position,
			assignedTo: body.assigned_to ?? null,
		})
		.returning();

	if (!row) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create idea",
				},
			} as never,
			500 as never,
		);
	}

	// Associate tags
	if (body.tag_ids?.length) {
		await db.insert(ideaTags).values(
			body.tag_ids.map((tagId) => ({
				ideaId: row.id,
				tagId,
			})),
		);
	}

	// Log activity
	await logActivity(db, row.id, c.get("keyId"), "created");

	const [ideaTagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, row.id),
		fetchIdeaMedia(db, row.id),
	]);

	return c.json(serializeIdea(row, ideaTagRows, mediaRows), 201);
});

// ── Update idea ──────────────────────────────────────────────────────────────

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
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateIdea, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select()
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

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.title !== undefined) updates.title = body.title;
	if (body.content !== undefined) updates.content = body.content;
	if (body.assigned_to !== undefined) {
		updates.assignedTo = body.assigned_to;
		if (body.assigned_to !== existing.assignedTo) {
			await logActivity(db, id, c.get("keyId"), "assigned", {
				assigned_to: body.assigned_to,
				previous: existing.assignedTo,
			});
		}
	}

	const [updated] = await db
		.update(ideas)
		.set(updates)
		.where(eq(ideas.id, id))
		.returning();

	// Replace tags if provided
	if (body.tag_ids !== undefined) {
		await db.delete(ideaTags).where(eq(ideaTags.ideaId, id));
		if (body.tag_ids.length > 0) {
			await db.insert(ideaTags).values(
				body.tag_ids.map((tagId) => ({
					ideaId: id,
					tagId,
				})),
			);
		}
	}

	await logActivity(db, id, c.get("keyId"), "updated");

	const [ideaTagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id),
		fetchIdeaMedia(db, id),
	]);

	return c.json(
		serializeIdea(updated ?? existing, ideaTagRows, mediaRows),
		200,
	);
});

// ── Delete idea ──────────────────────────────────────────────────────────────

const deleteIdea = createRoute({
	operationId: "deleteIdea",
	method: "delete",
	path: "/{id}",
	tags: ["Ideas"],
	summary: "Delete an idea",
	description:
		"Deletes an idea and all associated media, comments, tags, and activity.",
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
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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

	// Cascade deletes handle idea_media, idea_tags, idea_comments, idea_activity
	await db.delete(ideas).where(eq(ideas.id, id));

	return c.body(null, 204);
});

export { logActivity, fetchIdeaTags, fetchIdeaMedia, serializeIdea };
export default app;
```

- [ ] **Step 2: Register the ideas route in index.ts**

In `apps/api/src/index.ts`, add:

```typescript
import ideasRouter from "./routes/ideas";
// ...
app.route("/v1/ideas", ideasRouter);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/schemas/ideas.ts apps/api/src/routes/ideas.ts apps/api/src/index.ts
git commit -m "feat: add ideas CRUD endpoints with tags and media support"
```

---

## Task 7: Ideas — Move, Convert, Media, Comments, and Activity Routes

This task adds the remaining endpoints to the ideas route file.

**Files:**
- Modify: `apps/api/src/routes/ideas.ts`

- [ ] **Step 1: Add the Move endpoint**

Add after the delete handler in `apps/api/src/routes/ideas.ts`:

```typescript
// ── Move idea ────────────────────────────────────────────────────────────────

const moveIdea = createRoute({
	operationId: "moveIdea",
	method: "post",
	path: "/{id}/move",
	tags: ["Ideas"],
	summary: "Move an idea",
	description:
		"Move an idea to a different group and/or reposition it within a group.",
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
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(moveIdea, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select()
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

	const targetGroupId = body.group_id ?? existing.groupId;
	let targetPosition: number;

	if (body.after_idea_id) {
		// Place after a specific idea
		const [afterIdea] = await db
			.select({ position: ideas.position })
			.from(ideas)
			.where(eq(ideas.id, body.after_idea_id))
			.limit(1);

		if (!afterIdea) {
			return c.json(
				{
					error: {
						code: "idea_not_found",
						message: "after_idea_id not found",
					},
				},
				404,
			);
		}

		// Find the next idea after the target position
		const [nextIdea] = await db
			.select({ position: ideas.position })
			.from(ideas)
			.where(
				and(
					eq(ideas.groupId, targetGroupId),
					sql`${ideas.position} > ${afterIdea.position}`,
					sql`${ideas.id} != ${id}`,
				),
			)
			.orderBy(asc(ideas.position))
			.limit(1);

		targetPosition = nextIdea
			? (afterIdea.position + nextIdea.position) / 2
			: afterIdea.position + 1;
	} else if (body.position !== undefined) {
		targetPosition = body.position;
	} else {
		// Place at end
		const [posResult] = await db
			.select({ maxPos: max(ideas.position) })
			.from(ideas)
			.where(
				and(
					eq(ideas.groupId, targetGroupId),
					sql`${ideas.id} != ${id}`,
				),
			);
		targetPosition = (posResult?.maxPos ?? 0) + 1;
	}

	const fromGroup = existing.groupId;
	const [updated] = await db
		.update(ideas)
		.set({
			groupId: targetGroupId,
			position: targetPosition,
			updatedAt: new Date(),
		})
		.where(eq(ideas.id, id))
		.returning();

	await logActivity(db, id, c.get("keyId"), "moved", {
		from_group: fromGroup,
		to_group: targetGroupId,
		position: targetPosition,
	});

	const [ideaTagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id),
		fetchIdeaMedia(db, id),
	]);

	return c.json(
		serializeIdea(updated ?? existing, ideaTagRows, mediaRows),
		200,
	);
});
```

- [ ] **Step 2: Add the Convert endpoint**

```typescript
// ── Convert idea to post ─────────────────────────────────────────────────────

const convertIdea = createRoute({
	operationId: "convertIdea",
	method: "post",
	path: "/{id}/convert",
	tags: ["Ideas"],
	summary: "Convert an idea to a post",
	description:
		"Creates a post pre-filled with the idea's content and media. The idea remains on the board with a reference to the created post. Multiple conversions are allowed.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: ConvertIdeaBody } },
		},
	},
	responses: {
		201: {
			description: "Post created from idea",
			content: {
				"application/json": {
					schema: z.object({
						idea: IdeaResponse,
						post_id: z.string().describe("Created post ID"),
					}),
				},
			},
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(convertIdea, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select()
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

	// Use provided content or fall back to idea content
	const postContent = body.content ?? existing.content ?? "";

	// Determine scheduled_at — default to "draft"
	const scheduledAt = body.scheduled_at ?? "draft";

	// NOTE: This is a minimal implementation that creates a draft post
	// record. For production, extract the post creation logic from
	// apps/api/src/routes/posts.ts into a shared service so that
	// /convert can reuse the full validation (targets, queue, scheduling).
	// The direct insert below works for the initial implementation and
	// can be refactored once the service layer is extracted.
	const [post] = await db
		.insert(posts)
		.values({
			organizationId: orgId,
			workspaceId: existing.workspaceId,
			content: postContent,
			status: scheduledAt === "draft" ? "draft" : "scheduled",
			scheduledAt:
				scheduledAt !== "draft" && scheduledAt !== "now" && scheduledAt !== "auto"
					? new Date(scheduledAt)
					: null,
			timezone: body.timezone ?? null,
		})
		.returning();

	if (!post) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create post from idea",
				},
			} as never,
			500 as never,
		);
	}

	// Update idea with conversion reference
	const [updatedIdea] = await db
		.update(ideas)
		.set({ convertedToPostId: post.id, updatedAt: new Date() })
		.where(eq(ideas.id, id))
		.returning();

	await logActivity(db, id, c.get("keyId"), "converted", {
		post_id: post.id,
	});

	const [ideaTagRows, mediaRows] = await Promise.all([
		fetchIdeaTags(db, id),
		fetchIdeaMedia(db, id),
	]);

	return c.json(
		{
			idea: serializeIdea(
				updatedIdea ?? existing,
				ideaTagRows,
				mediaRows,
			),
			post_id: post.id,
		},
		201,
	);
});
```

- [ ] **Step 3: Add Media upload and delete endpoints**

```typescript
// ── Upload idea media ────────────────────────────────────────────────────────

const uploadIdeaMedia = createRoute({
	operationId: "uploadIdeaMedia",
	method: "post",
	path: "/{id}/media",
	tags: ["Ideas"],
	summary: "Upload media to an idea",
	description: "Max file size: 2MB. Supported types: image, video, gif, document.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: {
				"multipart/form-data": {
					schema: z.object({
						file: z.any().describe("Media file (max 2MB)"),
						alt: z.string().optional().describe("Alt text"),
						type: z
							.enum(["image", "video", "gif", "document"])
							.describe("Media type"),
					}),
				},
			},
		},
	},
	responses: {
		201: {
			description: "Media uploaded",
			content: {
				"application/json": { schema: IdeaMediaResponse },
			},
		},
		400: {
			description: "File too large or invalid",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(uploadIdeaMedia, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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

	const formData = await c.req.formData();
	const file = formData.get("file") as File | null;
	const alt = formData.get("alt") as string | null;
	const type = formData.get("type") as string;

	if (!file) {
		return c.json(
			{ error: { code: "missing_file", message: "No file provided" } },
			400,
		);
	}

	// Enforce 2MB limit
	const MAX_SIZE = 2 * 1024 * 1024; // 2MB
	if (file.size > MAX_SIZE) {
		return c.json(
			{
				error: {
					code: "media_too_large",
					message: "File exceeds 2MB limit",
				},
			},
			400,
		);
	}

	// Upload to R2
	const storageKey = `ideas/${id}/${crypto.randomUUID()}-${file.name}`;
	await c.env.MEDIA_BUCKET.put(storageKey, file.stream(), {
		httpMetadata: { contentType: file.type },
	});

	// Determine next position
	const [posResult] = await db
		.select({ maxPos: max(ideaMedia.position) })
		.from(ideaMedia)
		.where(eq(ideaMedia.ideaId, id));
	const position = (posResult?.maxPos ?? -1) + 1;

	const url = `https://media.relayapi.dev/${storageKey}`;

	const [row] = await db
		.insert(ideaMedia)
		.values({
			ideaId: id,
			url,
			type: type as "image" | "video" | "gif" | "document",
			alt: alt ?? null,
			position,
		})
		.returning();

	await logActivity(db, id, c.get("keyId"), "media_added", {
		media_id: row!.id,
	});

	return c.json(serializeMedia(row!), 201);
});

// ── Delete idea media ────────────────────────────────────────────────────────

const IdeaMediaParams = z.object({
	id: z.string().describe("Idea ID"),
	media_id: z.string().describe("Media ID"),
});

const deleteIdeaMedia = createRoute({
	operationId: "deleteIdeaMedia",
	method: "delete",
	path: "/{id}/media/{media_id}",
	tags: ["Ideas"],
	summary: "Delete media from an idea",
	security: [{ Bearer: [] }],
	request: { params: IdeaMediaParams },
	responses: {
		204: { description: "Media deleted" },
		404: {
			description: "Idea or media not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteIdeaMedia, async (c) => {
	const orgId = c.get("orgId");
	const { id, media_id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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

	const [mediaRow] = await db
		.select()
		.from(ideaMedia)
		.where(
			and(eq(ideaMedia.id, media_id), eq(ideaMedia.ideaId, id)),
		)
		.limit(1);

	if (!mediaRow) {
		return c.json(
			{
				error: { code: "media_not_found", message: "Media not found" },
			},
			404,
		);
	}

	// Delete from R2
	const storageKey = mediaRow.url.replace("https://media.relayapi.dev/", "");
	await c.env.MEDIA_BUCKET.delete(storageKey);

	await db.delete(ideaMedia).where(eq(ideaMedia.id, media_id));

	await logActivity(db, id, c.get("keyId"), "media_removed", {
		media_id,
	});

	return c.body(null, 204);
});
```

- [ ] **Step 4: Add Comments endpoints**

```typescript
// ── List comments ────────────────────────────────────────────────────────────

const IdeaIdParam = z.object({
	id: z.string().describe("Idea ID"),
});

const listComments = createRoute({
	operationId: "listIdeaComments",
	method: "get",
	path: "/{id}/comments",
	tags: ["Ideas"],
	summary: "List comments on an idea",
	security: [{ Bearer: [] }],
	request: {
		params: IdeaIdParam,
		query: IdeaCommentListQuery,
	},
	responses: {
		200: {
			description: "List of comments",
			content: {
				"application/json": { schema: IdeaCommentListResponse },
			},
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
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	// Verify idea exists and is accessible
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

	const conditions = [eq(ideaComments.ideaId, id)];
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

	return c.json(
		{
			data: data.map((row) => ({
				id: row.id,
				author_id: row.authorId,
				content: row.content,
				parent_id: row.parentId ?? null,
				created_at: row.createdAt.toISOString(),
				updated_at: row.updatedAt.toISOString(),
			})),
			next_cursor: hasMore
				? (data.at(-1)?.createdAt.toISOString() ?? null)
				: null,
			has_more: hasMore,
		},
		200,
	);
});

// ── Create comment ───────────────────────────────────────────────────────────

const createComment = createRoute({
	operationId: "createIdeaComment",
	method: "post",
	path: "/{id}/comments",
	tags: ["Ideas"],
	summary: "Add a comment to an idea",
	security: [{ Bearer: [] }],
	request: {
		params: IdeaIdParam,
		body: {
			content: {
				"application/json": { schema: CreateIdeaCommentBody },
			},
		},
	},
	responses: {
		201: {
			description: "Comment created",
			content: {
				"application/json": { schema: IdeaCommentResponse },
			},
		},
		404: {
			description: "Idea not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createComment, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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

	// Validate parent_id exists and belongs to same idea (one level only)
	if (body.parent_id) {
		const [parent] = await db
			.select({ id: ideaComments.id, parentId: ideaComments.parentId })
			.from(ideaComments)
			.where(
				and(
					eq(ideaComments.id, body.parent_id),
					eq(ideaComments.ideaId, id),
				),
			)
			.limit(1);

		if (!parent) {
			return c.json(
				{
					error: {
						code: "comment_not_found",
						message: "Parent comment not found",
					},
				},
				404,
			);
		}

		// Enforce one level of threading
		if (parent.parentId) {
			return c.json(
				{
					error: {
						code: "nested_reply_not_allowed",
						message:
							"Replies to replies are not supported. Reply to the top-level comment instead.",
					},
				},
				400,
			);
		}
	}

	const [row] = await db
		.insert(ideaComments)
		.values({
			ideaId: id,
			authorId: c.get("keyId"),
			content: body.content,
			parentId: body.parent_id ?? null,
		})
		.returning();

	await logActivity(db, id, c.get("keyId"), "commented", {
		comment_id: row!.id,
	});

	return c.json(
		{
			id: row!.id,
			author_id: row!.authorId,
			content: row!.content,
			parent_id: row!.parentId ?? null,
			created_at: row!.createdAt.toISOString(),
			updated_at: row!.updatedAt.toISOString(),
		},
		201,
	);
});

// ── Update comment ───────────────────────────────────────────────────────────

const IdeaCommentParams = z.object({
	id: z.string().describe("Idea ID"),
	comment_id: z.string().describe("Comment ID"),
});

const updateComment = createRoute({
	operationId: "updateIdeaComment",
	method: "patch",
	path: "/{id}/comments/{comment_id}",
	tags: ["Ideas"],
	summary: "Edit a comment",
	description: "You can only edit your own comments.",
	security: [{ Bearer: [] }],
	request: {
		params: IdeaCommentParams,
		body: {
			content: {
				"application/json": { schema: UpdateIdeaCommentBody },
			},
		},
	},
	responses: {
		200: {
			description: "Comment updated",
			content: {
				"application/json": { schema: IdeaCommentResponse },
			},
		},
		403: {
			description: "Cannot edit another user's comment",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Comment not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateComment, async (c) => {
	const orgId = c.get("orgId");
	const { id, comment_id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [comment] = await db
		.select()
		.from(ideaComments)
		.where(
			and(
				eq(ideaComments.id, comment_id),
				eq(ideaComments.ideaId, id),
			),
		)
		.limit(1);

	if (!comment) {
		return c.json(
			{
				error: {
					code: "comment_not_found",
					message: "Comment not found",
				},
			},
			404,
		);
	}

	if (comment.authorId !== c.get("keyId")) {
		return c.json(
			{
				error: {
					code: "forbidden",
					message: "You can only edit your own comments",
				},
			},
			403,
		);
	}

	const [updated] = await db
		.update(ideaComments)
		.set({ content: body.content, updatedAt: new Date() })
		.where(eq(ideaComments.id, comment_id))
		.returning();

	return c.json(
		{
			id: updated!.id,
			author_id: updated!.authorId,
			content: updated!.content,
			parent_id: updated!.parentId ?? null,
			created_at: updated!.createdAt.toISOString(),
			updated_at: updated!.updatedAt.toISOString(),
		},
		200,
	);
});

// ── Delete comment ───────────────────────────────────────────────────────────

const deleteComment = createRoute({
	operationId: "deleteIdeaComment",
	method: "delete",
	path: "/{id}/comments/{comment_id}",
	tags: ["Ideas"],
	summary: "Delete a comment",
	description: "You can only delete your own comments.",
	security: [{ Bearer: [] }],
	request: { params: IdeaCommentParams },
	responses: {
		204: { description: "Comment deleted" },
		403: {
			description: "Cannot delete another user's comment",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Comment not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteComment, async (c) => {
	const orgId = c.get("orgId");
	const { id, comment_id } = c.req.valid("param");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [comment] = await db
		.select({
			id: ideaComments.id,
			authorId: ideaComments.authorId,
		})
		.from(ideaComments)
		.where(
			and(
				eq(ideaComments.id, comment_id),
				eq(ideaComments.ideaId, id),
			),
		)
		.limit(1);

	if (!comment) {
		return c.json(
			{
				error: {
					code: "comment_not_found",
					message: "Comment not found",
				},
			},
			404,
		);
	}

	if (comment.authorId !== c.get("keyId")) {
		return c.json(
			{
				error: {
					code: "forbidden",
					message: "You can only delete your own comments",
				},
			},
			403,
		);
	}

	// Cascade deletes child replies via FK onDelete
	await db.delete(ideaComments).where(eq(ideaComments.id, comment_id));

	return c.body(null, 204);
});
```

- [ ] **Step 5: Add the Activity endpoint**

```typescript
// ── List activity ────────────────────────────────────────────────────────────

const listActivity = createRoute({
	operationId: "listIdeaActivity",
	method: "get",
	path: "/{id}/activity",
	tags: ["Ideas"],
	summary: "Get idea activity log",
	security: [{ Bearer: [] }],
	request: {
		params: IdeaIdParam,
		query: IdeaActivityListQuery,
	},
	responses: {
		200: {
			description: "Activity log",
			content: {
				"application/json": { schema: IdeaActivityListResponse },
			},
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
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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

	const conditions = [eq(ideaActivity.ideaId, id)];
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

	return c.json(
		{
			data: data.map((row) => ({
				id: row.id,
				actor_id: row.actorId,
				action: row.action,
				metadata: (row.metadata as Record<string, unknown>) ?? null,
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
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/ideas.ts
git commit -m "feat: add idea move, convert, media, comments, and activity endpoints"
```

---

## Task 8: Add `idea_id` to Post Creation

Wire up the `idea_id` field on `POST /v1/posts` so API consumers can convert ideas via the standard post creation endpoint.

**Files:**
- Modify: `apps/api/src/schemas/posts.ts`
- Modify: `apps/api/src/routes/posts.ts`

- [ ] **Step 1: Add `idea_id` to CreatePostBody schema**

In `apps/api/src/schemas/posts.ts`, add to the `CreatePostBody` object:

```typescript
idea_id: z
    .string()
    .optional()
    .describe("Create post from an idea. Pre-fills content and media from the idea."),
```

- [ ] **Step 2: Handle `idea_id` in the create post handler**

In `apps/api/src/routes/posts.ts`, inside the create post handler, after parsing the body and before inserting the post, add logic to fetch the idea and pre-fill:

```typescript
// If creating from an idea, pre-fill content
let ideaSource: { id: string; content: string | null; workspaceId: string | null } | null = null;
if (body.idea_id) {
    const [idea] = await db
        .select({ id: ideas.id, content: ideas.content, workspaceId: ideas.workspaceId })
        .from(ideas)
        .where(and(eq(ideas.id, body.idea_id), eq(ideas.organizationId, orgId)))
        .limit(1);
    if (!idea) {
        return c.json(
            { error: { code: "idea_not_found", message: "Idea not found" } },
            404,
        );
    }
    ideaSource = idea;
}

// Use idea content as fallback
const content = body.content ?? ideaSource?.content ?? "";
```

Then after the post is created successfully, update the idea:

```typescript
if (ideaSource) {
    await db
        .update(ideas)
        .set({ convertedToPostId: post.id, updatedAt: new Date() })
        .where(eq(ideas.id, ideaSource.id));

    // Log activity on the idea
    await db.insert(ideaActivity).values({
        ideaId: ideaSource.id,
        actorId: c.get("keyId"),
        action: "converted",
        metadata: { post_id: post.id },
    });
}
```

- [ ] **Step 3: Add the `ideas` and `ideaActivity` imports to posts.ts**

```typescript
import { ideas, ideaActivity } from "@relayapi/db";
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/schemas/posts.ts apps/api/src/routes/posts.ts
git commit -m "feat: add idea_id support to post creation for idea-to-post conversion"
```

---

## Task 9: SDK Resources

The SDK is auto-generated by Stainless from the OpenAPI spec (`// File generated from our OpenAPI spec by Stainless`). However, per project conventions, SDK updates should be made alongside API changes.

**Files:**
- Create: `packages/sdk/src/resources/ideas/ideas.ts`
- Create: `packages/sdk/src/resources/ideas/comments.ts`
- Create: `packages/sdk/src/resources/ideas/media.ts`
- Create: `packages/sdk/src/resources/ideas/activity.ts`
- Create: `packages/sdk/src/resources/ideas/index.ts`
- Create: `packages/sdk/src/resources/idea-groups.ts`
- Create: `packages/sdk/src/resources/tags.ts`
- Modify: `packages/sdk/src/resources/index.ts`
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/src/resources/posts/posts.ts` (add `idea_id` to create params)

- [ ] **Step 1: Create `packages/sdk/src/resources/tags.ts`**

```typescript
import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Tags extends APIResource {
  create(body: TagCreateParams, options?: RequestOptions): APIPromise<TagCreateResponse> {
    return this._client.post('/v1/tags', { body, ...options });
  }

  update(
    id: string,
    body: TagUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<TagUpdateResponse> {
    return this._client.patch(path`/v1/tags/${id}`, { body, ...options });
  }

  list(
    query: TagListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<TagListResponse> {
    return this._client.get('/v1/tags', { query, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/tags/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface TagCreateResponse {
  id: string;
  name: string;
  color: string;
  workspace_id: string | null;
  created_at: string;
}

export type TagUpdateResponse = TagCreateResponse;
export type TagGetResponse = TagCreateResponse;

export interface TagListResponse {
  data: Array<TagCreateResponse>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface TagCreateParams {
  name: string;
  color: string;
  workspace_id?: string;
}

export interface TagUpdateParams {
  name?: string;
  color?: string;
}

export interface TagListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
}
```

- [ ] **Step 2: Create `packages/sdk/src/resources/idea-groups.ts`**

```typescript
import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class IdeaGroups extends APIResource {
  create(
    body: IdeaGroupCreateParams,
    options?: RequestOptions,
  ): APIPromise<IdeaGroupCreateResponse> {
    return this._client.post('/v1/idea-groups', { body, ...options });
  }

  update(
    id: string,
    body: IdeaGroupUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IdeaGroupUpdateResponse> {
    return this._client.patch(path`/v1/idea-groups/${id}`, { body, ...options });
  }

  list(
    query: IdeaGroupListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IdeaGroupListResponse> {
    return this._client.get('/v1/idea-groups', { query, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/idea-groups/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  reorder(
    body: IdeaGroupReorderParams,
    options?: RequestOptions,
  ): APIPromise<IdeaGroupListResponse> {
    return this._client.post('/v1/idea-groups/reorder', { body, ...options });
  }
}

export interface IdeaGroupResponse {
  id: string;
  name: string;
  position: number;
  color: string | null;
  is_default: boolean;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export type IdeaGroupCreateResponse = IdeaGroupResponse;
export type IdeaGroupUpdateResponse = IdeaGroupResponse;

export interface IdeaGroupListResponse {
  data: Array<IdeaGroupResponse>;
}

export interface IdeaGroupCreateParams {
  name: string;
  color?: string;
  position?: number;
  workspace_id?: string;
}

export interface IdeaGroupUpdateParams {
  name?: string;
  color?: string | null;
}

export interface IdeaGroupListParams {
  workspace_id?: string;
}

export interface IdeaGroupReorderParams {
  groups: Array<{ id: string; position: number }>;
}
```

- [ ] **Step 3: Create `packages/sdk/src/resources/ideas/comments.ts`**

```typescript
import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Comments extends APIResource {
  create(
    ideaId: string,
    body: CommentCreateParams,
    options?: RequestOptions,
  ): APIPromise<CommentCreateResponse> {
    return this._client.post(path`/v1/ideas/${ideaId}/comments`, { body, ...options });
  }

  update(
    ideaId: string,
    commentId: string,
    body: CommentUpdateParams,
    options?: RequestOptions,
  ): APIPromise<CommentUpdateResponse> {
    return this._client.patch(path`/v1/ideas/${ideaId}/comments/${commentId}`, {
      body,
      ...options,
    });
  }

  list(
    ideaId: string,
    query: CommentListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<CommentListResponse> {
    return this._client.get(path`/v1/ideas/${ideaId}/comments`, { query, ...options });
  }

  delete(ideaId: string, commentId: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ideas/${ideaId}/comments/${commentId}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface CommentResponse {
  id: string;
  author_id: string;
  content: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export type CommentCreateResponse = CommentResponse;
export type CommentUpdateResponse = CommentResponse;

export interface CommentListResponse {
  data: Array<CommentResponse>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface CommentCreateParams {
  content: string;
  parent_id?: string;
}

export interface CommentUpdateParams {
  content: string;
}

export interface CommentListParams {
  cursor?: string;
  limit?: number;
}
```

- [ ] **Step 4: Create `packages/sdk/src/resources/ideas/media.ts`**

```typescript
import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Media extends APIResource {
  upload(
    ideaId: string,
    body: MediaUploadParams,
    options?: RequestOptions,
  ): APIPromise<MediaUploadResponse> {
    return this._client.post(path`/v1/ideas/${ideaId}/media`, {
      body: toFormData(body),
      ...options,
    });
  }

  delete(ideaId: string, mediaId: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ideas/${ideaId}/media/${mediaId}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

function toFormData(params: MediaUploadParams): FormData {
  const fd = new FormData();
  fd.append('file', params.file);
  fd.append('type', params.type);
  if (params.alt) fd.append('alt', params.alt);
  return fd;
}

export interface MediaUploadResponse {
  id: string;
  url: string;
  type: 'image' | 'video' | 'gif' | 'document';
  alt: string | null;
  position: number;
}

export interface MediaUploadParams {
  file: Blob | File;
  type: 'image' | 'video' | 'gif' | 'document';
  alt?: string;
}
```

- [ ] **Step 5: Create `packages/sdk/src/resources/ideas/activity.ts`**

```typescript
import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Activity extends APIResource {
  list(
    ideaId: string,
    query: ActivityListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ActivityListResponse> {
    return this._client.get(path`/v1/ideas/${ideaId}/activity`, { query, ...options });
  }
}

export interface ActivityResponse {
  id: string;
  actor_id: string;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ActivityListResponse {
  data: Array<ActivityResponse>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface ActivityListParams {
  cursor?: string;
  limit?: number;
}
```

- [ ] **Step 6: Create `packages/sdk/src/resources/ideas/ideas.ts`**

```typescript
import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';
import * as CommentsAPI from './comments';
import { Comments, CommentCreateParams, CommentCreateResponse, CommentUpdateParams, CommentUpdateResponse, CommentListParams, CommentListResponse } from './comments';
import * as MediaAPI from './media';
import { Media, MediaUploadParams, MediaUploadResponse } from './media';
import * as ActivityAPI from './activity';
import { Activity, ActivityListParams, ActivityListResponse } from './activity';

export class Ideas extends APIResource {
  comments: CommentsAPI.Comments = new CommentsAPI.Comments(this._client);
  media: MediaAPI.Media = new MediaAPI.Media(this._client);
  activity: ActivityAPI.Activity = new ActivityAPI.Activity(this._client);

  create(body: IdeaCreateParams, options?: RequestOptions): APIPromise<IdeaCreateResponse> {
    return this._client.post('/v1/ideas', { body, ...options });
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<IdeaRetrieveResponse> {
    return this._client.get(path`/v1/ideas/${id}`, options);
  }

  update(
    id: string,
    body: IdeaUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IdeaUpdateResponse> {
    return this._client.patch(path`/v1/ideas/${id}`, { body, ...options });
  }

  list(
    query: IdeaListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<IdeaListResponse> {
    return this._client.get('/v1/ideas', { query, ...options });
  }

  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/ideas/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }

  move(id: string, body: IdeaMoveParams, options?: RequestOptions): APIPromise<IdeaMoveResponse> {
    return this._client.post(path`/v1/ideas/${id}/move`, { body, ...options });
  }

  convert(
    id: string,
    body: IdeaConvertParams,
    options?: RequestOptions,
  ): APIPromise<IdeaConvertResponse> {
    return this._client.post(path`/v1/ideas/${id}/convert`, { body, ...options });
  }
}

export interface IdeaResponse {
  id: string;
  title: string | null;
  content: string | null;
  group_id: string;
  position: number;
  assigned_to: string | null;
  converted_to_post_id: string | null;
  tags: Array<{ id: string; name: string; color: string; workspace_id: string | null; created_at: string }>;
  media: Array<{ id: string; url: string; type: string; alt: string | null; position: number }>;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

export type IdeaCreateResponse = IdeaResponse;
export type IdeaRetrieveResponse = IdeaResponse;
export type IdeaUpdateResponse = IdeaResponse;
export type IdeaMoveResponse = IdeaResponse;

export interface IdeaListResponse {
  data: Array<IdeaResponse>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface IdeaConvertResponse {
  idea: IdeaResponse;
  post_id: string;
}

export interface IdeaCreateParams {
  title?: string;
  content?: string;
  group_id?: string;
  tag_ids?: Array<string>;
  assigned_to?: string;
  workspace_id?: string;
}

export interface IdeaUpdateParams {
  title?: string | null;
  content?: string | null;
  assigned_to?: string | null;
  tag_ids?: Array<string>;
}

export interface IdeaListParams {
  cursor?: string;
  limit?: number;
  group_id?: string;
  tag_id?: string;
  assigned_to?: string;
  workspace_id?: string;
}

export interface IdeaMoveParams {
  group_id?: string;
  position?: number;
  after_idea_id?: string;
}

export interface IdeaConvertParams {
  targets: Array<{ account_id: string }>;
  scheduled_at?: string;
  timezone?: string;
  content?: string;
}

Ideas.Comments = Comments;
Ideas.Media = Media;
Ideas.Activity = Activity;

export declare namespace Ideas {
  export {
    Comments as Comments,
    type CommentCreateParams as CommentCreateParams,
    type CommentCreateResponse as CommentCreateResponse,
    type CommentUpdateParams as CommentUpdateParams,
    type CommentUpdateResponse as CommentUpdateResponse,
    type CommentListParams as CommentListParams,
    type CommentListResponse as CommentListResponse,
  };

  export {
    Media as Media,
    type MediaUploadParams as MediaUploadParams,
    type MediaUploadResponse as MediaUploadResponse,
  };

  export {
    Activity as Activity,
    type ActivityListParams as ActivityListParams,
    type ActivityListResponse as ActivityListResponse,
  };
}
```

- [ ] **Step 7: Create `packages/sdk/src/resources/ideas/index.ts`**

```typescript
export {
  Comments,
  type CommentResponse,
  type CommentCreateResponse,
  type CommentUpdateResponse,
  type CommentListResponse,
  type CommentCreateParams,
  type CommentUpdateParams,
  type CommentListParams,
} from './comments';
export {
  Media,
  type MediaUploadResponse,
  type MediaUploadParams,
} from './media';
export {
  Activity,
  type ActivityResponse,
  type ActivityListResponse,
  type ActivityListParams,
} from './activity';
export {
  Ideas,
  type IdeaResponse,
  type IdeaCreateResponse,
  type IdeaRetrieveResponse,
  type IdeaUpdateResponse,
  type IdeaMoveResponse,
  type IdeaListResponse,
  type IdeaConvertResponse,
  type IdeaCreateParams,
  type IdeaUpdateParams,
  type IdeaListParams,
  type IdeaMoveParams,
  type IdeaConvertParams,
} from './ideas';
```

- [ ] **Step 8: Update `packages/sdk/src/resources/index.ts`**

Add the new exports to the barrel file:

```typescript
export {
  Ideas,
  type IdeaResponse,
  type IdeaCreateResponse,
  type IdeaRetrieveResponse,
  type IdeaUpdateResponse,
  type IdeaMoveResponse,
  type IdeaListResponse,
  type IdeaConvertResponse,
  type IdeaCreateParams,
  type IdeaUpdateParams,
  type IdeaListParams,
  type IdeaMoveParams,
  type IdeaConvertParams,
} from './ideas/ideas';
export { Comments as IdeaComments, type CommentCreateResponse, type CommentUpdateResponse, type CommentListResponse, type CommentCreateParams, type CommentUpdateParams, type CommentListParams } from './ideas/comments';
export { Media as IdeaMedia, type MediaUploadResponse, type MediaUploadParams } from './ideas/media';
export { Activity as IdeaActivity, type ActivityListResponse, type ActivityListParams } from './ideas/activity';
export { IdeaGroups, type IdeaGroupResponse, type IdeaGroupCreateResponse, type IdeaGroupUpdateResponse, type IdeaGroupListResponse, type IdeaGroupCreateParams, type IdeaGroupUpdateParams, type IdeaGroupListParams, type IdeaGroupReorderParams } from './idea-groups';
export { Tags, type TagCreateResponse, type TagUpdateResponse, type TagGetResponse, type TagListResponse, type TagCreateParams, type TagUpdateParams, type TagListParams } from './tags';
```

- [ ] **Step 9: Update `packages/sdk/src/client.ts`**

Add the new resource properties:

```typescript
import { Ideas } from './resources/ideas/ideas';
import { IdeaGroups } from './resources/idea-groups';
import { Tags } from './resources/tags';

// In the Relay class:
ideas: Ideas = new Ideas(this);
ideaGroups: IdeaGroups = new IdeaGroups(this);
tags: Tags = new Tags(this);
```

- [ ] **Step 10: Add `idea_id` to PostCreateParams in the posts SDK**

In `packages/sdk/src/resources/posts/posts.ts`, add to `PostCreateParams`:

```typescript
idea_id?: string;
```

- [ ] **Step 11: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors

- [ ] **Step 12: Commit**

```bash
git add packages/sdk/src/
git commit -m "feat(sdk): add Ideas, IdeaGroups, and Tags SDK resources"
```

---

## Task 10: Tests

**Files:**
- Create: `apps/api/src/__tests__/ideas.test.ts`

- [ ] **Step 1: Create the ideas test file**

Create `apps/api/src/__tests__/ideas.test.ts`:

```typescript
import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock @relayapi/db
mock.module("@relayapi/db", () => ({
	createDb: () => ({}),
	ideas: {},
	ideaGroups: {},
	ideaMedia: {},
	ideaTags: {},
	ideaComments: {},
	ideaActivity: {},
	tags: {},
	posts: {},
	postTags: {},
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env, Variables } from "../types";
import { authMiddleware } from "../middleware/auth";
import { MockKV, createMockEnv, seedApiKeyInKV, hashKey } from "./__mocks__/env";

const TEST_KEY = "rlay_live_testideaskey000000000000000000000000000000";

let kv: MockKV;
let env: Env;

function makeRequest(
	path: string,
	method = "GET",
	body?: Record<string, unknown>,
	headers?: Record<string, string>,
) {
	return new Request(`http://localhost${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TEST_KEY}`,
			...headers,
		},
		body: body ? JSON.stringify(body) : undefined,
	});
}

const mockCtx = {
	waitUntil: () => {},
	passThroughOnException: () => {},
} as unknown as ExecutionContext;

beforeEach(async () => {
	const m = createMockEnv();
	kv = m.kv;
	env = m.env;

	const hash = await hashKey(TEST_KEY);
	await seedApiKeyInKV(kv, hash, {
		org_id: "org_test",
		key_id: "key_test",
		permissions: ["write"],
		expires_at: null,
		plan: "pro",
		calls_included: 10_000,
	});
});

describe("Ideas API", () => {
	describe("authentication", () => {
		it("rejects requests without API key", async () => {
			const { default: ideasRouter } = await import("../routes/ideas");
			const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
			app.use("*", authMiddleware);
			app.route("/v1/ideas", ideasRouter);

			const res = await app.fetch(
				new Request("http://localhost/v1/ideas", { method: "GET" }),
				env,
				mockCtx,
			);
			expect(res.status).toBe(401);
		});
	});

	describe("Tags API", () => {
		it("rejects tag creation without auth", async () => {
			const { default: tagsRouter } = await import("../routes/tags");
			const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
			app.use("*", authMiddleware);
			app.route("/v1/tags", tagsRouter);

			const res = await app.fetch(
				new Request("http://localhost/v1/tags", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "test", color: "#FF0000" }),
				}),
				env,
				mockCtx,
			);
			expect(res.status).toBe(401);
		});
	});
});
```

Note: Full integration tests require a real database connection (via SSH tunnel). The tests above verify auth middleware integration. More comprehensive tests should be added once the feature is deployed to a test environment, following the existing `apps/api/src/__tests__/auth.test.ts` patterns.

- [ ] **Step 2: Run the tests**

Run: `cd /Users/zank/Developer/majestico/relayapi/apps/api && bun test src/__tests__/ideas.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/ideas.test.ts
git commit -m "test: add auth integration tests for ideas and tags routes"
```

---

## Task 11: OpenAPI Spec Export and Verification

**Files:**
- No new files — verification only

- [ ] **Step 1: Start the dev server**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run dev:api`
Expected: Server starts on localhost:8787 (or configured port)

- [ ] **Step 2: Export the OpenAPI spec**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run --filter api export-openapi`
Expected: OpenAPI spec generated. Verify it contains the new endpoints:
- `/v1/ideas` (GET, POST)
- `/v1/ideas/{id}` (GET, PATCH, DELETE)
- `/v1/ideas/{id}/move` (POST)
- `/v1/ideas/{id}/convert` (POST)
- `/v1/ideas/{id}/media` (POST)
- `/v1/ideas/{id}/media/{media_id}` (DELETE)
- `/v1/ideas/{id}/comments` (GET, POST)
- `/v1/ideas/{id}/comments/{comment_id}` (PATCH, DELETE)
- `/v1/ideas/{id}/activity` (GET)
- `/v1/idea-groups` (GET, POST)
- `/v1/idea-groups/{id}` (PATCH, DELETE)
- `/v1/idea-groups/reorder` (POST)
- `/v1/tags` (GET, POST)
- `/v1/tags/{id}` (PATCH, DELETE)

- [ ] **Step 3: Verify Swagger UI**

Open `http://localhost:8787/docs` in a browser. Verify:
- "Ideas" tag group with all idea endpoints
- "Idea Groups" tag group with group endpoints
- "Tags" tag group with tag endpoints
- All request/response schemas render correctly

- [ ] **Step 4: Stop the dev server**

---

## Task 12: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors across all packages and apps

- [ ] **Step 2: Run all tests**

Run: `cd /Users/zank/Developer/majestico/relayapi/apps/api && bun test`
Expected: All tests pass

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: content planning feature — ideas, kanban groups, tags, comments, and activity"
```
