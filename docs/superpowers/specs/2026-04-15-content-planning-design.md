# Content Planning Feature — Design Spec

**Date:** 2026-04-15
**Status:** Approved

## Overview

Add a content planning/ideation system to RelayAPI, inspired by Buffer's "Create" feature. Ideas are lightweight, channel-agnostic content cards organized on customizable kanban boards. When ready, an idea converts seamlessly into a scheduled post.

This is a full collaboration feature: ideas support assignments, threaded comments, tags, media, and an activity audit log.

## Architecture Decision

**Separate `ideas` resource** (not an extension of posts). Reasons:

- Posts require `targets` (platform accounts) and scheduling config. Ideas are channel-agnostic and friction-free.
- Follows existing separation-of-concerns pattern (content templates, queue schedules are already separate from posts).
- Keeps the 3,500-line posts route from growing further.
- SDK clarity: `client.ideas.create()` is immediately understandable.
- Conversion path: `idea_id` on `POST /v1/posts` follows the same pattern as `template_id`.

## Data Model

### `idea_groups` (kanban columns)

| Column         | Type        | Notes                                |
| -------------- | ----------- | ------------------------------------ |
| `id`           | `text`      | `idg_` prefix, nanoid                |
| `name`         | `text`      | e.g. "Brainstorm", "Ready to post"   |
| `position`     | `real`      | Float for drag-and-drop ordering     |
| `color`        | `text`      | Optional hex color for column header |
| `workspace_id` | `text`      | FK → workspaces                      |
| `org_id`       | `text`      | FK → organizations                   |
| `created_at`   | `timestamp` |                                      |
| `updated_at`   | `timestamp` |                                      |

- Each workspace gets a default "Unassigned" group on first use.
- The default group cannot be deleted.

### `ideas` (content cards)

| Column                 | Type        | Notes                                                                                  |
| ---------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `id`                   | `text`      | `idea_` prefix, nanoid                                                                 |
| `title`                | `text`      | Optional short title for the card                                                      |
| `content`              | `text`      | The actual content/copy                                                                |
| `group_id`             | `text`      | FK → idea_groups                                                                       |
| `position`             | `real`      | Float for ordering within group                                                        |
| `assigned_to`          | `text`      | FK → auth.users (nullable)                                                             |
| `converted_to_post_id` | `text`      | FK → posts (nullable, set to the most recent conversion). Multiple conversions allowed |
| `workspace_id`         | `text`      | FK → workspaces                                                                        |
| `org_id`               | `text`      | FK → organizations                                                                     |
| `created_at`           | `timestamp` |                                                                                        |
| `updated_at`           | `timestamp` |                                                                                        |

### `idea_media` (attachments)

| Column     | Type      | Notes                               |
| ---------- | --------- | ----------------------------------- |
| `id`       | `text`    | `idm_` prefix, nanoid               |
| `idea_id`  | `text`    | FK → ideas                          |
| `url`      | `text`    | R2 URL or external URL              |
| `type`     | `enum`    | `image`, `video`, `gif`, `document` |
| `alt`      | `text`    | Alt text (nullable)                 |
| `position` | `integer` | Ordering                            |

- **Max file size: 2MB per file** (enforced at API upload level).

### `idea_comments` (threaded discussion)

| Column       | Type        | Notes                                                 |
| ------------ | ----------- | ----------------------------------------------------- |
| `id`         | `text`      | `idc_` prefix, nanoid                                 |
| `idea_id`    | `text`      | FK → ideas                                            |
| `author_id`  | `text`      | FK → auth.users                                       |
| `content`    | `text`      | Comment body                                          |
| `parent_id`  | `text`      | FK → idea_comments (nullable, one level of threading) |
| `created_at` | `timestamp` |                                                       |
| `updated_at` | `timestamp` |                                                       |

- One level of threading only (replies to comments, not replies to replies).

### `idea_tags` (junction table)

| Column    | Type   | Notes      |
| --------- | ------ | ---------- |
| `idea_id` | `text` | FK → ideas |
| `tag_id`  | `text` | FK → tags  |

- Composite primary key on (idea_id, tag_id).

### `tags` (shared across ideas and posts)

| Column         | Type        | Notes                      |
| -------------- | ----------- | -------------------------- |
| `id`           | `text`      | `tag_` prefix, nanoid      |
| `name`         | `text`      |                            |
| `color`        | `text`      | Hex color (e.g. "#F523F1") |
| `workspace_id` | `text`      | FK → workspaces            |
| `org_id`       | `text`      | FK → organizations         |
| `created_at`   | `timestamp` |                            |

- Tags are shared between ideas and posts.
- Posts will need a `post_tags` junction table added.

### `idea_activity` (audit log)

| Column       | Type        | Notes                                                                                                                     |
| ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `text`      | `ida_` prefix, nanoid                                                                                                     |
| `idea_id`    | `text`      | FK → ideas                                                                                                                |
| `actor_id`   | `text`      | FK → auth.users                                                                                                           |
| `action`     | `enum`      | `created`, `moved`, `assigned`, `commented`, `converted`, `updated`, `media_added`, `media_removed`, `tagged`, `untagged` |
| `metadata`   | `jsonb`     | Context (e.g. `{ from_group: "idg_x", to_group: "idg_y" }`)                                                               |
| `created_at` | `timestamp` |                                                                                                                           |

- Read-only. Generated automatically by the API on every mutation.

### Key design decisions

- **Float positions**: Inserting between items uses `(posA + posB) / 2`. No reindexing on drag-and-drop. Periodic rebalancing only when floats get too close (after ~50 consecutive inserts in the same gap).
- **Tags are shared**: Same `tags` table for ideas and posts. Filter "show me everything tagged #product-launch" across both.
- **Media is separate from post media**: Idea media lives in R2 with a 2MB limit. On conversion, media gets copied/referenced into the post's media.
- **Soft reference on conversion**: `converted_to_post_id` stores the most recent conversion. Multiple conversions from the same idea are allowed (e.g. same idea posted to different platform sets). The idea stays on the board. The post is independent.

## API Endpoints

All endpoints under `/v1/`. Follow existing patterns: cursor-based pagination, optional `workspace_id` filter, nanoid resource IDs, Zod-OpenAPI schemas.

### Ideas

| Method   | Endpoint                 | Description                                                                                          |
| -------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `POST`   | `/v1/ideas`              | Create idea (content, title, group_id, tags, assigned_to, media)                                     |
| `GET`    | `/v1/ideas`              | List ideas (filter by group_id, tag_id, assigned_to, workspace_id)                                   |
| `GET`    | `/v1/ideas/{id}`         | Get single idea (includes media, tags, assigned_to)                                                  |
| `PATCH`  | `/v1/ideas/{id}`         | Update idea (content, title, assigned_to)                                                            |
| `DELETE` | `/v1/ideas/{id}`         | Delete idea + its media, comments, activity                                                          |
| `POST`   | `/v1/ideas/{id}/move`    | Move to different group and/or reorder (accepts group_id, position or after_idea_id)                 |
| `POST`   | `/v1/ideas/{id}/convert` | Convert to post. Accepts targets, scheduled_at, etc. Sets converted_to_post_id. Returns created post |

- `/move` is separate from `PATCH` because moving is a distinct action with activity logging ("moved from X to Y").
- `/convert` is a convenience endpoint. `POST /v1/posts` with `idea_id` also works (same underlying logic).

### Idea Media

| Method   | Endpoint                          | Description                                                  |
| -------- | --------------------------------- | ------------------------------------------------------------ |
| `POST`   | `/v1/ideas/{id}/media`            | Upload media (max 2MB per file; image, video, gif, document) |
| `DELETE` | `/v1/ideas/{id}/media/{media_id}` | Remove media from idea                                       |

### Idea Comments

| Method   | Endpoint                               | Description                                           |
| -------- | -------------------------------------- | ----------------------------------------------------- |
| `GET`    | `/v1/ideas/{id}/comments`              | List comments (threaded, cursor pagination)           |
| `POST`   | `/v1/ideas/{id}/comments`              | Add comment (content, optional parent_id for replies) |
| `PATCH`  | `/v1/ideas/{id}/comments/{comment_id}` | Edit own comment                                      |
| `DELETE` | `/v1/ideas/{id}/comments/{comment_id}` | Delete own comment                                    |

### Idea Groups (kanban columns)

| Method   | Endpoint                  | Description                                         |
| -------- | ------------------------- | --------------------------------------------------- |
| `GET`    | `/v1/idea-groups`         | List all groups for workspace (ordered by position) |
| `POST`   | `/v1/idea-groups`         | Create group (name, color, position)                |
| `PATCH`  | `/v1/idea-groups/{id}`    | Update group (name, color)                          |
| `DELETE` | `/v1/idea-groups/{id}`    | Delete group. Ideas move to "Unassigned"            |
| `POST`   | `/v1/idea-groups/reorder` | Bulk reorder (array of { id, position })            |

- The default "Unassigned" group cannot be deleted.

### Tags (shared resource)

| Method   | Endpoint        | Description                               |
| -------- | --------------- | ----------------------------------------- |
| `GET`    | `/v1/tags`      | List all tags for workspace               |
| `POST`   | `/v1/tags`      | Create tag (name, color)                  |
| `PATCH`  | `/v1/tags/{id}` | Update tag                                |
| `DELETE` | `/v1/tags/{id}` | Delete tag (removes from all ideas/posts) |

### Activity

| Method | Endpoint                  | Description                                     |
| ------ | ------------------------- | ----------------------------------------------- |
| `GET`  | `/v1/ideas/{id}/activity` | Activity log (cursor pagination, chronological) |

- Read-only. No write endpoint.

## Conversion Flow: Idea to Post

Two equivalent paths:

### Path A: `POST /v1/ideas/{id}/convert`

```json
{
  "targets": [{ "account_id": "acc_xxx" }],
  "scheduled_at": "2026-04-20T10:00:00Z",
  "timezone": "Europe/Rome"
}
```

### Path B: `POST /v1/posts` with `idea_id`

```json
{
  "idea_id": "idea_xxx",
  "targets": [{ "account_id": "acc_xxx" }],
  "scheduled_at": "2026-04-20T10:00:00Z",
  "timezone": "Europe/Rome"
}
```

Both do the same thing:
1. Create a new post, pre-filling `content` and `media` from the idea.
2. Set `converted_to_post_id` on the idea.
3. Log `converted` activity with `{ post_id }` metadata.
4. The idea remains on the board (user can archive/move to "Done" column).
5. Content and media on the post are independent copies — editing the post doesn't change the idea.

If `content` or `media` are also provided in the request body, they override the idea's values.

## SDK Resources

Following existing patterns in `packages/sdk/src/resources/`:

```typescript
// Ideas
client.ideas.create({ title, content, group_id, tags, assigned_to, workspace_id })
client.ideas.retrieve('idea_xxx')
client.ideas.update('idea_xxx', { title, content, assigned_to })
client.ideas.list({ group_id, tag_id, assigned_to, workspace_id })
client.ideas.delete('idea_xxx')
client.ideas.move('idea_xxx', { group_id, position })
client.ideas.convert('idea_xxx', { targets, scheduled_at, ... })

// Idea Media (sub-resource)
client.ideas.media.upload('idea_xxx', file)
client.ideas.media.delete('idea_xxx', 'idm_xxx')

// Idea Comments (sub-resource)
client.ideas.comments.list('idea_xxx')
client.ideas.comments.create('idea_xxx', { content, parent_id })
client.ideas.comments.update('idea_xxx', 'idc_xxx', { content })
client.ideas.comments.delete('idea_xxx', 'idc_xxx')

// Idea Activity (sub-resource)
client.ideas.activity.list('idea_xxx')

// Idea Groups
client.ideaGroups.create({ name, color, workspace_id })
client.ideaGroups.list({ workspace_id })
client.ideaGroups.update('idg_xxx', { name, color })
client.ideaGroups.delete('idg_xxx')
client.ideaGroups.reorder([{ id: 'idg_xxx', position: 1.0 }, ...])

// Tags (shared)
client.tags.create({ name, color, workspace_id })
client.tags.list({ workspace_id })
client.tags.update('tag_xxx', { name, color })
client.tags.delete('tag_xxx')

// Existing post creation gains idea_id
client.posts.create({ idea_id: 'idea_xxx', targets, scheduled_at })
```

## Docs Updates

- **New guide: "Content Planning"** — Explains ideas → post workflow, kanban boards, tags, collaboration.
- **API reference pages** for: Ideas, Idea Groups, Tags, Idea Comments, Idea Activity.
- **Updated "Create a Post" guide** — Add `idea_id` parameter and conversion flow.
- **SDK reference** — Generated from TypeScript types.

## Error Handling

Follows existing RelayAPI pattern: `{ error: { code, message, details? } }`.

| Scenario               | Code                            | Message                                                                                                                                  |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Idea not found         | `idea_not_found`                | "Idea not found"                                                                                                                         |
| Group not found        | `idea_group_not_found`          | "Idea group not found"                                                                                                                   |
| Delete default group   | `CANNOT_DELETE_DEFAULT_GROUP`   | "The default group cannot be deleted"                                                                                                    |
| Media too large        | `FILE_TOO_LARGE`               | "Max upload size is 2MB"                                                                                                                 |
| Idea already converted | —                             | Not an error. Multiple conversions allowed (same idea → different platform sets or times). `converted_to_post_id` updated to most recent |
| Comment not owned      | `FORBIDDEN`                   | "You can only edit your own comments"                                                                                                    |
| Tag not found          | `tag_not_found`               | "Tag not found"                                                                                                                          |

## Out of Scope (future work)

- Dashboard UI (kanban board, calendar integration) — separate feature spec.
- AI-generated idea suggestions (like Loomly's auto-suggestions).
- Bulk idea operations (bulk move, bulk convert, bulk delete).
- Idea templates.
- Webhook events for idea lifecycle changes.
- Approval workflow baked into the data model (users can model this with custom groups).
