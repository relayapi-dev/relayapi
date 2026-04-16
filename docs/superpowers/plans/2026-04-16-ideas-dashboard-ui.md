# Ideas Dashboard UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Ideas kanban board page to the dashboard and restructure the Settings page into tabs with a Tags management tab.

**Architecture:** Astro page + React 19 island with lazy loading. Kanban board uses @dnd-kit (already installed). All data via custom hooks (usePaginatedApi, useMutation). Follows existing dashboard patterns: motion animations, shadcn/ui components, workspace filtering.

**Tech Stack:** Astro 6, React 19, @dnd-kit/core + @dnd-kit/sortable, motion/react, shadcn/ui (Dialog, Button, Select, DropdownMenu, Popover), Tailwind CSS 4, lucide-react.

**Spec:** `docs/superpowers/specs/2026-04-16-ideas-dashboard-ui-design.md`

**Important rules from CLAUDE.md:**
- Do NOT replace page navigations with SPA router
- Do NOT add server-rendered initial data bootstrapping
- Do NOT run any git write commands
- Install packages in apps/app only (not root)

---

## Task 1: Install @dnd-kit/sortable

`@dnd-kit/core` and `@dnd-kit/utilities` are already in `apps/app/package.json`. We need `@dnd-kit/sortable` for the sortable column/card behavior.

**Files:**
- Modify: `apps/app/package.json`

- [ ] **Step 1: Add @dnd-kit/sortable**

Run: `cd /Users/zank/Developer/majestico/relayapi/apps/app && bun add @dnd-kit/sortable`

- [ ] **Step 2: Verify it installed**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors

---

## Task 2: Sidebar Navigation — Add Ideas Item

**Files:**
- Modify: `apps/app/src/components/dashboard/sidebar.tsx`

- [ ] **Step 1: Add Lightbulb to lucide-react imports**

In the lucide-react import statement, add `Lightbulb`.

- [ ] **Step 2: Add Ideas nav item before Posts**

In the `navItems` array, add before the Connections item (first position):

```typescript
{ label: "Ideas", icon: Lightbulb, href: "ideas" },
```

The full array should start with:
```typescript
const navItems: NavItem[] = [
	{ label: "Ideas", icon: Lightbulb, href: "ideas" },
	{ label: "Connections", icon: Link2, href: "connections" },
	// ... rest unchanged
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`

---

## Task 3: Ideas Page Scaffolding

Create the three files needed for a new dashboard page: Astro route, route-app wrapper, and page component skeleton.

**Files:**
- Create: `apps/app/src/pages/app/ideas.astro`
- Create: `apps/app/src/components/dashboard/route-apps/ideas-route-app.tsx`
- Create: `apps/app/src/components/dashboard/pages/ideas-page.tsx`

- [ ] **Step 1: Create the Astro page route**

Create `apps/app/src/pages/app/ideas.astro`:

```astro
---
import DashboardLayout from "../../layouts/DashboardLayout.astro";
import { IdeasRouteApp } from "../../components/dashboard/route-apps/ideas-route-app";
import { getDashboardRouteContext } from "../../lib/dashboard-page";

const dashboard = getDashboardRouteContext(Astro.locals, Astro.url);
---

<DashboardLayout>
	<IdeasRouteApp
		client:load
		currentPage="ideas"
		{...dashboard}
	/>
</DashboardLayout>
```

- [ ] **Step 2: Create the route-app wrapper**

Create `apps/app/src/components/dashboard/route-apps/ideas-route-app.tsx`:

```tsx
import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const IdeasRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/ideas-page").then((module) => ({
		default: module.IdeasPage,
	})),
);
```

- [ ] **Step 3: Create the page component skeleton**

Create `apps/app/src/components/dashboard/pages/ideas-page.tsx`:

```tsx
import { useState } from "react";
import { motion } from "motion/react";
import { Lightbulb, Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePaginatedApi } from "@/hooks/use-api";
import { useFilterQuery } from "@/components/dashboard/filter-context";

const stagger = {
	hidden: {},
	visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
	hidden: { opacity: 0, y: 6 },
	visible: {
		opacity: 1,
		y: 0,
		transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const },
	},
};

interface IdeaGroup {
	id: string;
	name: string;
	position: number;
	color: string | null;
	is_default: boolean;
	workspace_id: string | null;
	created_at: string;
	updated_at: string;
}

interface IdeaTag {
	id: string;
	name: string;
	color: string;
	workspace_id: string | null;
	created_at: string;
}

interface IdeaMedia {
	id: string;
	url: string;
	type: "image" | "video" | "gif" | "document";
	alt: string | null;
	position: number;
}

interface Idea {
	id: string;
	title: string | null;
	content: string | null;
	group_id: string;
	position: number;
	assigned_to: string | null;
	converted_to_post_id: string | null;
	tags: IdeaTag[];
	media: IdeaMedia[];
	workspace_id: string | null;
	created_at: string;
	updated_at: string;
}

interface IdeaComment {
	id: string;
	author_id: string;
	content: string;
	parent_id: string | null;
	created_at: string;
	updated_at: string;
}

export function IdeasPage() {
	const filterQuery = useFilterQuery();

	const {
		data: groups,
		loading: groupsLoading,
		refetch: refetchGroups,
	} = usePaginatedApi<IdeaGroup>("idea-groups", { query: filterQuery });

	const {
		data: ideas,
		loading: ideasLoading,
		refetch: refetchIdeas,
	} = usePaginatedApi<Idea>("ideas", {
		query: filterQuery,
		limit: 100,
	});

	const {
		data: tags,
		loading: tagsLoading,
	} = usePaginatedApi<IdeaTag>("tags", { query: filterQuery });

	const loading = groupsLoading || ideasLoading;

	if (loading) {
		return (
			<div className="flex items-center justify-center py-20">
				<Loader2 className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	// Empty state — no groups yet
	if (groups.length === 0) {
		return (
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<h1 className="text-lg font-medium">Ideas</h1>
				</div>
				<div className="rounded-md border border-dashed border-border p-12 text-center">
					<Lightbulb className="size-8 text-muted-foreground/40 mx-auto mb-2" />
					<p className="text-sm text-muted-foreground">Plan your content</p>
					<p className="text-xs text-muted-foreground mt-1">
						Create your first idea to get started with content planning.
					</p>
					<Button
						size="sm"
						className="mt-4 gap-1.5 h-7 text-xs"
						onClick={() => {
							// TODO: open create dialog — will be wired in Task 8
						}}
					>
						<Plus className="size-3.5" />
						New Idea
					</Button>
				</div>
			</div>
		);
	}

	// Group ideas by group_id
	const ideasByGroup = new Map<string, Idea[]>();
	for (const group of groups) {
		ideasByGroup.set(group.id, []);
	}
	for (const idea of ideas) {
		const list = ideasByGroup.get(idea.group_id);
		if (list) {
			list.push(idea);
		}
	}
	// Sort ideas within each group by position
	for (const list of ideasByGroup.values()) {
		list.sort((a, b) => a.position - b.position);
	}

	// Sort groups by position
	const sortedGroups = [...groups].sort((a, b) => a.position - b.position);

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-medium">Ideas</h1>
				<Button
					size="sm"
					className="gap-1.5 h-7 text-xs"
					onClick={() => {
						// TODO: open create dialog — will be wired in Task 8
					}}
				>
					<Plus className="size-3.5" />
					New Idea
				</Button>
			</div>

			{/* Kanban board — placeholder, will be replaced in Task 4 */}
			<motion.div
				className="flex gap-4 overflow-x-auto pb-4"
				variants={stagger}
				initial="hidden"
				animate="visible"
			>
				{sortedGroups.map((group) => (
					<motion.div
						key={group.id}
						variants={fadeUp}
						className="shrink-0 w-72 rounded-md border border-border bg-accent/10"
					>
						<div className="px-3 py-2 border-b border-border flex items-center gap-2">
							{group.color && (
								<span
									className="size-2.5 rounded-full shrink-0"
									style={{ backgroundColor: group.color }}
								/>
							)}
							<span className="text-sm font-medium truncate">{group.name}</span>
							<span className="text-xs text-muted-foreground ml-auto">
								{ideasByGroup.get(group.id)?.length ?? 0}
							</span>
						</div>
						<div className="p-2 space-y-2 min-h-[100px]">
							{(ideasByGroup.get(group.id) ?? []).map((idea) => (
								<div
									key={idea.id}
									className="rounded-md border border-border bg-background p-3 cursor-pointer hover:bg-accent/20 transition-colors"
								>
									<p className="text-sm font-medium line-clamp-2">
										{idea.title || idea.content?.slice(0, 80) || "Untitled"}
									</p>
									{idea.content && idea.title && (
										<p className="text-xs text-muted-foreground mt-1 line-clamp-2">
											{idea.content}
										</p>
									)}
								</div>
							))}
							<button
								className="w-full rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground hover:bg-accent/20 transition-colors"
								onClick={() => {
									// TODO: open create dialog with group pre-selected — Task 8
								}}
							>
								<Plus className="size-3 inline mr-1" />
								New Idea
							</button>
						</div>
					</motion.div>
				))}
			</motion.div>
		</div>
	);
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`

---

## Task 4: Idea Card Component

Extract the card into its own component with full visual design: title, content preview, tags, media count, comment count, assignee avatar, converted badge.

**Files:**
- Create: `apps/app/src/components/dashboard/ideas/idea-card.tsx`
- Modify: `apps/app/src/components/dashboard/pages/ideas-page.tsx`

- [ ] **Step 1: Create the idea card component**

Create `apps/app/src/components/dashboard/ideas/idea-card.tsx`:

```tsx
import { MessageCircle, Paperclip, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface IdeaTag {
	id: string;
	name: string;
	color: string;
}

interface IdeaCardProps {
	id: string;
	title: string | null;
	content: string | null;
	tags: IdeaTag[];
	mediaCount: number;
	commentCount: number;
	assignedTo: string | null;
	convertedToPostId: string | null;
	onClick: () => void;
}

export function IdeaCard({
	title,
	content,
	tags,
	mediaCount,
	commentCount,
	assignedTo,
	convertedToPostId,
	onClick,
}: IdeaCardProps) {
	const displayTitle = title || content?.slice(0, 80) || "Untitled";
	const showContent = title && content;
	const visibleTags = tags.slice(0, 3);
	const extraTagCount = tags.length - 3;
	const hasFooter = mediaCount > 0 || commentCount > 0 || assignedTo;

	return (
		<div
			className="rounded-md border border-border bg-background p-3 cursor-pointer hover:bg-accent/20 transition-colors relative"
			onClick={onClick}
		>
			{convertedToPostId && (
				<span className="absolute top-2 right-2 size-4 rounded-full bg-green-500/20 flex items-center justify-center" title="Converted to post">
					<Check className="size-2.5 text-green-500" />
				</span>
			)}

			<p className="text-sm font-medium line-clamp-2 pr-5">{displayTitle}</p>

			{showContent && (
				<p className="text-xs text-muted-foreground mt-1 line-clamp-2">
					{content}
				</p>
			)}

			{visibleTags.length > 0 && (
				<div className="flex flex-wrap gap-1 mt-2">
					{visibleTags.map((tag) => (
						<span
							key={tag.id}
							className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] text-muted-foreground bg-accent/40"
						>
							<span
								className="size-1.5 rounded-full shrink-0"
								style={{ backgroundColor: tag.color }}
							/>
							{tag.name}
						</span>
					))}
					{extraTagCount > 0 && (
						<span className="text-[10px] text-muted-foreground px-1">
							+{extraTagCount}
						</span>
					)}
				</div>
			)}

			{hasFooter && (
				<div className="flex items-center gap-2 mt-2 text-muted-foreground">
					{mediaCount > 0 && (
						<span className="inline-flex items-center gap-0.5 text-[10px]">
							<Paperclip className="size-3" />
							{mediaCount}
						</span>
					)}
					{commentCount > 0 && (
						<span className="inline-flex items-center gap-0.5 text-[10px]">
							<MessageCircle className="size-3" />
							{commentCount}
						</span>
					)}
					{assignedTo && (
						<span
							className="ml-auto size-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-medium"
							title={assignedTo}
						>
							{assignedTo.slice(0, 2).toUpperCase()}
						</span>
					)}
				</div>
			)}
		</div>
	);
}
```

- [ ] **Step 2: Update ideas-page.tsx to use IdeaCard**

Replace the inline card div in the ideas-page with the `IdeaCard` component. Import it and pass the appropriate props. The card's `onClick` will be wired to open the detail dialog in Task 8.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`

---

## Task 5: Idea Column Component

Extract the column into its own component with header (color dot, name, count, kebab menu) and the "+ New Idea" button.

**Files:**
- Create: `apps/app/src/components/dashboard/ideas/idea-column.tsx`
- Modify: `apps/app/src/components/dashboard/pages/ideas-page.tsx`

- [ ] **Step 1: Create the idea column component**

Create `apps/app/src/components/dashboard/ideas/idea-column.tsx`:

```tsx
import { useState } from "react";
import { MoreHorizontal, Pencil, Trash2, Plus } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

interface IdeaColumnProps {
	id: string;
	name: string;
	color: string | null;
	isDefault: boolean;
	count: number;
	children: React.ReactNode;
	onRename: (name: string) => void;
	onChangeColor: (color: string) => void;
	onDelete: () => void;
	onNewIdea: () => void;
}

export function IdeaColumn({
	id,
	name,
	color,
	isDefault,
	count,
	children,
	onRename,
	onChangeColor,
	onDelete,
	onNewIdea,
}: IdeaColumnProps) {
	const [editing, setEditing] = useState(false);
	const [editName, setEditName] = useState(name);

	const handleRenameSubmit = () => {
		const trimmed = editName.trim();
		if (trimmed && trimmed !== name) {
			onRename(trimmed);
		}
		setEditing(false);
	};

	return (
		<div className="shrink-0 w-72 rounded-md border border-border bg-accent/10 flex flex-col max-h-[calc(100vh-180px)]">
			{/* Header */}
			<div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
				{color && (
					<span
						className="size-2.5 rounded-full shrink-0"
						style={{ backgroundColor: color }}
					/>
				)}
				{editing ? (
					<input
						className="text-sm font-medium bg-transparent border-b border-foreground outline-none flex-1 min-w-0"
						value={editName}
						onChange={(e) => setEditName(e.target.value)}
						onBlur={handleRenameSubmit}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleRenameSubmit();
							if (e.key === "Escape") {
								setEditName(name);
								setEditing(false);
							}
						}}
						autoFocus
					/>
				) : (
					<span className="text-sm font-medium truncate flex-1">{name}</span>
				)}
				<span className="text-xs text-muted-foreground">{count}</span>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button className="rounded p-0.5 hover:bg-accent transition-colors">
							<MoreHorizontal className="size-3.5 text-muted-foreground" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-40">
						<DropdownMenuItem onClick={() => {
							setEditName(name);
							setEditing(true);
						}}>
							<Pencil className="size-3.5 mr-2" />
							Rename
						</DropdownMenuItem>
						{!isDefault && (
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onClick={onDelete}
							>
								<Trash2 className="size-3.5 mr-2" />
								Delete Group
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Cards */}
			<div className="p-2 space-y-2 flex-1 overflow-y-auto min-h-[100px]">
				{children}
				<button
					className="w-full rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground hover:bg-accent/20 transition-colors"
					onClick={onNewIdea}
				>
					<Plus className="size-3 inline mr-1" />
					New Idea
				</button>
			</div>
		</div>
	);
}
```

- [ ] **Step 2: Update ideas-page.tsx to use IdeaColumn**

Replace the inline column divs with the `IdeaColumn` component. Wire up the callbacks (onRename, onDelete, onNewIdea) using `fetch()` calls to the API. onDelete should show a confirmation dialog.

- [ ] **Step 3: Add the "+ New Group" inline form**

Create `apps/app/src/components/dashboard/ideas/group-create-inline.tsx`:

```tsx
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface GroupCreateInlineProps {
	onSubmit: (name: string, color: string) => void;
}

const PRESET_COLORS = [
	"#6366f1", "#ec4899", "#f97316", "#22c55e",
	"#3b82f6", "#a855f7", "#ef4444", "#eab308",
];

export function GroupCreateInline({ onSubmit }: GroupCreateInlineProps) {
	const [active, setActive] = useState(false);
	const [name, setName] = useState("");
	const [color, setColor] = useState(PRESET_COLORS[0]!);

	const handleSubmit = () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		onSubmit(trimmed, color);
		setName("");
		setActive(false);
	};

	if (!active) {
		return (
			<div className="shrink-0 w-72">
				<button
					className="w-full rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground hover:bg-accent/20 transition-colors h-[52px] flex items-center justify-center gap-1.5"
					onClick={() => setActive(true)}
				>
					<Plus className="size-4" />
					New Group
				</button>
			</div>
		);
	}

	return (
		<div className="shrink-0 w-72 rounded-md border border-border bg-accent/10 p-3 space-y-2">
			<input
				className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
				placeholder="Group name"
				value={name}
				onChange={(e) => setName(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") handleSubmit();
					if (e.key === "Escape") setActive(false);
				}}
				autoFocus
			/>
			<div className="flex gap-1">
				{PRESET_COLORS.map((c) => (
					<button
						key={c}
						className={`size-5 rounded-full border-2 transition-colors ${color === c ? "border-foreground" : "border-transparent"}`}
						style={{ backgroundColor: c }}
						onClick={() => setColor(c)}
					/>
				))}
			</div>
			<div className="flex gap-2">
				<Button size="sm" className="h-7 text-xs flex-1" onClick={handleSubmit}>
					Create
				</Button>
				<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setActive(false)}>
					<X className="size-3.5" />
				</Button>
			</div>
		</div>
	);
}
```

- [ ] **Step 4: Add GroupCreateInline to the board in ideas-page.tsx**

After the last column, render `<GroupCreateInline onSubmit={handleCreateGroup} />`. The `handleCreateGroup` function calls `POST /api/idea-groups` with name, color, and workspace_id from filterQuery.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`

---

## Task 6: Drag and Drop

Wire up @dnd-kit for card reordering between columns and column reordering.

**Files:**
- Create: `apps/app/src/components/dashboard/ideas/idea-board.tsx`
- Modify: `apps/app/src/components/dashboard/pages/ideas-page.tsx`
- Modify: `apps/app/src/components/dashboard/ideas/idea-column.tsx`
- Modify: `apps/app/src/components/dashboard/ideas/idea-card.tsx`

- [ ] **Step 1: Create the idea-board component with DnD context**

Create `apps/app/src/components/dashboard/ideas/idea-board.tsx`:

```tsx
import { useState, useCallback } from "react";
import {
	DndContext,
	DragOverlay,
	closestCorners,
	PointerSensor,
	useSensor,
	useSensors,
	type DragStartEvent,
	type DragEndEvent,
	type DragOverEvent,
} from "@dnd-kit/core";
import {
	SortableContext,
	horizontalListSortingStrategy,
	verticalListSortingStrategy,
	useSortable,
	arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Idea, IdeaGroup } from "./types";
import { IdeaColumn } from "./idea-column";
import { IdeaCard } from "./idea-card";
import { GroupCreateInline } from "./group-create-inline";

interface IdeaBoardProps {
	groups: IdeaGroup[];
	ideasByGroup: Map<string, Idea[]>;
	onMoveIdea: (ideaId: string, groupId: string, afterIdeaId: string | null) => void;
	onReorderGroups: (groups: { id: string; position: number }[]) => void;
	onRenameGroup: (groupId: string, name: string) => void;
	onDeleteGroup: (groupId: string) => void;
	onCreateGroup: (name: string, color: string) => void;
	onClickIdea: (idea: Idea) => void;
	onNewIdea: (groupId: string | null) => void;
}

function SortableColumn({
	group,
	ideas,
	onRename,
	onDelete,
	onNewIdea,
	onClickIdea,
}: {
	group: IdeaGroup;
	ideas: Idea[];
	onRename: (name: string) => void;
	onDelete: () => void;
	onNewIdea: () => void;
	onClickIdea: (idea: Idea) => void;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: group.id, data: { type: "column" } });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	return (
		<div ref={setNodeRef} style={style}>
			<IdeaColumn
				id={group.id}
				name={group.name}
				color={group.color}
				isDefault={group.is_default}
				count={ideas.length}
				onRename={onRename}
				onChangeColor={() => {}}
				onDelete={onDelete}
				onNewIdea={onNewIdea}
				dragHandleProps={{ ...attributes, ...listeners }}
			>
				<SortableContext
					items={ideas.map((i) => i.id)}
					strategy={verticalListSortingStrategy}
				>
					{ideas.map((idea) => (
						<SortableIdeaCard
							key={idea.id}
							idea={idea}
							onClick={() => onClickIdea(idea)}
						/>
					))}
				</SortableContext>
			</IdeaColumn>
		</div>
	);
}

function SortableIdeaCard({
	idea,
	onClick,
}: {
	idea: Idea;
	onClick: () => void;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: idea.id, data: { type: "card", groupId: idea.group_id } });

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.4 : 1,
	};

	return (
		<div ref={setNodeRef} style={style} {...attributes} {...listeners}>
			<IdeaCard
				id={idea.id}
				title={idea.title}
				content={idea.content}
				tags={idea.tags}
				mediaCount={idea.media.length}
				commentCount={0}
				assignedTo={idea.assigned_to}
				convertedToPostId={idea.converted_to_post_id}
				onClick={onClick}
			/>
		</div>
	);
}

export function IdeaBoard({
	groups,
	ideasByGroup,
	onMoveIdea,
	onReorderGroups,
	onRenameGroup,
	onDeleteGroup,
	onCreateGroup,
	onClickIdea,
	onNewIdea,
}: IdeaBoardProps) {
	const [activeId, setActiveId] = useState<string | null>(null);
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
	);

	const handleDragStart = (event: DragStartEvent) => {
		setActiveId(event.active.id as string);
	};

	const handleDragEnd = (event: DragEndEvent) => {
		setActiveId(null);
		const { active, over } = event;
		if (!over || active.id === over.id) return;

		const activeType = active.data.current?.type;

		if (activeType === "column") {
			// Reorder columns
			const oldIndex = groups.findIndex((g) => g.id === active.id);
			const newIndex = groups.findIndex((g) => g.id === over.id);
			if (oldIndex !== -1 && newIndex !== -1) {
				const reordered = arrayMove(groups, oldIndex, newIndex);
				onReorderGroups(
					reordered.map((g, i) => ({ id: g.id, position: i })),
				);
			}
		} else if (activeType === "card") {
			// Move card
			const overType = over.data.current?.type;
			const targetGroupId =
				overType === "column"
					? (over.id as string)
					: over.data.current?.groupId;

			if (!targetGroupId) return;

			// Find the idea that was dropped after
			const targetIdeas = ideasByGroup.get(targetGroupId) ?? [];
			const overIndex = targetIdeas.findIndex((i) => i.id === over.id);
			const afterIdeaId =
				overIndex > 0 ? targetIdeas[overIndex - 1]?.id ?? null : null;

			onMoveIdea(active.id as string, targetGroupId, afterIdeaId);
		}
	};

	const sortedGroups = [...groups].sort((a, b) => a.position - b.position);

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCorners}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
		>
			<div className="flex gap-4 overflow-x-auto pb-4">
				<SortableContext
					items={sortedGroups.map((g) => g.id)}
					strategy={horizontalListSortingStrategy}
				>
					{sortedGroups.map((group) => (
						<SortableColumn
							key={group.id}
							group={group}
							ideas={ideasByGroup.get(group.id) ?? []}
							onRename={(name) => onRenameGroup(group.id, name)}
							onDelete={() => onDeleteGroup(group.id)}
							onNewIdea={() => onNewIdea(group.id)}
							onClickIdea={onClickIdea}
						/>
					))}
				</SortableContext>
				<GroupCreateInline onSubmit={onCreateGroup} />
			</div>
		</DndContext>
	);
}
```

- [ ] **Step 2: Create shared types file**

Create `apps/app/src/components/dashboard/ideas/types.ts`:

```tsx
export interface IdeaTag {
	id: string;
	name: string;
	color: string;
	workspace_id: string | null;
	created_at: string;
}

export interface IdeaMedia {
	id: string;
	url: string;
	type: "image" | "video" | "gif" | "document";
	alt: string | null;
	position: number;
}

export interface Idea {
	id: string;
	title: string | null;
	content: string | null;
	group_id: string;
	position: number;
	assigned_to: string | null;
	converted_to_post_id: string | null;
	tags: IdeaTag[];
	media: IdeaMedia[];
	workspace_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface IdeaGroup {
	id: string;
	name: string;
	position: number;
	color: string | null;
	is_default: boolean;
	workspace_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface IdeaComment {
	id: string;
	author_id: string;
	content: string;
	parent_id: string | null;
	created_at: string;
	updated_at: string;
}
```

- [ ] **Step 3: Add `dragHandleProps` to IdeaColumn**

Update `idea-column.tsx` to accept an optional `dragHandleProps` prop and spread it on the header div so the column is draggable from the header.

- [ ] **Step 4: Update ideas-page.tsx to use IdeaBoard**

Replace the inline board JSX with `<IdeaBoard>`, passing all the callbacks. Wire up the API calls:
- `onMoveIdea`: `POST /api/ideas/{id}/move`
- `onReorderGroups`: `POST /api/idea-groups/reorder`
- `onRenameGroup`: `PATCH /api/idea-groups/{id}`
- `onDeleteGroup`: `DELETE /api/idea-groups/{id}` (with confirmation)
- `onCreateGroup`: `POST /api/idea-groups`

All mutations should optimistically update local state and refetch on failure.

- [ ] **Step 5: Verify TypeScript compiles and test drag interaction**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Then start `bun run dev:app` and test drag-and-drop at `http://localhost:4321/app/ideas`.

---

## Task 7: Idea Detail Dialog

The view/edit dialog for an existing idea. Single-column layout matching the post dialog pattern.

**Files:**
- Create: `apps/app/src/components/dashboard/ideas/idea-detail-dialog.tsx`
- Modify: `apps/app/src/components/dashboard/pages/ideas-page.tsx`

- [ ] **Step 1: Create the detail dialog component**

Create `apps/app/src/components/dashboard/ideas/idea-detail-dialog.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Loader2,
	ImageIcon,
	Trash2,
	Plus,
	Upload,
	MessageCircle,
	Activity,
	X,
	Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Idea, IdeaGroup, IdeaTag, IdeaComment, IdeaMedia } from "./types";

interface IdeaDetailDialogProps {
	idea: Idea | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	groups: IdeaGroup[];
	allTags: IdeaTag[];
	onSave: (id: string, data: { title?: string | null; content?: string | null; assigned_to?: string | null; tag_ids?: string[] }) => Promise<void>;
	onMove: (id: string, groupId: string) => Promise<void>;
	onConvert: (id: string) => void;
	onDelete: (id: string) => Promise<void>;
	onRefetch: () => void;
}

export function IdeaDetailDialog({
	idea,
	open,
	onOpenChange,
	groups,
	allTags,
	onSave,
	onMove,
	onConvert,
	onDelete,
	onRefetch,
}: IdeaDetailDialogProps) {
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);
	const [comments, setComments] = useState<IdeaComment[]>([]);
	const [commentsLoading, setCommentsLoading] = useState(false);
	const [newComment, setNewComment] = useState("");
	const [commentSubmitting, setCommentSubmitting] = useState(false);
	const [showActivity, setShowActivity] = useState(false);
	const [activity, setActivity] = useState<any[]>([]);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Sync state when idea changes
	useEffect(() => {
		if (idea) {
			setTitle(idea.title ?? "");
			setContent(idea.content ?? "");
			setSelectedTagIds(idea.tags.map((t) => t.id));
			setShowActivity(false);
			// Fetch comments
			setCommentsLoading(true);
			fetch(`/api/ideas/${idea.id}/comments?limit=50`)
				.then((r) => r.json())
				.then((json) => setComments(json.data ?? []))
				.catch(() => {})
				.finally(() => setCommentsLoading(false));
		}
	}, [idea?.id]);

	// Auto-resize textarea
	useEffect(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
			textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
		}
	}, [content]);

	const handleSave = async () => {
		if (!idea) return;
		setSaving(true);
		await onSave(idea.id, {
			title: title || null,
			content: content || null,
			tag_ids: selectedTagIds,
		});
		setSaving(false);
		onOpenChange(false);
		onRefetch();
	};

	const handleAddComment = async () => {
		if (!idea || !newComment.trim()) return;
		setCommentSubmitting(true);
		try {
			const res = await fetch(`/api/ideas/${idea.id}/comments`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: newComment }),
			});
			if (res.ok) {
				const comment = await res.json();
				setComments((prev) => [comment, ...prev]);
				setNewComment("");
			}
		} catch {}
		setCommentSubmitting(false);
	};

	const handleToggleActivity = async () => {
		if (!idea) return;
		if (!showActivity) {
			const res = await fetch(`/api/ideas/${idea.id}/activity?limit=20`);
			const json = await res.json();
			setActivity(json.data ?? []);
		}
		setShowActivity(!showActivity);
	};

	const toggleTag = (tagId: string) => {
		setSelectedTagIds((prev) =>
			prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
		);
	};

	if (!idea) return null;

	const sortedGroups = [...groups].sort((a, b) => a.position - b.position);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl p-0 gap-0 max-h-[90vh] flex flex-col">
				{/* Header */}
				<DialogHeader className="px-5 pt-5 pb-3 shrink-0">
					<div className="flex items-center gap-3">
						<DialogTitle className="text-base font-medium flex-1">
							{idea.id ? "Edit Idea" : "New Idea"}
						</DialogTitle>
						{/* Group selector */}
						<Select
							value={idea.group_id}
							onValueChange={(v) => onMove(idea.id, v)}
						>
							<SelectTrigger className="h-7 text-xs w-auto gap-1">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{sortedGroups.map((g) => (
									<SelectItem key={g.id} value={g.id} className="text-xs">
										{g.color && (
											<span
												className="size-2 rounded-full inline-block mr-1.5"
												style={{ backgroundColor: g.color }}
											/>
										)}
										{g.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{/* Tags popover */}
						<Popover>
							<PopoverTrigger asChild>
								<Button variant="outline" size="sm" className="h-7 text-xs gap-1">
									Tags
									{selectedTagIds.length > 0 && (
										<span className="size-4 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center">
											{selectedTagIds.length}
										</span>
									)}
								</Button>
							</PopoverTrigger>
							<PopoverContent className="w-48 p-2" align="end">
								{allTags.map((tag) => (
									<button
										key={tag.id}
										className={cn(
											"flex items-center gap-2 w-full rounded px-2 py-1.5 text-xs hover:bg-accent transition-colors",
											selectedTagIds.includes(tag.id) && "bg-accent",
										)}
										onClick={() => toggleTag(tag.id)}
									>
										<span
											className="size-2 rounded-full shrink-0"
											style={{ backgroundColor: tag.color }}
										/>
										<span className="flex-1 text-left">{tag.name}</span>
										{selectedTagIds.includes(tag.id) && (
											<Check className="size-3 text-primary" />
										)}
									</button>
								))}
								{allTags.length === 0 && (
									<p className="text-xs text-muted-foreground p-2">
										No tags. Create tags in Settings.
									</p>
								)}
							</PopoverContent>
						</Popover>
					</div>
				</DialogHeader>

				{/* Scrollable content */}
				<div className="flex-1 min-h-0 overflow-y-auto px-5 pb-3 space-y-4">
					{/* Title */}
					<input
						className="w-full text-base font-medium bg-transparent outline-none placeholder:text-muted-foreground/50"
						placeholder="Add a title..."
						value={title}
						onChange={(e) => setTitle(e.target.value)}
					/>

					{/* Content */}
					<textarea
						ref={textareaRef}
						className="w-full text-sm bg-transparent outline-none resize-none placeholder:text-muted-foreground/50 min-h-[120px]"
						placeholder="Write your idea..."
						value={content}
						onChange={(e) => setContent(e.target.value)}
					/>

					{/* Media */}
					{idea.media.length > 0 && (
						<div className="flex flex-wrap gap-2">
							{idea.media.map((m) => (
								<div
									key={m.id}
									className="size-16 rounded border border-border overflow-hidden bg-accent/20 relative group"
								>
									{m.type === "image" ? (
										<img src={m.url} alt={m.alt ?? ""} className="size-full object-cover" />
									) : (
										<div className="size-full flex items-center justify-center">
											<ImageIcon className="size-5 text-muted-foreground/40" />
										</div>
									)}
								</div>
							))}
						</div>
					)}

					{/* Comments */}
					<div className="border-t border-border pt-3">
						<p className="text-xs font-medium text-muted-foreground mb-2">
							<MessageCircle className="size-3 inline mr-1" />
							{comments.length} Comments
						</p>
						{commentsLoading ? (
							<Loader2 className="size-4 animate-spin text-muted-foreground" />
						) : (
							<div className="space-y-2">
								{comments.map((c) => (
									<div
										key={c.id}
										className={cn("text-xs", c.parent_id && "ml-6")}
									>
										<span className="font-medium">{c.author_id.slice(0, 8)}</span>
										<span className="text-muted-foreground ml-1.5">{c.content}</span>
										<span className="text-muted-foreground/60 ml-1.5">
											{new Date(c.created_at).toLocaleDateString()}
										</span>
									</div>
								))}
							</div>
						)}
						<div className="flex gap-2 mt-2">
							<input
								className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
								placeholder="Write a comment..."
								value={newComment}
								onChange={(e) => setNewComment(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										handleAddComment();
									}
								}}
							/>
							<Button
								size="sm"
								className="h-7 text-xs"
								disabled={!newComment.trim() || commentSubmitting}
								onClick={handleAddComment}
							>
								{commentSubmitting ? <Loader2 className="size-3 animate-spin" /> : "Send"}
							</Button>
						</div>
					</div>

					{/* Activity (collapsible) */}
					{showActivity && activity.length > 0 && (
						<div className="border-t border-border pt-3">
							<p className="text-xs font-medium text-muted-foreground mb-2">Activity</p>
							<div className="space-y-1">
								{activity.map((a: any) => (
									<p key={a.id} className="text-[11px] text-muted-foreground">
										<span className="font-medium">{a.action}</span>
										{" · "}
										{new Date(a.created_at).toLocaleDateString()}
									</p>
								))}
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="px-5 py-3 shrink-0 border-t border-border flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 text-xs gap-1"
						onClick={handleToggleActivity}
					>
						<Activity className="size-3" />
						Activity
					</Button>
					<div className="ml-auto flex gap-2">
						<Button
							variant="outline"
							size="sm"
							className="h-7 text-xs"
							onClick={() => onConvert(idea.id)}
						>
							Convert to Post
						</Button>
						<Button
							size="sm"
							className="h-7 text-xs"
							onClick={handleSave}
							disabled={saving}
						>
							{saving ? <Loader2 className="size-3 animate-spin" /> : "Save"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
```

- [ ] **Step 2: Wire up the detail dialog in ideas-page.tsx**

Add state: `const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);`

Pass `onClickIdea={(idea) => setSelectedIdea(idea)}` to the board.

Render `<IdeaDetailDialog>` at the bottom of the page component with the appropriate callbacks.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`

---

## Task 8: Create Idea Dialog

Reuse the detail dialog in create mode. Both the header "+ New Idea" button and column "+ New Idea" button open this.

**Files:**
- Modify: `apps/app/src/components/dashboard/ideas/idea-detail-dialog.tsx`
- Modify: `apps/app/src/components/dashboard/pages/ideas-page.tsx`

- [ ] **Step 1: Support create mode in the detail dialog**

The dialog already handles `idea === null` as an early return. Change this: when `idea` is null but `open` is true, render a create form. Add a `createGroupId` prop for pre-selecting the group.

Add these props:
```tsx
createMode?: boolean;
createGroupId?: string | null;
onCreate: (data: { title?: string; content?: string; group_id?: string; tag_ids?: string[] }) => Promise<void>;
```

When `createMode` is true:
- Title says "New Idea"
- Group selector defaults to `createGroupId` or the first group
- Save button says "Create" and calls `onCreate` instead of `onSave`
- No comments, activity, media, or convert button shown

- [ ] **Step 2: Wire up create mode in ideas-page.tsx**

Add state:
```tsx
const [createDialogOpen, setCreateDialogOpen] = useState(false);
const [createGroupId, setCreateGroupId] = useState<string | null>(null);
```

Header button: `onClick={() => { setCreateGroupId(null); setCreateDialogOpen(true); }}`
Column button: `onNewIdea={(groupId) => { setCreateGroupId(groupId); setCreateDialogOpen(true); }}`
Empty state button: same as header button.

`onCreate` calls `POST /api/ideas` then refetches and closes the dialog.

- [ ] **Step 3: Verify TypeScript compiles and test the full flow**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`

---

## Task 9: Filtering

Add tag and assigned_to filters in the page header.

**Files:**
- Modify: `apps/app/src/components/dashboard/pages/ideas-page.tsx`

- [ ] **Step 1: Add filter state**

```tsx
const [filterTagId, setFilterTagId] = useState<string | null>(null);
const [filterAssignedTo, setFilterAssignedTo] = useState<string | null>(null);
```

- [ ] **Step 2: Add filter UI in the page header**

Between the title and "+ New Idea" button, add:
- Tag filter: a small Popover with tag list (colored dots), selecting one sets `filterTagId`
- Assigned to filter: a Select dropdown (placeholder "All members")
- "Clear" link when any filter is active

- [ ] **Step 3: Apply filters to the ideas query**

Update the `usePaginatedApi("ideas", ...)` query to include `tag_id` and `assigned_to` params when set. Or filter client-side since we already loaded all ideas (up to 100).

For simplicity (since we load up to 100 ideas), filter client-side:

```tsx
const filteredIdeas = ideas.filter((idea) => {
	if (filterTagId && !idea.tags.some((t) => t.id === filterTagId)) return false;
	if (filterAssignedTo && idea.assigned_to !== filterAssignedTo) return false;
	return true;
});
```

Use `filteredIdeas` instead of `ideas` when building `ideasByGroup`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`

---

## Task 10: Settings Page — Tab Restructure

Split the monolithic settings page into tabs: General, Notifications, Short Links, Tags.

**Files:**
- Modify: `apps/app/src/components/dashboard/pages/settings-page.tsx`
- Modify: `apps/app/src/pages/app/settings.astro`
- Modify: `apps/app/src/components/dashboard/route-apps/settings-route-app.tsx`

- [ ] **Step 1: Add tab state and URL sync to settings-page.tsx**

At the top of the `SettingsPage` component, add:

```tsx
export interface SettingsPageProps {
	initialTab?: "general" | "notifications" | "short-links" | "tags";
}

export function SettingsPage({ initialTab = "general" }: SettingsPageProps = {}) {
	const [activeTab, setActiveTab] = useState(initialTab);

	const switchTab = (tab: NonNullable<SettingsPageProps["initialTab"]>) => {
		setActiveTab(tab);
		const url = new URL(window.location.href);
		url.searchParams.set("tab", tab);
		window.history.replaceState({}, "", url.toString());
	};
```

- [ ] **Step 2: Add the tab bar**

After the `<h1>Settings</h1>` heading, insert the tab bar following the exact media-page pattern:

```tsx
const settingsTabs = ["General", "Notifications", "Short Links", "Tags"] as const;

// In the JSX, after the h1:
<div className="flex items-end justify-between gap-x-4 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
	<div className="flex gap-4 shrink-0">
		{settingsTabs.map((tab) => {
			const tabKey = tab.toLowerCase().replace(" ", "-") as NonNullable<SettingsPageProps["initialTab"]>;
			return (
				<button
					key={tab}
					onClick={() => switchTab(tabKey)}
					className={cn(
						"pb-2 text-[13px] font-medium transition-colors whitespace-nowrap border-b-2 -mb-px",
						activeTab === tabKey
							? "border-foreground text-foreground"
							: "border-transparent text-muted-foreground hover:text-foreground",
					)}
				>
					{tab}
				</button>
			);
		})}
	</div>
</div>
```

- [ ] **Step 3: Wrap existing sections in tab panels**

Wrap the existing card sections with conditional rendering:
- `{activeTab === "general" && ( /* Organization Profile + Signatures + Org Settings + Danger Zone */ )}`
- `{activeTab === "notifications" && ( /* Notifications card */ )}`
- `{activeTab === "short-links" && ( /* Short Links card */ )}`
- `{activeTab === "tags" && ( /* Tags component — Task 11 */ )}`

Do NOT refactor the existing code into separate files. Just wrap each section group in a conditional.

- [ ] **Step 4: Update settings.astro to pass initialTab**

```astro
---
import DashboardLayout from "../../layouts/DashboardLayout.astro";
import { SettingsRouteApp } from "../../components/dashboard/route-apps/settings-route-app";
import {
	getDashboardRouteContext,
	getSearchParamValue,
} from "../../lib/dashboard-page";

const dashboard = getDashboardRouteContext(Astro.locals, Astro.url);
const initialTab = getSearchParamValue(
	Astro.url,
	"tab",
	["general", "notifications", "short-links", "tags"] as const,
	"general",
);
---

<DashboardLayout>
	<SettingsRouteApp
		client:load
		currentPage="settings"
		requiresApiKey={false}
		pageProps={{ initialTab }}
		{...dashboard}
	/>
</DashboardLayout>
```

- [ ] **Step 5: Update settings-route-app.tsx to pass pageProps**

Check the current route-app. If it doesn't pass `pageProps`, update it to match the pattern from media-route-app (the `createLazyDashboardRouteApp` generic handles this automatically via the type parameter).

```tsx
import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";
import type { SettingsPageProps } from "../pages/settings-page";

export const SettingsRouteApp =
	createLazyDashboardRouteApp<SettingsPageProps>(() =>
		import("../pages/settings-page").then((module) => ({
			default: module.SettingsPage,
		})),
	);
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`

---

## Task 11: Tags Settings Tab

Create the tags management component for the Settings page.

**Files:**
- Create: `apps/app/src/components/dashboard/settings/tags-settings.tsx`
- Modify: `apps/app/src/components/dashboard/pages/settings-page.tsx`

- [ ] **Step 1: Create the tags settings component**

Create `apps/app/src/components/dashboard/settings/tags-settings.tsx`:

```tsx
import { useState } from "react";
import { motion } from "motion/react";
import { Plus, Pencil, Trash2, Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePaginatedApi } from "@/hooks/use-api";
import { useFilterQuery } from "@/components/dashboard/filter-context";

const stagger = {
	hidden: {},
	visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
	hidden: { opacity: 0, y: 6 },
	visible: {
		opacity: 1,
		y: 0,
		transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const },
	},
};

const PRESET_COLORS = [
	"#6366f1", "#ec4899", "#f97316", "#22c55e",
	"#3b82f6", "#a855f7", "#ef4444", "#eab308",
];

interface Tag {
	id: string;
	name: string;
	color: string;
	workspace_id: string | null;
	created_at: string;
}

export function TagsSettings() {
	const filterQuery = useFilterQuery();
	const {
		data: tags,
		loading,
		refetch,
	} = usePaginatedApi<Tag>("tags", { query: filterQuery });

	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [newColor, setNewColor] = useState(PRESET_COLORS[0]!);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editName, setEditName] = useState("");
	const [editColor, setEditColor] = useState("");
	const [saving, setSaving] = useState(false);
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

	const handleCreate = async () => {
		if (!newName.trim()) return;
		setSaving(true);
		const res = await fetch("/api/tags", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: newName.trim(),
				color: newColor,
				...filterQuery,
			}),
		});
		if (res.ok) {
			setNewName("");
			setCreating(false);
			refetch();
		}
		setSaving(false);
	};

	const handleUpdate = async (id: string) => {
		if (!editName.trim()) return;
		setSaving(true);
		await fetch(`/api/tags/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: editName.trim(), color: editColor }),
		});
		setEditingId(null);
		refetch();
		setSaving(false);
	};

	const handleDelete = async (id: string) => {
		await fetch(`/api/tags/${id}`, { method: "DELETE" });
		setDeleteConfirmId(null);
		refetch();
	};

	return (
		<motion.div variants={fadeUp}>
			<div className="rounded-md border border-border overflow-hidden">
				<div className="px-4 py-3 border-b border-border bg-accent/10 flex items-center justify-between">
					<div>
						<h2 className="text-sm font-medium">Tags</h2>
						<p className="text-xs text-muted-foreground mt-0.5">
							Tags are shared across ideas and posts.
						</p>
					</div>
					{!creating && (
						<Button
							size="sm"
							className="h-7 text-xs gap-1"
							onClick={() => setCreating(true)}
						>
							<Plus className="size-3.5" />
							New Tag
						</Button>
					)}
				</div>

				<div className="divide-y divide-border">
					{/* Create form */}
					{creating && (
						<div className="px-4 py-3 flex items-center gap-3">
							<div className="flex gap-1">
								{PRESET_COLORS.map((c) => (
									<button
										key={c}
										className={`size-5 rounded-full border-2 transition-colors ${newColor === c ? "border-foreground" : "border-transparent"}`}
										style={{ backgroundColor: c }}
										onClick={() => setNewColor(c)}
									/>
								))}
							</div>
							<input
								className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
								placeholder="Tag name"
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleCreate();
									if (e.key === "Escape") setCreating(false);
								}}
								autoFocus
							/>
							<Button size="sm" className="h-7 text-xs" onClick={handleCreate} disabled={saving}>
								{saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3.5" />}
							</Button>
							<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCreating(false)}>
								<X className="size-3.5" />
							</Button>
						</div>
					)}

					{/* Loading */}
					{loading && (
						<div className="px-4 py-8 text-center">
							<Loader2 className="size-4 animate-spin text-muted-foreground mx-auto" />
						</div>
					)}

					{/* Tag list */}
					{!loading && tags.length === 0 && !creating && (
						<div className="px-4 py-8 text-center">
							<p className="text-sm text-muted-foreground">No tags yet</p>
							<p className="text-xs text-muted-foreground mt-1">
								Create your first tag to organize ideas and posts.
							</p>
						</div>
					)}

					{tags.map((tag) => (
						<div key={tag.id} className="px-4 py-2.5 flex items-center gap-3">
							{editingId === tag.id ? (
								<>
									<div className="flex gap-1">
										{PRESET_COLORS.map((c) => (
											<button
												key={c}
												className={`size-5 rounded-full border-2 transition-colors ${editColor === c ? "border-foreground" : "border-transparent"}`}
												style={{ backgroundColor: c }}
												onClick={() => setEditColor(c)}
											/>
										))}
									</div>
									<input
										className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
										value={editName}
										onChange={(e) => setEditName(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleUpdate(tag.id);
											if (e.key === "Escape") setEditingId(null);
										}}
										autoFocus
									/>
									<Button size="sm" className="h-7 text-xs" onClick={() => handleUpdate(tag.id)} disabled={saving}>
										{saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3.5" />}
									</Button>
									<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingId(null)}>
										<X className="size-3.5" />
									</Button>
								</>
							) : (
								<>
									<span
										className="size-3 rounded-full shrink-0"
										style={{ backgroundColor: tag.color }}
									/>
									<span className="text-sm flex-1">{tag.name}</span>
									{deleteConfirmId === tag.id ? (
										<>
											<span className="text-xs text-destructive">Delete?</span>
											<Button
												size="sm"
												variant="destructive"
												className="h-6 text-xs px-2"
												onClick={() => handleDelete(tag.id)}
											>
												Yes
											</Button>
											<Button
												size="sm"
												variant="ghost"
												className="h-6 text-xs px-2"
												onClick={() => setDeleteConfirmId(null)}
											>
												No
											</Button>
										</>
									) : (
										<>
											<button
												className="rounded p-1 hover:bg-accent transition-colors"
												onClick={() => {
													setEditingId(tag.id);
													setEditName(tag.name);
													setEditColor(tag.color);
												}}
											>
												<Pencil className="size-3.5 text-muted-foreground" />
											</button>
											<button
												className="rounded p-1 hover:bg-red-500/10 transition-colors"
												onClick={() => setDeleteConfirmId(tag.id)}
											>
												<Trash2 className="size-3.5 text-muted-foreground hover:text-red-400" />
											</button>
										</>
									)}
								</>
							)}
						</div>
					))}
				</div>
			</div>
		</motion.div>
	);
}
```

- [ ] **Step 2: Import and render in settings-page.tsx**

In the tags tab conditional:

```tsx
import { TagsSettings } from "@/components/dashboard/settings/tags-settings";

// In the JSX:
{activeTab === "tags" && <TagsSettings />}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`

---

## Task 12: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck`
Expected: No errors across all packages and apps

- [ ] **Step 2: Start dev server and test**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run dev:app`

Test at `http://localhost:4321/app/ideas`:
- Board loads with groups and cards
- Cards show title, content preview, tags, media/comment counts
- Drag cards between columns
- Drag columns to reorder
- Click card to open detail dialog
- Create new idea from header button and column button
- Create new group
- Edit/delete group from kebab menu
- Tag and assignee filters work

Test at `http://localhost:4321/app/settings`:
- Tab bar shows: General, Notifications, Short Links, Tags
- Each tab shows the correct content
- Tags tab: create, edit, delete tags
- URL updates with `?tab=` on tab switch
