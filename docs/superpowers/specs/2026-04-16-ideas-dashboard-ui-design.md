# Ideas Dashboard UI — Design Spec

**Date:** 2026-04-16
**Status:** Approved
**Depends on:** `2026-04-15-content-planning-design.md` (API/DB layer — implemented)

## Overview

Add an "Ideas" page to the Astro dashboard at `/app/ideas`. A full-width kanban board where users organize content ideas in customizable columns, with drag-and-drop reordering, a detail dialog for editing, comments, media, and one-click conversion to posts.

## Navigation

Top-level sidebar item called "Ideas" with a Lightbulb icon, placed **before** "Posts" in the `navItems` array. No children — single page.

```typescript
{ label: "Ideas", icon: Lightbulb, href: "ideas" },
```

## Page Structure

### File Architecture

Following the existing lazy-loading pattern:

```
src/pages/app/ideas.astro                          → Astro route
src/components/dashboard/route-apps/ideas-route-app.tsx  → lazy wrapper
src/components/dashboard/pages/ideas-page.tsx       → page component (board)
src/components/dashboard/ideas/                     → feature components
  idea-board.tsx          → kanban board container
  idea-column.tsx         → single kanban column
  idea-card.tsx           → card component
  idea-detail-dialog.tsx  → detail/edit dialog
  idea-create-dialog.tsx  → reuses detail dialog in create mode
  group-create-inline.tsx → inline new-group form
src/components/dashboard/settings/                  → settings tab components
  tags-settings.tsx       → tags CRUD management
```

### Page Layout

```
┌─────────────────────────────────────────────────────────┐
│  Ideas                          [+ New Idea]  [Filter ▾]│
├─────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
│ │Unassigned│ │ Writing  │ │ Ready    │ │ + New Group │ │
│ │    3     │ │    1     │ │    2     │ │             │ │
│ ├──────────┤ ├──────────┤ ├──────────┤ │             │ │
│ │ ┌──────┐ │ │ ┌──────┐ │ │ ┌──────┐ │ │             │ │
│ │ │Card 1│ │ │ │Card 4│ │ │ │Card 5│ │ │             │ │
│ │ └──────┘ │ │ └──────┘ │ │ └──────┘ │ │             │ │
│ │ ┌──────┐ │ │          │ │ ┌──────┐ │ │             │ │
│ │ │Card 2│ │ │+ New Idea│ │ │Card 6│ │ │             │ │
│ │ └──────┘ │ │          │ │ └──────┘ │ │             │ │
│ │ ┌──────┐ │ │          │ │          │ │             │ │
│ │ │Card 3│ │ │          │ │+ New Idea│ │             │ │
│ │ └──────┘ │ │          │ │          │ │             │ │
│ │+ New Idea│ │          │ │          │ │             │ │
│ └──────────┘ └──────────┘ └──────────┘ └─────────────┘ │
└─────────────────────────────────────────────────────────┘
```

- **Header**: page title, "+ New Idea" button (opens create dialog), filter controls
- **Board**: horizontally scrollable columns. Each column is a group with a card count badge.
- **"+ New Group"**: always the last column — inline form to add a new group
- **"+ New Idea"**: bottom of each column, opens the create dialog with that group pre-selected

## Idea Card

Compact preview shown in kanban columns:

```
┌────────────────────────┐
│ Product launch post    │  ← title (bold, truncated 2 lines)
│ Draft copy for the     │  ← content preview (muted, truncated 2 lines)
│ summer campaign...     │
│                        │
│ 🟣 Campaign  🔵 Q3    │  ← tag chips (colored dot + name, max 3 then +N)
│                        │
│ 📎 2   💬 3      [AV] │  ← media count, comment count, assignee avatar
└────────────────────────┘
```

- **Title**: bold, up to 2 lines with ellipsis. Falls back to first line of content if no title.
- **Content preview**: `text-muted-foreground`, 2 lines max.
- **Tags**: small colored chips. Show up to 3, then "+N" overflow badge.
- **Bottom row**: paperclip icon + media count, chat icon + comment count, assignee initials avatar on the right.
- **Converted indicator**: if `converted_to_post_id` is set, a small checkmark badge on the card.
- **Click**: opens the detail dialog.
- **Animation**: `fadeUp` stagger animation when the board loads (matching existing dashboard patterns).
- **Drag**: entire card is draggable (no visible handle).

## Idea Detail Dialog

Single-column dialog matching the existing post dialog conventions (`max-w-2xl`, `max-h-[90vh]`, flex column, `p-0 gap-0`).

Used for both creating and editing ideas.

```
┌───────────────────────────────────────────────┐
│  Edit Idea              [Unassigned ▾] [Tags ▾]  ✕  │
├───────────────────────────────────────────────┤
│                                               │ ← scrollable
│  ┌───────────────────────────────────────┐   │
│  │ Educational content ideas             │   │ ← title input
│  └───────────────────────────────────────┘   │
│                                               │
│  ┌───────────────────────────────────────┐   │
│  │ 5 things I would never do as a        │   │ ← content textarea
│  │ dentist, eg use manual toothbrush...  │   │    (auto-resize)
│  │                                       │   │
│  │ Brush or floss first? Why?            │   │
│  │                                       │   │
│  │ 5 dental myths that are completely    │   │
│  │ wrong, whitening damages your teeth   │   │
│  └───────────────────────────────────────┘   │
│                                               │
│  ┌─────┐ ┌─────┐  [Drop or click to add]    │ ← media thumbnails
│  │img 1│ │img 2│                             │
│  └─────┘ └─────┘                             │
│                                               │
│  ── 💬 3 Comments ────────────────────────   │ ← comments section
│  AV  Great copy for this!        · 2h ago    │
│   └ AV  Thanks!                  · 1h ago    │
│                                               │
│  [Write a comment...]                        │
│                                               │
├───────────────────────────────────────────────┤
│  [☰ Activity]                                │ ← footer
│                     [Convert to Post] [Save] │
└───────────────────────────────────────────────┘
```

### Header
- Title: "New Idea" or "Edit Idea"
- Inline controls: group selector dropdown, tags multi-select dropdown, assignee dropdown
- Close button

### Scrollable Content
- **Title input**: text field, placeholder "Add a title..."
- **Content textarea**: auto-resizing textarea, placeholder "Write your idea..."
- **Media area**: thumbnail grid of attached media. "Drop or click to add" zone. 2MB per file limit. Click thumbnail to preview, hover shows delete button.
- **Comments section**: header shows comment count. Threaded list (replies indented one level). Text input at bottom, submit on Enter (Shift+Enter for newline).

### Footer
- **Left**: "Activity" toggle — opens a collapsible list of recent activity entries inline above the footer
- **Right**: "Convert to Post" (secondary/outline button) and "Save" (primary button)

### Convert to Post Flow
- Click "Convert to Post" in the detail dialog
- Opens the existing `NewPostDialog` pre-filled with the idea's title + content and media
- User selects targets, scheduling in the familiar post creation flow
- On post creation, the API sets `converted_to_post_id` on the idea
- The idea card shows a checkmark badge

### Create Mode
- Both the header "+ New Idea" button and the column "+ New Idea" button open this same dialog
- Column button pre-selects that group in the group dropdown
- Header button defaults to "Unassigned" group
- Title says "New Idea", "Save" button says "Create"

## Drag and Drop

**Library:** `@dnd-kit/core` + `@dnd-kit/sortable`

### Card Drag
- Grab anywhere on the card to start dragging
- While dragging: card becomes semi-transparent at origin, a shadow clone follows the cursor
- Drop targets: any position within any column. A thin horizontal line indicator shows the insertion point.
- On drop: call `POST /v1/ideas/{id}/move` with `group_id` and `after_idea_id`

### Column Drag
- Grab the column header to start dragging
- Columns slide horizontally to make room
- On drop: call `POST /v1/idea-groups/reorder` with new positions

### Optimistic Updates
- Move the card/column in the UI immediately on drop
- Fire the API call in the background
- If the API call fails, revert the UI change and show a toast error

## Group Management

### Column Header
```
┌──────────────────────────┐
│ 🟣 Writing    3    [⋮]  │  ← color dot, name, count, kebab menu
├──────────────────────────┤
```

### Adding a Group
- "+ New Group" button is always the last column
- Clicking replaces it with an inline form: text input + color picker
- Enter to create, Escape to cancel
- Calls `POST /v1/idea-groups`

### Editing a Group
- Click group name in column header → inline edit
- Kebab menu "..." offers: Edit Color, Delete Group

### Deleting a Group
- Confirmation dialog: "Delete this group? X ideas will be moved to Unassigned."
- Calls `DELETE /v1/idea-groups/{id}`, API handles moving ideas to default group
- The default "Unassigned" group cannot be deleted (menu option hidden/disabled)

## Filtering

### Filter Stack
- **Organization**: automatic via auth (invisible to user)
- **Workspace**: global sidebar filter via `FilterContext` (shared with all pages)
- **Tag**: page-level dropdown multi-select in the header. Colored dots next to tag names. Filters cards across all columns.
- **Assigned to**: page-level dropdown in the header. Shows org members with avatars.

When filters are active, a small "Clear filters" link appears. Cards that don't match filters are hidden. Columns that end up empty show a muted "No ideas match filters" placeholder.

## Empty States

### First Visit (no groups yet)
```
┌──────────────────────────────────────────┐
│                                          │
│     💡                                   │
│     Plan your content                    │
│     Create your first idea to get        │
│     started with content planning.       │
│                                          │
│     [+ New Idea]                         │
│                                          │
└──────────────────────────────────────────┘
```
Clicking "+ New Idea" auto-creates the default "Unassigned" group (via the API's `ensureDefaultGroup`) and opens the create dialog.

### Empty Column
```
┌──────────────┐
│ 🟣 Writing  0│
├──────────────┤
│              │
│  No ideas    │  ← dashed border, muted text (matches existing empty states)
│              │
│ [+ New Idea] │
└──────────────┘
```

## Data Flow

### Initial Load
1. Page mounts → `usePaginatedApi("idea-groups", { query: filterQuery })` fetches groups
2. For each group → `usePaginatedApi("ideas", { query: { group_id, ...filterQuery } })` fetches ideas
3. Tags fetched once → `usePaginatedApi("tags", { query: filterQuery })` for filter dropdown and card display

### Real-time
- Use `useRealtimeUpdates` hook to listen for idea changes (if WebSocket events are added for ideas in the future). For v1, rely on optimistic updates and refetch after mutations.

### Mutations
All mutations use `useMutation` hook or direct `fetch()` calls:
- Create idea → `POST /v1/ideas` → optimistic add to column, refetch
- Update idea → `PATCH /v1/ideas/{id}` → optimistic update, refetch
- Delete idea → `DELETE /v1/ideas/{id}` → optimistic remove, refetch
- Move idea → `POST /v1/ideas/{id}/move` → optimistic move, refetch on failure
- Convert → `POST /v1/ideas/{id}/convert` → update card badge
- Media upload → `POST /v1/ideas/{id}/media` → append to media grid
- Comments → `POST/PATCH/DELETE /v1/ideas/{id}/comments/*` → refetch comments

## Dependencies

### New Package
- `@dnd-kit/core` + `@dnd-kit/sortable` — install in `apps/app` (not root)

### Existing Components Reused
- `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle` from `ui/dialog`
- `Button` from `ui/button`
- `Select` from `ui/select`
- `Popover` from `ui/popover`
- `ScrollArea` from `ui/scroll-area`
- `DropdownMenu` from `ui/dropdown-menu`
- `LoadMore` from `ui/load-more`
- `FilterBar` from `dashboard/filter-bar`
- `NewPostDialog` from `dashboard/new-post-dialog` (for Convert to Post flow)
- `motion` animations (stagger + fadeUp patterns)

## Settings Page Restructure

The current settings page is a 1,278-line vertical stack of card sections with no organization. Restructure it into tabs to make room for Tags management and improve readability.

### Tab Layout

```
┌─────────────────────────────────────────────────────┐
│  Settings                                           │
│                                                     │
│  [General]  [Notifications]  [Short Links]  [Tags]  │
│  ─────────────────────────────────────────────────  │
│                                                     │
│  (tab content)                                      │
│                                                     │
└─────────────────────────────────────────────────────┘
```

Uses the same tab pattern as Posts and Media pages: underline style, URL sync via `?tab=`, `useState`.

### Tabs

- **General** — Organization Profile + Signatures + Organization Settings + Danger Zone
- **Notifications** — Notification preferences grid (existing, moved into tab)
- **Short Links** — URL shortening config (existing, moved into tab)
- **Tags** — New: tags CRUD management

### File Changes

- Modify: `src/components/dashboard/pages/settings-page.tsx` — add tab state, wrap existing sections into tab panels
- Modify: `src/pages/app/settings.astro` — pass `initialTab` prop
- Create: `src/components/dashboard/settings/tags-settings.tsx` — tags management component

### Tags Tab

```
┌─────────────────────────────────────────────────────┐
│  Tags                                  [+ New Tag]  │
│                                                     │
│  Tags are shared across ideas and posts.            │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │ 🟣 Campaign          [Edit] [Delete]        │   │
│  │ 🔵 Q3 2026           [Edit] [Delete]        │   │
│  │ 🟢 Product Launch    [Edit] [Delete]        │   │
│  │ 🟠 Evergreen         [Edit] [Delete]        │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

- Simple list with colored dot, name, edit and delete actions
- "+ New Tag" opens a small inline form: name input + color picker (hex presets or custom)
- **Edit**: click Edit to make name/color editable inline. Save on blur or Enter.
- **Delete**: confirmation dialog — "This tag will be removed from all ideas and posts."
- Workspace-scoped (follows the global workspace filter)
- Data: `usePaginatedApi("tags", { query: filterQuery })` for the list, `useMutation` for create/update/delete

## Out of Scope
- Bulk operations (select multiple cards, bulk move/delete/convert)
- Keyboard shortcuts for board navigation
- Board view preferences persistence (column widths, collapsed columns)
- WebSocket real-time events for idea mutations (v1 uses optimistic updates)
