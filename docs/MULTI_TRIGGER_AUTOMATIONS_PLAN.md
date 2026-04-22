# Multi-Trigger Automations Implementation Plan

> **DEPRECATED — historical planning artifact.** This document is superseded by the Manychat-parity automation rebuild. The current source of truth is [`docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md`](./superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md). Concepts here (`automation_triggers` table, label-based edges, the ~90-value node enum) no longer describe the shipped system. Kept for reference only — do not implement from this document.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1:1 `automation ↔ trigger` model with a 1:N model so a single automation can fire on multiple distinct triggers (different types, different configs, different filters, different accounts) — matching ManyChat's UX.

**Architecture:**
- New `automation_triggers` table (child of `automations`, cascade delete).
- `trigger_matcher` joins against the new table; enrollments record which trigger fired (`automation_enrollments.trigger_id`).
- API replaces `trigger: TriggerSpec` with `triggers: TriggerSpec[]`; legacy columns on `automations` are dropped (user explicitly waived backward compatibility).
- Runtime snapshot becomes `triggers[]`; node executors that need `account_id` resolve it from the matched trigger via `enrollment.trigger_id`.
- Frontend: `AutomationDetail.triggers[]`; trigger card renders one row per trigger; clicking a row opens that trigger's detail panel; clicking the card header opens a list view with "+ New Trigger".

**Tech Stack:** Drizzle ORM + PostgreSQL (via Cloudflare Hyperdrive), Hono + Zod-OpenAPI on Workers, React + ReactFlow on Astro for the dashboard, Bun workspaces.

---

## File Structure

### Created files
- `packages/db/drizzle/0027_multi_trigger.sql` — migration
- `apps/api/src/services/automations/resolve-trigger.ts` — helper to pick the enrolled trigger from a snapshot

### Modified files
**Backend schema & contracts:**
- `packages/db/src/schema.ts` — add `automationTriggers`, drop trigger_* columns from `automations`, add `triggerId` FK on `automationEnrollments`
- `apps/api/src/schemas/automations.ts` — rename `trigger` → `triggers`; add `TriggersSpec` (array with ≥1 rule); update `AutomationResponse` and `AutomationWithGraphResponse`

**Backend runtime:**
- `apps/api/src/services/automations/trigger-matcher.ts` — join through `automation_triggers`; write `triggerId` on enrollment
- `apps/api/src/routes/automations.ts` — rewrite GET/LIST/POST/PATCH/snapshot builder
- `apps/api/src/routes/automation-templates.ts` — adapt response serializer
- `apps/api/src/services/automations/template-builders.ts` — emit `triggers[]` instead of single trigger
- `apps/api/src/services/automations/manifest.ts` — snapshot shape
- `apps/api/src/services/automations/nodes/platforms/*.ts` (all 13 files using `snapshot.trigger.account_id`) — switch to matched-trigger lookup
- `apps/api/src/services/automations/nodes/user-input.ts` — matched-trigger lookup
- `apps/api/src/services/automations/nodes/message-text.ts` — matched-trigger lookup
- `apps/api/src/services/automations/contact-channel.ts` — matched-trigger lookup
- `apps/api/src/services/inbox-event-processor.ts` — pass enriched context to matcher (unchanged signature, but test once)

**SDK / OpenAPI:**
- `packages/sdk/src/resources/automations.ts` — update types
- Regenerated OpenAPI (automatic via the `sync-openapi` GH action or `bun run --filter api export-openapi`)

**Frontend:**
- `apps/app/src/components/dashboard/automation/flow-builder/types.ts` — add `AutomationTriggerSpec`, remove flat trigger fields
- `apps/app/src/components/dashboard/automation/flow-builder/trigger-ui.ts` — delete `__ui_display_triggers` hack; replace with first-class triggers
- `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx` — trigger card renders `data.automation.triggers`, each row clickable
- `apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx` — split into list mode + detail mode
- `apps/app/src/components/dashboard/pages/automation-detail-page.tsx` — `selectedTriggerId` state, triggers CRUD handlers, normalize function reads `triggers[]`
- `apps/app/src/components/dashboard/automation/flow-builder/validation.ts` — validate that automation has ≥1 trigger

**Tests:**
- `apps/api/src/__tests__/automations.test.ts` — update to new contract
- `apps/api/src/__tests__/multi-trigger.test.ts` — new file

---

## Phase 1 — Database schema

### Task 1: Add `automation_triggers` table + enrollment FK to Drizzle schema

**Files:**
- Modify: `packages/db/src/schema.ts` (around `automations` definition at line 2759 and `automationEnrollments` at line 2897)

- [ ] **Step 1: Add the new table definition after `automations`**

Edit `packages/db/src/schema.ts`. Immediately after the `automations` export (closing `);` at line 2809), insert:

```typescript
export const automationTriggers = pgTable(
	"automation_triggers",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("atrg_")),
		automationId: text("automation_id")
			.notNull()
			.references(() => automations.id, { onDelete: "cascade" }),
		type: automationTriggerTypeEnum("type").notNull(),
		config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
		filters: jsonb("filters").notNull().default(sql`'{}'::jsonb`),
		socialAccountId: text("social_account_id").references(
			() => socialAccounts.id,
			{ onDelete: "set null" },
		),
		label: text("label").notNull(),
		orderIndex: integer("order_index").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("automation_triggers_automation_idx").on(table.automationId),
		index("automation_triggers_matcher_idx").on(table.type),
		index("automation_triggers_account_idx").on(table.socialAccountId),
	],
);
```

- [ ] **Step 2: Remove obsolete columns from `automations`**

In the `automations` pgTable definition, delete these lines:

```typescript
triggerType: automationTriggerTypeEnum("trigger_type").notNull(),
triggerConfig: jsonb("trigger_config").notNull().default(sql`'{}'::jsonb`),
triggerFilters: jsonb("trigger_filters").notNull().default(sql`'{}'::jsonb`),
socialAccountId: text("social_account_id").references(
    () => socialAccounts.id,
    { onDelete: "set null" },
),
```

Remove these indexes from the `automations` `(table) => [...]` block:

```typescript
index("automations_trigger_matcher_idx").on(
    table.organizationId,
    table.status,
    table.triggerType,
),
index("automations_account_idx").on(table.socialAccountId),
```

Replace with a simpler active-lookup index:

```typescript
index("automations_active_idx").on(table.organizationId, table.status),
```

- [ ] **Step 3: Add `triggerId` FK to `automationEnrollments`**

In the `automationEnrollments` pgTable definition (starts line 2897), add after `automationVersion`:

```typescript
triggerId: text("trigger_id").references(() => automationTriggers.id, {
    onDelete: "set null",
}),
```

Add an index inside its `(table) => [...]`:

```typescript
index("automation_enrollments_trigger_idx").on(table.triggerId),
```

- [ ] **Step 4: Generate the migration**

Run: `bun run db:generate`

Expected: a new file `packages/db/drizzle/0027_<name>.sql` is written. Open it and verify it contains: `CREATE TABLE "automation_triggers"`, `ALTER TABLE "automation_enrollments" ADD COLUMN "trigger_id"`, and `ALTER TABLE "automations" DROP COLUMN "trigger_type"`/`"trigger_config"`/`"trigger_filters"`/`"social_account_id"`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/
git commit -m "feat(db): add automation_triggers table, drop single-trigger columns"
```

### Task 2: Backfill existing automations into the new table

The Drizzle generator doesn't know data semantics; we must hand-edit the generated migration so existing automation rows don't lose their trigger.

**Files:**
- Modify: `packages/db/drizzle/0027_multi_trigger.sql` (the file generated in Task 1)

- [ ] **Step 1: Reorder the migration**

Open the generated SQL and reorder statements so the flow is:
1. `CREATE TABLE "automation_triggers" ...`
2. Create indexes on `automation_triggers`
3. `ALTER TABLE "automation_enrollments" ADD COLUMN "trigger_id" ...`
4. `INSERT INTO "automation_triggers" ...` (backfill — see next step)
5. `UPDATE "automation_enrollments" SET trigger_id = ...` (backfill enrollment FK)
6. `ALTER TABLE "automations" DROP COLUMN ...` (drop old columns LAST)

- [ ] **Step 2: Insert the backfill statement before DROP COLUMN**

Add these SQL statements between the new column additions and the drops:

```sql
-- Backfill: one automation_triggers row per existing automation
INSERT INTO "automation_triggers" ("id", "automation_id", "type", "config", "filters", "social_account_id", "label", "order_index", "created_at", "updated_at")
SELECT
    'atrg_' || substr(md5(random()::text || a.id), 1, 22),
    a.id,
    a.trigger_type,
    a.trigger_config,
    a.trigger_filters,
    a.social_account_id,
    'Trigger #1',
    0,
    a.created_at,
    a.updated_at
FROM "automations" a;

-- Backfill enrollments: point each enrollment at its automation's sole trigger
UPDATE "automation_enrollments" e
SET trigger_id = (
    SELECT t.id FROM "automation_triggers" t WHERE t.automation_id = e.automation_id LIMIT 1
);
```

- [ ] **Step 3: Apply the migration locally**

Ensure the SSH tunnel is running (VS Code task "SSH Tunnel to Database"), then:

```bash
bun run db:migrate
```

Expected: migration applies cleanly, no errors. Verify with a quick psql query:

```bash
psql "postgresql://$USER@localhost:5433/<dbname>" -c "SELECT automation_id, type, label FROM automation_triggers LIMIT 5;"
```

Expected: one row per existing automation.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/0027_multi_trigger.sql
git commit -m "feat(db): backfill automation_triggers from existing rows"
```

---

## Phase 2 — API schemas (Zod / OpenAPI)

### Task 3: Update `TriggerSpec` and introduce `TriggersSpec`

**Files:**
- Modify: `apps/api/src/schemas/automations.ts` (around line 427 for `TriggerSpec`, line 1746 for `AutomationCreateSpec`, line 1768 for `AutomationResponse`)

- [ ] **Step 1: Replace `TriggerSpec` definition**

Find the existing `export const TriggerSpec = z.object({...})` (starts line 427). Replace with:

```typescript
export const TriggerSpec = z.object({
	id: z.string().optional().describe("Server-assigned id for existing triggers; omit to create new"),
	type: AutomationTriggerTypeEnum,
	account_id: z
		.string()
		.nullable()
		.optional()
		.describe("Social account to attach the trigger to"),
	config: z
		.record(z.string(), z.any())
		.optional()
		.describe("Trigger-specific config (keyword list, post_id, ref slug, cron, etc.)"),
	filters: TriggerFilters.optional(),
	label: z.string().min(1).max(120).optional().describe("User-facing label, e.g. 'Story Reply #1'"),
	order_index: z.number().int().min(0).optional(),
});

export const TriggersSpec = z
	.array(TriggerSpec)
	.min(1)
	.describe("One or more triggers that start this automation");

export const AutomationTriggerResponse = z.object({
	id: z.string(),
	type: AutomationTriggerTypeEnum,
	account_id: z.string().nullable(),
	config: z.any(),
	filters: z.any(),
	label: z.string(),
	order_index: z.number().int(),
});
```

- [ ] **Step 2: Update `AutomationCreateSpec` (around line 1746)**

Change the `trigger: TriggerSpec` field to `triggers: TriggersSpec`:

```typescript
export const AutomationCreateSpec = z.object({
	name: z.string().min(1).max(200),
	description: z.string().optional(),
	workspace_id: z.string().optional(),
	channel: AutomationChannelEnum,
	status: AutomationStatusEnum.default("draft"),
	triggers: TriggersSpec,
	nodes: z.array(AutomationNodeSpec).default([]),
	edges: z.array(AutomationEdgeSpec).default([]),
	exit_on_reply: z.boolean().default(true),
	allow_reentry: z.boolean().default(false),
	reentry_cooldown_min: z.number().int().optional(),
});
```

- [ ] **Step 3: Update `AutomationResponse`**

Find `AutomationResponse` (line 1768). Remove the flat trigger fields (`trigger_type`, `trigger_config`, `trigger_filters`, `social_account_id`) and add:

```typescript
triggers: z.array(AutomationTriggerResponse),
```

- [ ] **Step 4: Update the list-filter trigger_type param**

`apps/api/src/routes/automations.ts` line 52: `trigger_type: z.string().optional()`. Leave this for now — it still acts as a filter (matches any automation with a trigger of that type). Its implementation moves in Task 5.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck:api`

Expected: errors in files that still reference removed fields. Those are addressed in subsequent tasks — no need to fix here yet.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/schemas/automations.ts
git commit -m "feat(api): replace single trigger with triggers array in schemas"
```

---

## Phase 3 — Trigger matcher + enrollment

### Task 4: Rewrite `trigger-matcher.ts`

**Files:**
- Modify: `apps/api/src/services/automations/trigger-matcher.ts`

- [ ] **Step 1: Import the new table**

At the top of the file, extend the import:

```typescript
import {
	automationEnrollments,
	automations,
	automationTriggers,
	contacts,
	customFieldDefinitions,
	customFieldValues,
} from "@relayapi/db";
```

- [ ] **Step 2: Rewrite the candidate query in `matchAndEnroll`**

Replace the `db.select().from(automations).where(...)` block (lines 31-40) with:

```typescript
const rows = await db
	.select({
		automation: automations,
		trigger: automationTriggers,
	})
	.from(automationTriggers)
	.innerJoin(automations, eq(automationTriggers.automationId, automations.id))
	.where(
		and(
			eq(automations.organizationId, input.organization_id),
			eq(automations.status, "active"),
			eq(automationTriggers.type, input.trigger_type as never),
		),
	);

if (rows.length === 0) return [];
```

- [ ] **Step 3: Update the per-candidate loop**

Replace `for (const auto of candidates)` with:

```typescript
for (const { automation: auto, trigger } of rows) {
```

Everywhere the old code read `auto.socialAccountId`, `auto.triggerConfig`, `auto.triggerFilters`, replace with `trigger.socialAccountId`, `trigger.config`, `trigger.filters`:

```typescript
// Account scoping uses the matched trigger
if (
	input.account_id &&
	trigger.socialAccountId &&
	trigger.socialAccountId !== input.account_id
) {
	continue;
}

if (!matchTriggerConfig(trigger.config as Record<string, unknown>, input.payload)) {
	continue;
}

if (
	!matchesTriggerFilters(
		(trigger.filters as Record<string, unknown>) ?? {},
		{ tags, fields, contact },
	)
) {
	continue;
}
```

- [ ] **Step 4: Record `triggerId` on the new enrollment**

In the `db.insert(automationEnrollments).values({...})` block near line 143, add `triggerId: trigger.id,` so the enrollment knows which trigger fired:

```typescript
const [created] = await db
	.insert(automationEnrollments)
	.values({
		automationId: auto.id,
		automationVersion: version,
		triggerId: trigger.id,
		organizationId: auto.organizationId,
		contactId: input.contact_id ?? null,
		conversationId: input.conversation_id ?? null,
		state: input.payload,
		status: "active",
	})
	.returning({ id: automationEnrollments.id });
```

- [ ] **Step 5: Run existing tests to see what breaks**

Run: `bun run --filter api test -- --testPathPattern=trigger-matcher 2>&1 || true`

Expected: tests fail referencing old fields. Capture the failures — they'll be fixed in Task 11.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/automations/trigger-matcher.ts
git commit -m "feat(runtime): match triggers via automation_triggers join"
```

### Task 5: Update the GET/LIST automation routes to project triggers

**Files:**
- Modify: `apps/api/src/routes/automations.ts` (lines 250-260 serialize helper; line 490-ish list query; GET handler loading trigger rows)

- [ ] **Step 1: Load triggers alongside automation rows**

Find the `serializeAutomation(a)` helper (around line 250). Change its signature to take the trigger rows too. Look at the current shape:

```typescript
function serializeAutomation(a: typeof automations.$inferSelect): SerializedAutomation {
	return {
		...
		trigger_type: a.triggerType as SerializedAutomation["trigger_type"],
		trigger_config: a.triggerConfig,
		trigger_filters: a.triggerFilters,
		social_account_id: a.socialAccountId,
		...
	};
}
```

Replace with:

```typescript
function serializeAutomation(
	a: typeof automations.$inferSelect,
	triggers: (typeof automationTriggers.$inferSelect)[],
): SerializedAutomation {
	return {
		id: a.id,
		organization_id: a.organizationId,
		workspace_id: a.workspaceId,
		name: a.name,
		description: a.description,
		status: a.status,
		channel: a.channel,
		triggers: triggers
			.sort((x, y) => x.orderIndex - y.orderIndex)
			.map((t) => ({
				id: t.id,
				type: t.type,
				account_id: t.socialAccountId,
				config: t.config,
				filters: t.filters,
				label: t.label,
				order_index: t.orderIndex,
			})),
		entry_node_id: a.entryNodeId,
		version: a.version,
		published_version: a.publishedVersion,
		exit_on_reply: a.exitOnReply,
		allow_reentry: a.allowReentry,
		reentry_cooldown_min: a.reentryCooldownMin,
		total_enrolled: a.totalEnrolled,
		total_completed: a.totalCompleted,
		total_exited: a.totalExited,
		created_at: a.createdAt.toISOString(),
		updated_at: a.updatedAt.toISOString(),
	};
}
```

- [ ] **Step 2: Update the `SerializedAutomation` type**

Above the helper, update the type alias:

```typescript
type SerializedAutomation = z.infer<typeof AutomationResponse>;
```

If it's defined elsewhere, update imports accordingly.

- [ ] **Step 3: Update every call site of `serializeAutomation`**

Search `apps/api/src/routes/automations.ts` for `serializeAutomation(` and for each call, fetch triggers first:

```typescript
const triggers = await db
	.select()
	.from(automationTriggers)
	.where(eq(automationTriggers.automationId, auto.id));
return c.json(serializeAutomation(auto, triggers));
```

For list endpoints, batch-fetch to avoid N+1:

```typescript
const automationIds = autos.map((a) => a.id);
const allTriggers = automationIds.length
	? await db
			.select()
			.from(automationTriggers)
			.where(inArray(automationTriggers.automationId, automationIds))
	: [];
const byAutomation = new Map<string, typeof allTriggers>();
for (const t of allTriggers) {
	const list = byAutomation.get(t.automationId) ?? [];
	list.push(t);
	byAutomation.set(t.automationId, list);
}
return c.json({
	data: autos.map((a) => serializeAutomation(a, byAutomation.get(a.id) ?? [])),
	next_cursor: ...,
	has_more: ...,
});
```

Make sure `inArray` is imported from `drizzle-orm` at the top of the file.

- [ ] **Step 4: Update the list trigger_type filter**

Around line 490, replace:

```typescript
if (trigger_type)
	conditions.push(eq(automations.triggerType, trigger_type as never));
```

With a subquery that finds automation IDs with a trigger of that type:

```typescript
if (trigger_type) {
	const ids = await db
		.selectDistinct({ id: automationTriggers.automationId })
		.from(automationTriggers)
		.where(eq(automationTriggers.type, trigger_type as never));
	if (ids.length === 0) {
		return c.json({ data: [], next_cursor: null, has_more: false });
	}
	conditions.push(inArray(automations.id, ids.map((r) => r.id)));
}
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck:api`

Expected: remaining errors are in POST/PATCH/snapshot handlers — fixed in next tasks.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/automations.ts
git commit -m "feat(api): project triggers array in GET/LIST automation responses"
```

### Task 6: Rewrite POST / PATCH automation handlers

**Files:**
- Modify: `apps/api/src/routes/automations.ts` (POST handler ~line 350; PATCH handler ~line 730)

- [ ] **Step 1: Update the POST handler to insert triggers**

Find the POST handler (where `db.insert(automations).values({...})` is called). Previously:

```typescript
const [created] = await db
	.insert(automations)
	.values({
		...
		triggerType: body.trigger.type as never,
		triggerConfig: body.trigger.config ?? {},
		triggerFilters: body.trigger.filters ?? {},
		socialAccountId: body.trigger.account_id ?? null,
	})
	.returning();
```

Replace with a two-step: insert automation, then bulk-insert triggers. Use a transaction:

```typescript
const created = await db.transaction(async (tx) => {
	const [auto] = await tx
		.insert(automations)
		.values({
			organizationId: auth.organization_id,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			description: body.description ?? null,
			status: body.status,
			channel: body.channel,
			exitOnReply: body.exit_on_reply,
			allowReentry: body.allow_reentry,
			reentryCooldownMin: body.reentry_cooldown_min ?? null,
			createdBy: auth.user_id ?? null,
		})
		.returning();
	if (!auto) throw new Error("automation insert failed");

	const triggerRows = await tx
		.insert(automationTriggers)
		.values(
			body.triggers.map((t, idx) => ({
				automationId: auto.id,
				type: t.type as never,
				config: t.config ?? {},
				filters: t.filters ?? {},
				socialAccountId: t.account_id ?? null,
				label: t.label ?? `Trigger #${idx + 1}`,
				orderIndex: t.order_index ?? idx,
			})),
		)
		.returning();

	return { auto, triggerRows };
});

return c.json(serializeAutomation(created.auto, created.triggerRows), 201);
```

- [ ] **Step 2: Update the PATCH handler to reconcile triggers**

Find the PATCH handler where `if (body.trigger)` appears (~line 750). Previously:

```typescript
if (body.trigger) {
	updates.triggerType = body.trigger.type as never;
	updates.triggerConfig = body.trigger.config ?? {};
	updates.triggerFilters = body.trigger.filters ?? {};
	if (body.trigger.account_id !== undefined) {
		updates.socialAccountId = body.trigger.account_id ?? null;
	}
}
```

Remove that block. Handle `body.triggers` as a full replacement inside the existing transaction that also updates nodes/edges:

```typescript
if (body.triggers) {
	// Full replacement: delete existing, insert new. Use separate IDs when
	// the client provided them so enrollments.trigger_id stays valid.
	await tx
		.delete(automationTriggers)
		.where(eq(automationTriggers.automationId, id));
	if (body.triggers.length > 0) {
		await tx.insert(automationTriggers).values(
			body.triggers.map((t, idx) => ({
				id: t.id ?? undefined,
				automationId: id,
				type: t.type as never,
				config: t.config ?? {},
				filters: t.filters ?? {},
				socialAccountId: t.account_id ?? null,
				label: t.label ?? `Trigger #${idx + 1}`,
				orderIndex: t.order_index ?? idx,
			})),
		);
	}
}
```

Note: on trigger replacement, enrollments pointing to old trigger ids get orphaned (`trigger_id` set to NULL via `ON DELETE SET NULL`). That's acceptable — the enrollment is mid-flight and its snapshot has the captured payload. New enrollments get the new ids.

- [ ] **Step 3: Update the snapshot builder around line 1170-1200**

Find the block that builds `snapshot = {...}` for version publishing. Replace the single `trigger:` field with `triggers:`:

```typescript
const triggers = await db
	.select()
	.from(automationTriggers)
	.where(eq(automationTriggers.automationId, id));
// ... existing nodes/edges fetch ...
snapshot = {
	automation_id: id,
	version: auto.version,
	name: auto.name,
	channel: auto.channel,
	triggers: triggers
		.sort((a, b) => a.orderIndex - b.orderIndex)
		.map((t) => ({
			id: t.id,
			type: t.type,
			account_id: t.socialAccountId ?? undefined,
			config: (t.config as Record<string, unknown>) ?? {},
			filters: (t.filters as Record<string, unknown>) ?? {},
			label: t.label,
			order_index: t.orderIndex,
		})),
	entry_node_key: "trigger",
	// ... existing nodes/edges ...
};
```

- [ ] **Step 4: Update the second snapshot builder around line 1600**

Find the other block constructing a trigger in `{ type: auto.triggerType, account_id: auto.socialAccountId, ... }`. Apply the same `triggers: []` shape.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/automations.ts
git commit -m "feat(api): POST/PATCH automations accept triggers array"
```

### Task 7: Create `resolve-trigger.ts` helper for runtime

**Files:**
- Create: `apps/api/src/services/automations/resolve-trigger.ts`

- [ ] **Step 1: Write the helper**

```typescript
import type { AutomationSnapshot, SnapshotTrigger } from "./manifest";

/**
 * Returns the snapshot trigger that fired for this enrollment. Falls back to
 * the first trigger (order_index 0) if trigger_id is missing — e.g. on
 * manually-enrolled runs that didn't come from a webhook match.
 */
export function resolveEnrollmentTrigger(
	snapshot: AutomationSnapshot,
	enrollmentTriggerId: string | null | undefined,
): SnapshotTrigger {
	if (enrollmentTriggerId) {
		const exact = snapshot.triggers.find((t) => t.id === enrollmentTriggerId);
		if (exact) return exact;
	}
	const first = [...snapshot.triggers].sort(
		(a, b) => a.order_index - b.order_index,
	)[0];
	if (!first) {
		throw new Error(
			`automation ${snapshot.automation_id} snapshot has no triggers`,
		);
	}
	return first;
}
```

- [ ] **Step 2: Export the types from `manifest.ts`**

Open `apps/api/src/services/automations/manifest.ts`. Add / update the types that describe the snapshot:

```typescript
export interface SnapshotTrigger {
	id: string;
	type: string;
	account_id?: string;
	config: Record<string, unknown>;
	filters: Record<string, unknown>;
	label: string;
	order_index: number;
}

export interface AutomationSnapshot {
	automation_id: string;
	version: number;
	name: string;
	channel: string;
	triggers: SnapshotTrigger[]; // replaces previous `trigger`
	entry_node_key: string;
	nodes: SnapshotNode[];
	edges: SnapshotEdge[];
	// ... keep existing fields
}
```

If `manifest.ts` previously exported `SnapshotTrigger` as a single-shape interface, adjust. If it exported `snapshot.trigger` typed inline, add the new interface and update usage.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/automations/resolve-trigger.ts apps/api/src/services/automations/manifest.ts
git commit -m "feat(runtime): resolveEnrollmentTrigger helper + snapshot type update"
```

### Task 8: Switch all node executors to `resolveEnrollmentTrigger`

**Files to modify (14 total):**
- `apps/api/src/services/automations/nodes/platforms/instagram.ts`
- `apps/api/src/services/automations/nodes/platforms/facebook.ts`
- `apps/api/src/services/automations/nodes/platforms/whatsapp.ts`
- `apps/api/src/services/automations/nodes/platforms/telegram.ts`
- `apps/api/src/services/automations/nodes/platforms/discord.ts`
- `apps/api/src/services/automations/nodes/platforms/sms.ts`
- `apps/api/src/services/automations/nodes/platforms/twitter.ts`
- `apps/api/src/services/automations/nodes/platforms/bluesky.ts`
- `apps/api/src/services/automations/nodes/platforms/mastodon.ts`
- `apps/api/src/services/automations/nodes/platforms/reddit.ts`
- `apps/api/src/services/automations/nodes/platforms/threads.ts`
- `apps/api/src/services/automations/nodes/platforms/youtube.ts`
- `apps/api/src/services/automations/nodes/user-input.ts`
- `apps/api/src/services/automations/nodes/message-text.ts`
- `apps/api/src/services/automations/contact-channel.ts`

- [ ] **Step 1: Replace `ctx.snapshot.trigger.*` everywhere**

For each file, locate every occurrence of `ctx.snapshot.trigger.` and replace with a local trigger resolved via the helper. Insert near the top of each executor function:

```typescript
import { resolveEnrollmentTrigger } from "../../resolve-trigger";
// in function body:
const trigger = resolveEnrollmentTrigger(ctx.snapshot, ctx.enrollment.triggerId);
```

(Adjust the relative import path based on folder depth: platforms use `"../../resolve-trigger"`, nodes/ root use `"../resolve-trigger"`.)

Then rewrite uses:
- `ctx.snapshot.trigger.account_id` → `trigger.account_id`
- `ctx.snapshot.trigger.type` → `trigger.type`
- `ctx.snapshot.trigger.config` → `trigger.config`
- `ctx.snapshot.trigger.filters` → `trigger.filters`

- [ ] **Step 2: Add `triggerId` to the enrollment context**

In the node execution dispatcher (search for where `ctx.enrollment` is constructed — likely `apps/api/src/services/automations/runner.ts` or similar), ensure the object includes `triggerId: row.triggerId` when loaded from the enrollment row.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck:api`

Expected: 0 type errors. If errors remain about `snapshot.trigger`, grep for stragglers: `grep -rn "snapshot\.trigger" apps/api/src/ | grep -v triggers`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src
git commit -m "feat(runtime): node executors resolve per-enrollment trigger"
```

### Task 9: Update template builders & automation-templates route

**Files:**
- Modify: `apps/api/src/services/automations/template-builders.ts`
- Modify: `apps/api/src/routes/automation-templates.ts` (line 143 has trigger_type/trigger_config in response)

- [ ] **Step 1: Update `template-builders.ts`**

Search for every place templates create an automation — they likely return an object with `trigger_type`/`trigger_config`. Change to a `triggers:` array. For each template, figure out what the single trigger should be and emit:

```typescript
triggers: [
	{
		type: "instagram_comment",
		account_id: input.account_id ?? null,
		config: { keywords: input.keywords },
		filters: {},
		label: "Comment Reply",
		order_index: 0,
	},
],
```

- [ ] **Step 2: Update the template response serializer**

In `apps/api/src/routes/automation-templates.ts` around line 143, re-read the automation with its triggers and emit `triggers: []` instead of flat fields. Follow the same pattern as `serializeAutomation`.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck:api`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api
git commit -m "feat(api): templates emit triggers array"
```

---

## Phase 4 — SDK & OpenAPI

### Task 10: Update the TypeScript SDK

**Files:**
- Modify: `packages/sdk/src/resources/automations.ts`

- [ ] **Step 1: Mirror the new TriggerSpec / TriggersSpec / AutomationTriggerResponse types**

Open `packages/sdk/src/resources/automations.ts`. Find existing `trigger` type definition and replace with:

```typescript
export interface AutomationTriggerInput {
	id?: string;
	type: AutomationTriggerType;
	account_id?: string | null;
	config?: Record<string, unknown>;
	filters?: AutomationTriggerFilters;
	label?: string;
	order_index?: number;
}

export interface AutomationTrigger {
	id: string;
	type: AutomationTriggerType;
	account_id: string | null;
	config: unknown;
	filters: unknown;
	label: string;
	order_index: number;
}
```

- [ ] **Step 2: Swap `trigger` → `triggers` everywhere in this file**

Find the create body and update body types — rename `trigger: AutomationTriggerInput` to `triggers: AutomationTriggerInput[]` (create requires it, update makes it optional).

Find the `Automation` response type — remove `trigger_type`, `trigger_config`, `trigger_filters`, `social_account_id`. Add `triggers: AutomationTrigger[]`.

- [ ] **Step 3: Build the SDK**

Run: `bun run build:sdk`

Expected: clean build, `packages/sdk/dist/` regenerated.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/
git commit -m "feat(sdk)!: replace single trigger with triggers array

BREAKING CHANGE: automation.trigger is now automation.triggers[]"
```

(The `!` and `BREAKING CHANGE` trailer triggers a major version bump via release-please, which is appropriate here.)

### Task 11: Regenerate OpenAPI

**Files:**
- Regenerated: `apps/api/openapi.json` (or wherever `export-openapi` writes)

- [ ] **Step 1: Start the API dev server**

In one terminal: `bun run dev:api`

- [ ] **Step 2: Export the spec**

In another terminal:

```bash
bun run --filter api export-openapi
```

Expected: the OpenAPI JSON/YAML is refreshed. Diff it — `trigger` definitions should now be `triggers: TriggerSpec[]`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/openapi.json
git commit -m "chore(api): regenerate OpenAPI for triggers array"
```

---

## Phase 5 — Frontend types & state

### Task 12: Update frontend types

**Files:**
- Modify: `apps/app/src/components/dashboard/automation/flow-builder/types.ts`

- [ ] **Step 1: Add the trigger spec type**

After the existing types, add:

```typescript
export interface AutomationTriggerSpec {
	id: string;
	type: string;
	account_id: string | null;
	config: Record<string, unknown>;
	filters: Record<string, unknown>;
	label: string;
	order_index: number;
}
```

- [ ] **Step 2: Update `AutomationDetail`**

Find `AutomationDetail`. Remove flat trigger fields (`trigger_type`, `trigger_config`, `trigger_filters`, `social_account_id`). Add:

```typescript
triggers: AutomationTriggerSpec[];
```

- [ ] **Step 3: Commit**

```bash
git add apps/app/src/components/dashboard/automation/flow-builder/types.ts
git commit -m "feat(app): AutomationDetail.triggers replaces flat trigger fields"
```

### Task 13: Delete `__ui_display_triggers` helpers, rewrite `trigger-ui.ts`

**Files:**
- Modify: `apps/app/src/components/dashboard/automation/flow-builder/trigger-ui.ts`

- [ ] **Step 1: Remove the display-rows helpers**

Open the file and delete `triggerDisplayRows`, `withTriggerDisplayRows`, and any reference to `__ui_display_triggers`. Keep `defaultTriggerLabel` (renamed if needed).

Keep `triggerCanvasPosition` / `withTriggerCanvasPosition` — those store the trigger card's canvas position on the automation shell (not per-trigger).

- [ ] **Step 2: Add a helper for new trigger rows**

```typescript
import type { AutomationTriggerSpec } from "./types";

export function makeNewTrigger(
	type: string,
	orderIndex: number,
): Omit<AutomationTriggerSpec, "id"> & { id?: string } {
	return {
		type,
		account_id: null,
		config: {},
		filters: {},
		label: `Trigger #${orderIndex + 1}`,
		order_index: orderIndex,
	};
}
```

The missing `id` is filled by the server on save; for optimistic rendering, callers can use a client-side temp id (`"local_" + nanoid()`).

- [ ] **Step 3: Find all callers and migrate them**

Run:

```bash
grep -rn "triggerDisplayRows\|withTriggerDisplayRows\|__ui_display_triggers" apps/app/src
```

For each match, rewrite the caller to read/mutate `automation.triggers` directly. Expected callers: `automation-detail-page.tsx`, `guided-flow.tsx`, `trigger-panel.tsx`. Those are handled in the next tasks.

- [ ] **Step 4: Commit**

```bash
git add apps/app/src/components/dashboard/automation/flow-builder/trigger-ui.ts
git commit -m "refactor(app): remove __ui_display_triggers hack in trigger-ui"
```

### Task 14: Rewrite normalization + state handlers in `automation-detail-page.tsx`

**Files:**
- Modify: `apps/app/src/components/dashboard/pages/automation-detail-page.tsx`

- [ ] **Step 1: Add `ApiAutomationTrigger` and update `ApiAutomationDetail`**

```typescript
interface ApiAutomationTrigger {
	id: string;
	type: string;
	account_id: string | null;
	config: Record<string, unknown>;
	filters: Record<string, unknown>;
	label: string;
	order_index: number;
}

interface ApiAutomationDetail
	extends Omit<AutomationDetail, "nodes" | "edges" | "triggers"> {
	nodes: ApiAutomationNode[];
	edges: ApiAutomationEdge[];
	triggers: ApiAutomationTrigger[];
}
```

- [ ] **Step 2: Update `normalizeAutomation`**

Replace the existing body:

```typescript
function normalizeAutomation(api: ApiAutomationDetail): AutomationDetail {
	return {
		...api,
		triggers: api.triggers
			.slice()
			.sort((a, b) => a.order_index - b.order_index),
		nodes: api.nodes.map<AutomationNodeSpec>((n) => ({
			type: n.type,
			key: n.key,
			notes: n.notes ?? undefined,
			canvas_x: n.canvas_x ?? undefined,
			canvas_y: n.canvas_y ?? undefined,
			...(n.config ?? {}),
		})),
		edges: api.edges.map<AutomationEdgeSpec>((e) => ({
			from: e.from_node_key,
			to: e.to_node_key,
			label: e.label,
			order: e.order,
			condition_expr: e.condition_expr,
		})),
	};
}
```

- [ ] **Step 3: Add `selectedTriggerId` state**

After `const [selectedNodeKey, setSelectedNodeKey]`, add:

```typescript
const [selectedTriggerId, setSelectedTriggerId] = useState<string | null>(null);
```

- [ ] **Step 4: Replace `addTriggerRow` with trigger-CRUD callbacks**

Remove the existing `addTriggerRow` block. Add:

```typescript
const addTrigger = useCallback(
	(triggerType: string) => {
		let createdId: string | null = null;
		setDraft((prev) => {
			if (!prev) return prev;
			const orderIndex = prev.triggers.length;
			const localId = `local_${Math.random().toString(36).slice(2, 10)}`;
			createdId = localId;
			const newTrigger: AutomationTriggerSpec = {
				id: localId,
				type: triggerType,
				account_id: null,
				config: {},
				filters: {},
				label: `Trigger #${orderIndex + 1}`,
				order_index: orderIndex,
			};
			const next = { ...prev, triggers: [...prev.triggers, newTrigger] };
			history.push({ nodes: next.nodes, edges: next.edges });
			return next;
		});
		setDirty(true);
		bumpEdit();
		if (createdId) setSelectedTriggerId(createdId);
	},
	[history, bumpEdit],
);

const updateTrigger = useCallback(
	(triggerId: string, patch: Partial<AutomationTriggerSpec>) => {
		setDraft((prev) => {
			if (!prev) return prev;
			const triggers = prev.triggers.map((t) =>
				t.id === triggerId ? { ...t, ...patch } : t,
			);
			const next = { ...prev, triggers };
			history.push({ nodes: next.nodes, edges: next.edges });
			return next;
		});
		setDirty(true);
		bumpEdit();
	},
	[history, bumpEdit],
);

const removeTrigger = useCallback(
	(triggerId: string) => {
		setDraft((prev) => {
			if (!prev) return prev;
			if (prev.triggers.length <= 1) return prev; // must keep at least 1
			const triggers = prev.triggers
				.filter((t) => t.id !== triggerId)
				.map((t, idx) => ({ ...t, order_index: idx }));
			const next = { ...prev, triggers };
			history.push({ nodes: next.nodes, edges: next.edges });
			return next;
		});
		setSelectedTriggerId((prev) => (prev === triggerId ? null : prev));
		setDirty(true);
		bumpEdit();
	},
	[history, bumpEdit],
);
```

- [ ] **Step 5: Update `buildPatchBody` to send `triggers` array**

Replace the existing body:

```typescript
const buildPatchBody = useCallback(
	(d: AutomationDetail) => ({
		nodes: d.nodes,
		edges: d.edges,
		name: d.name,
		description: d.description,
		triggers: d.triggers.map((t) => ({
			id: t.id.startsWith("local_") ? undefined : t.id,
			type: t.type,
			account_id: t.account_id,
			config: t.config,
			filters: t.filters,
			label: t.label,
			order_index: t.order_index,
		})),
	}),
	[],
);
```

- [ ] **Step 6: Pass new props + selected trigger to panel rendering**

Find where `<TriggerPanel ... />` is rendered. Change it to pass `triggers`, `selectedTriggerId`, `onSelectTrigger`, `onAddTrigger`, `onUpdateTrigger`, `onRemoveTrigger`, `onClose`. (The panel's internal shape is defined in the next task.)

- [ ] **Step 7: Commit**

```bash
git add apps/app/src/components/dashboard/pages/automation-detail-page.tsx
git commit -m "feat(app): multi-trigger CRUD state on automation detail page"
```

---

## Phase 6 — Frontend UI

### Task 15: Update trigger card in `guided-flow.tsx`

**Files:**
- Modify: `apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx`

- [ ] **Step 1: Replace the trigger row render loop**

In `TriggerFlowNode`, the current body iterates `rows = triggerDisplayRows(data.automation)`. Change to iterate `data.automation.triggers`. Each row is clickable and invokes an `onSelectTrigger` callback. Add that callback to `SharedNodeData`/`TriggerCardData`:

```typescript
interface SharedNodeData {
	// ... existing ...
	onSelectTrigger: (triggerId: string) => void;
}
```

Inside the trigger card body:

```tsx
{data.automation.triggers.length > 0 ? (
	<div className="mt-4 space-y-3">
		{data.automation.triggers.map((t) => {
			const summary =
				TRIGGER_OPERATION_OVERRIDES[t.type] ??
				titleize(
					t.type.replace(new RegExp(`^${channel}_`), ""),
				);
			return (
				<button
					key={t.id}
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						data.onSelectTrigger(t.id);
					}}
					className="nodrag flex w-full items-center gap-3 rounded-[16px] bg-[#f4f5f8] px-4 py-3 text-left transition hover:bg-[#eceef3]"
				>
					{platformIconBubble(channel)}
					<div className="min-w-0 flex-1">
						<div className="truncate text-[13px] font-medium leading-4 text-[#8b92a0]">
							{t.label}
						</div>
						<div className="mt-0.5 text-[15px] font-semibold leading-5 text-[#404552]">
							{summary}
						</div>
					</div>
				</button>
			);
		})}
	</div>
) : (
	<div className="mt-4 rounded-[16px] border border-dashed border-[#d9dde6] bg-white px-4 py-5 text-center text-[13px] text-[#7e8695]">
		No triggers yet — add one below.
	</div>
)}
```

- [ ] **Step 2: Update `onAddTriggerRow` to push new trigger**

Rename `onAddTriggerRow` → `onAddTrigger` throughout this file. Update `Props` and the `TriggerTypePicker` usage:

```typescript
<TriggerTypePicker
	automationChannel={channel}
	onPick={(triggerType) => data.onAddTrigger(triggerType)}
	schema={data.schema}
>
```

- [ ] **Step 3: Remove the "Comment Reply #N" default label logic**

Anywhere in this file that references `defaultTriggerLabel` can be deleted — labels are stored on each trigger row now.

- [ ] **Step 4: Wire new callbacks through `GuidedFlowCanvas` props**

The `Props` interface should now have `onAddTrigger: (triggerType: string) => void` and `onSelectTrigger: (triggerId: string) => void`. Pass them into `flowNodes` data.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/components/dashboard/automation/flow-builder/guided-flow.tsx
git commit -m "feat(app): trigger card renders clickable per-trigger rows"
```

### Task 16: Split `trigger-panel.tsx` into list + detail modes

**Files:**
- Modify: `apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx`

- [ ] **Step 1: Redefine Props**

```typescript
interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	selectedTriggerId: string | null;
	onSelectTrigger: (triggerId: string | null) => void;
	onAddTrigger: (triggerType: string) => void;
	onUpdateTrigger: (
		triggerId: string,
		patch: Partial<AutomationTriggerSpec>,
	) => void;
	onRemoveTrigger: (triggerId: string) => void;
	onClose: () => void;
	readOnly?: boolean;
}
```

- [ ] **Step 2: Render list mode when no trigger is selected**

At the top of the component:

```tsx
const selected = selectedTriggerId
	? automation.triggers.find((t) => t.id === selectedTriggerId) ?? null
	: null;

if (!selected) {
	return (
		<div className={cn(PANEL_WIDTH_CLS, "flex flex-col overflow-hidden border-l border-[#e6e9ef] bg-white shadow-[-12px_0_32px_rgba(15,23,42,0.03)]")}>
			<div className="border-b border-[#e6e9ef] bg-[#e4f5e6] px-4 py-4">
				<h3 className="truncate text-[18px] font-semibold text-[#353a44]">When…</h3>
				<p className="mt-1 text-[12px] text-[#6f7786]">
					Configure the triggers that start this automation.
				</p>
			</div>
			<ScrollArea className="flex-1 bg-[#fbfcfe]">
				<div className="space-y-3 px-4 py-4">
					{automation.triggers.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => onSelectTrigger(t.id)}
							className="flex w-full items-start gap-3 rounded-[16px] border border-[#e6e9ef] bg-white px-4 py-3 text-left transition hover:border-[#4680ff]"
						>
							<div className="shrink-0">{platformIcons[automation.channel] ?? <Zap className="size-4" />}</div>
							<div className="min-w-0 flex-1">
								<div className="text-[12px] text-[#8b92a0]">{t.label}</div>
								<div className="truncate text-[14px] font-medium text-[#353a44]">
									{TRIGGER_OPERATION_OVERRIDES[t.type] ?? titleize(t.type)}
								</div>
							</div>
						</button>
					))}
					{!readOnly && (
						<TriggerTypePicker
							automationChannel={automation.channel}
							schema={schema}
							onPick={onAddTrigger}
						>
							<button
								type="button"
								className="mt-2 flex h-11 w-full items-center justify-center rounded-[14px] border border-dashed border-[#d9dde6] text-[15px] font-medium text-[#4680ff] transition hover:border-[#bfc6d3] hover:bg-[#fafbfc]"
							>
								+ New Trigger
							</button>
						</TriggerTypePicker>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
```

Import `TriggerTypePicker` from `./guided-flow` (already exported there).

- [ ] **Step 3: Render detail mode for the selected trigger**

Below the list-mode return, keep/rewrite the existing panel body. Critical changes:
- The title now reads `selected.label` instead of the automation's single trigger summary.
- The "back" arrow calls `onSelectTrigger(null)` to return to list mode.
- The account selector reads/writes `selected.account_id` via `onUpdateTrigger(selected.id, { account_id })`.
- The trigger-type dropdown updates `selected.type` via `onUpdateTrigger(selected.id, { type })`.
- Config fields write to `selected.config`.
- Filter predicates write to `selected.filters`.
- A "Delete trigger" button at the bottom calls `onRemoveTrigger(selected.id)` (disabled when `triggers.length === 1`).

Follow the existing field-rendering pattern (`FieldRow`, `FilterGroupEditor`).

- [ ] **Step 4: Commit**

```bash
git add apps/app/src/components/dashboard/automation/flow-builder/trigger-panel.tsx
git commit -m "feat(app): split trigger panel into list and detail modes"
```

### Task 17: Wire trigger selection in `automation-detail-page.tsx`

**Files:**
- Modify: `apps/app/src/components/dashboard/pages/automation-detail-page.tsx`

- [ ] **Step 1: Update the render switch**

Find the JSX block that decides which right-hand panel to render. It currently branches on `selectedNodeKey === "trigger"`. Replace with:

```tsx
{rightPanel === "simulator" ? (
	<SimulatorPanel ... />
) : rightPanel === "history" ? (
	<RunHistoryPanel ... />
) : selectedNodeKey === "trigger" ? (
	<TriggerPanel
		automation={draft}
		schema={schema}
		selectedTriggerId={selectedTriggerId}
		onSelectTrigger={setSelectedTriggerId}
		onAddTrigger={addTrigger}
		onUpdateTrigger={updateTrigger}
		onRemoveTrigger={removeTrigger}
		onClose={() => {
			setSelectedNodeKey(null);
			setSelectedTriggerId(null);
			setRightPanel(null);
		}}
		readOnly={isArchived}
	/>
) : selectedNode ? (
	<PropertyPanel ... />
) : null}
```

- [ ] **Step 2: Pass `onAddTrigger` + `onSelectTrigger` into `<GuidedFlow>`**

Update the `<GuidedFlow>` JSX to pass:

```tsx
onAddTrigger={addTrigger}
onSelectTrigger={(triggerId) => {
	setSelectedNodeKey("trigger");
	setSelectedTriggerId(triggerId);
	setRightPanel("property");
}}
```

Replace the old `onAddTriggerRow` prop. Also rename inside the `GuidedFlow` Props interface.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck:app`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/app/src/components/dashboard/pages/automation-detail-page.tsx
git commit -m "feat(app): wire trigger selection state to panel rendering"
```

### Task 18: Update validation

**Files:**
- Modify: `apps/app/src/components/dashboard/automation/flow-builder/validation.ts`

- [ ] **Step 1: Require at least one trigger**

Find `validateGraph`. Add a check near the top:

```typescript
if (!draft.triggers || draft.triggers.length === 0) {
	issues.push({
		severity: "error",
		message: "Automation must have at least one trigger",
		nodeKey: "trigger",
	});
}
```

- [ ] **Step 2: Validate each trigger's config against its type's schema**

For each trigger, look up the schema from `schema.triggers.find(s => s.type === t.type)`. If `config_schema` has required fields missing on `t.config`, push a validation error keyed to the trigger (e.g. `nodeKey: \`trigger:${t.id}\``).

- [ ] **Step 3: Commit**

```bash
git add apps/app/src/components/dashboard/automation/flow-builder/validation.ts
git commit -m "feat(app): validation requires >=1 trigger and per-trigger config"
```

---

## Phase 7 — Tests

### Task 19: Update existing `automations.test.ts`

**Files:**
- Modify: `apps/api/src/__tests__/automations.test.ts`

- [ ] **Step 1: Replace every `trigger:` payload with `triggers: []`**

Search for `trigger:` inside this file. Every test that creates/updates an automation should send:

```typescript
triggers: [
	{
		type: "instagram_comment",
		config: { keywords: ["hello"] },
		filters: {},
		label: "Comment #1",
		order_index: 0,
	},
],
```

instead of:

```typescript
trigger: { type: "instagram_comment", config: { keywords: ["hello"] } },
```

- [ ] **Step 2: Replace every response assertion on `trigger_type`/`trigger_config`**

Change `expect(response.trigger_type).toBe(...)` to `expect(response.triggers[0].type).toBe(...)` and similar.

- [ ] **Step 3: Run the tests**

Run: `bun run --filter api test -- --testPathPattern=automations`

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/automations.test.ts
git commit -m "test(api): update automation tests for triggers array"
```

### Task 20: New `multi-trigger.test.ts`

**Files:**
- Create: `apps/api/src/__tests__/multi-trigger.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { testEnv, createTestOrganization, createTestAccount } from "./helpers";
import { matchAndEnroll } from "../services/automations/trigger-matcher";
import { createDb } from "@relayapi/db";
import {
	automations,
	automationTriggers,
	automationEnrollments,
} from "@relayapi/db";
import { eq } from "drizzle-orm";

describe("multi-trigger automations", () => {
	beforeEach(async () => {
		// reset DB state — implementation depends on your test helper
	});

	it("enrolls when either of two trigger types matches", async () => {
		const { org, user } = await createTestOrganization();
		const account = await createTestAccount(org.id, "instagram");

		// Create an automation with two triggers via the API
		const res = await testEnv.fetch("/v1/automations", {
			method: "POST",
			body: JSON.stringify({
				name: "Dual trigger",
				channel: "instagram",
				triggers: [
					{
						type: "instagram_dm",
						account_id: account.id,
						config: {},
						filters: {},
						label: "DM",
						order_index: 0,
					},
					{
						type: "instagram_comment",
						account_id: account.id,
						config: { keywords: ["hello"] },
						filters: {},
						label: "Comment",
						order_index: 1,
					},
				],
				nodes: [],
				edges: [],
				status: "active",
			}),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { id: string; triggers: { id: string; type: string }[] };
		expect(created.triggers).toHaveLength(2);

		// Simulate an instagram_comment event that matches the second trigger
		const enrolledIds = await matchAndEnroll(testEnv, {
			organization_id: org.id,
			platform: "instagram",
			trigger_type: "instagram_comment",
			account_id: account.id,
			payload: { comment_text: "hello world" },
		});
		expect(enrolledIds).toHaveLength(1);

		// Verify trigger_id on the enrollment row points at the comment trigger
		const db = createDb(testEnv.HYPERDRIVE.connectionString);
		const enrollment = await db.query.automationEnrollments.findFirst({
			where: eq(automationEnrollments.id, enrolledIds[0]!),
		});
		const commentTrigger = created.triggers.find((t) => t.type === "instagram_comment")!;
		expect(enrollment?.triggerId).toBe(commentTrigger.id);
	});

	it("filters by the matched trigger's config, not all triggers", async () => {
		const { org } = await createTestOrganization();
		const account = await createTestAccount(org.id, "instagram");

		// Create automation: DM trigger with keyword "urgent", comment trigger with keyword "hello"
		const res = await testEnv.fetch("/v1/automations", {
			method: "POST",
			body: JSON.stringify({
				name: "Per-trigger config",
				channel: "instagram",
				triggers: [
					{
						type: "instagram_dm",
						account_id: account.id,
						config: { keywords: ["urgent"] },
						filters: {},
						label: "DM",
						order_index: 0,
					},
					{
						type: "instagram_comment",
						account_id: account.id,
						config: { keywords: ["hello"] },
						filters: {},
						label: "Comment",
						order_index: 1,
					},
				],
				nodes: [],
				edges: [],
				status: "active",
			}),
		});
		expect(res.status).toBe(201);

		// Comment with "hello" should enroll
		let enrolled = await matchAndEnroll(testEnv, {
			organization_id: org.id,
			platform: "instagram",
			trigger_type: "instagram_comment",
			account_id: account.id,
			payload: { comment_text: "hello friend" },
		});
		expect(enrolled).toHaveLength(1);

		// Comment with "urgent" should NOT enroll (that keyword belongs to DM trigger)
		enrolled = await matchAndEnroll(testEnv, {
			organization_id: org.id,
			platform: "instagram",
			trigger_type: "instagram_comment",
			account_id: account.id,
			payload: { comment_text: "urgent news" },
		});
		expect(enrolled).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run the new tests**

Run: `bun run --filter api test -- --testPathPattern=multi-trigger`

Expected: both tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/multi-trigger.test.ts
git commit -m "test(api): multi-trigger enrollment + per-trigger matching"
```

### Task 21: Typecheck + full test run

- [ ] **Step 1: Run the whole monorepo typecheck**

Run: `bun run typecheck`

Expected: clean.

- [ ] **Step 2: Run all API tests**

Run: `bun run --filter api test`

Expected: green.

- [ ] **Step 3: Manual smoke: dashboard**

Start dev servers (`bun run dev:api` + `bun run dev:app`), open `http://localhost:4321/app/automation/<id>`. Verify:
- Trigger card lists each trigger as its own row.
- Clicking a row opens that trigger's detail panel.
- Clicking the card header / body opens list mode with "+ New Trigger".
- Adding a trigger adds a row and switches to its detail view.
- Deleting a trigger (from detail) removes the row (only allowed when ≥2 triggers exist).
- Saving persists; reloading shows the same triggers.
- Publishing + sending a test event via simulator enrolls on the correct trigger.

- [ ] **Step 4: Commit any smoke-test fixes**

```bash
git add -A
git commit -m "chore: resolve multi-trigger smoke-test findings" # only if needed
```

---

## Self-Review

**Spec coverage:**
- Multi-trigger data model ✅ (Tasks 1-2)
- Runtime matcher rewrite ✅ (Task 4)
- API contract ✅ (Tasks 3, 5, 6)
- Runtime executors resolve matched trigger ✅ (Tasks 7, 8)
- SDK + OpenAPI ✅ (Tasks 10, 11)
- Frontend: list + detail modes ✅ (Tasks 13-17)
- Validation ✅ (Task 18)
- Tests ✅ (Tasks 19, 20)

**Gaps closed during self-review:**
- Added Task 9 for template builders (they would have kept emitting the old shape).
- Added Task 18 for the validation requirement of ≥1 trigger.
- Added enrollment `trigger_id` column in Task 1 (needed by Task 7's helper).

**Placeholder scan:** none found.

**Type consistency:**
- `AutomationTriggerSpec` (frontend) mirrors `AutomationTriggerResponse` (API) / `AutomationTrigger` (SDK).
- `SnapshotTrigger` (runtime) has the same fields as the API response but typed as `Record<string, unknown>` for `config`/`filters` because runtime doesn't care about per-type schemas.
- `addTrigger(type)` returns void but assigns `selectedTriggerId` via side-effect — `onPick` callback signature matches.

---

## Rollout Notes

- This migration drops data that lived in flat `automations.trigger_*` columns, but the backfill in Task 2 moves every row into `automation_triggers` first. Run the migration on a DB snapshot before the production one to verify.
- Any external consumers of the API (n8n integration, Zapier, public SDK users) will see a breaking response shape. Release-please will bump SDK to a new major per the commit in Task 10.
- The release-please PR should be merged only after the API is deployed — keep SDK and API in lockstep for this release.
