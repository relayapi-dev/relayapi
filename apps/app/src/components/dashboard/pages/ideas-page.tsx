import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { Lightbulb, Loader2, Plus, Tags, X } from "lucide-react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePaginatedApi } from "@/hooks/use-api";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { useFilterQuery } from "@/components/dashboard/filter-context";
import { IdeaBoard } from "@/components/dashboard/ideas/idea-board";
import { IdeaDetailDialog } from "@/components/dashboard/ideas/idea-detail-dialog";
import type { Idea, IdeaGroup, IdeaTag } from "@/components/dashboard/ideas/types";

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

export function IdeasPage() {
	const filterQuery = useFilterQuery();

	const {
		data: groups,
		loading: groupsLoading,
		error: groupsError,
		refetch: refetchGroups,
	} = usePaginatedApi<IdeaGroup>("idea-groups", {
		query: filterQuery,
		limit: 100,
	});

	const {
		data: ideas,
		loading: ideasLoading,
		error: ideasError,
		refetch: refetchIdeas,
	} = usePaginatedApi<Idea>("ideas", {
		query: filterQuery,
		limit: 100,
	});

	const {
		data: tags,
	} = usePaginatedApi<IdeaTag>("idea-tags", {
		query: filterQuery,
		limit: 100,
	});

	// Dialog state
	const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [createGroupId, setCreateGroupId] = useState<string | null>(null);

	// Filters
	const [filterTagId, setFilterTagId] = useState<string | null>(null);
	const [filterAssignedTo, setFilterAssignedTo] = useState<string | null>(null);
	const hasFilters = filterTagId !== null || filterAssignedTo !== null;

	const refetchAll = () => {
		refetchGroups();
		refetchIdeas();
	};

	const ideasByGroup = useMemo(() => {
		const map = new Map<string, Idea[]>();
		for (const group of groups) {
			map.set(group.id, []);
		}
		const filtered = ideas.filter((idea) => {
			if (filterTagId && !idea.tags.some((t) => t.id === filterTagId)) return false;
			if (filterAssignedTo && idea.assigned_to !== filterAssignedTo) return false;
			return true;
		});
		const sorted = [...filtered].sort((a, b) => a.position - b.position);
		for (const idea of sorted) {
			const existing = map.get(idea.group_id);
			if (existing) {
				existing.push(idea);
			} else {
				map.set(idea.group_id, [idea]);
			}
		}
		return map;
	}, [groups, ideas, filterTagId, filterAssignedTo]);

	const loading = groupsLoading || ideasLoading;
	const error = groupsError || ideasError;

	const handleCreateGroup = async (name: string, color: string) => {
		const workspaceId = filterQuery.workspace_id ?? null;
		const res = await fetch("/api/idea-groups", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, color, workspace_id: workspaceId }),
		});
		if (res.ok) refetchGroups();
	};

	const handleRenameGroup = async (groupId: string, name: string) => {
		const res = await fetch(`/api/idea-groups/${groupId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		if (res.ok) refetchGroups();
	};

	const handleDeleteGroup = async (groupId: string) => {
		const count = ideasByGroup.get(groupId)?.length ?? 0;
		const confirmMsg =
			count > 0
				? `Delete this group and its ${count} idea${count !== 1 ? "s" : ""}?`
				: "Delete this group?";
		if (!window.confirm(confirmMsg)) return;
		const res = await fetch(`/api/idea-groups/${groupId}`, {
			method: "DELETE",
		});
		if (res.ok || res.status === 204) refetchAll();
	};

	const handleReorderGroups = async (
		reordered: { id: string; position: number }[],
	) => {
		await fetch("/api/idea-groups/reorder", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groups: reordered }),
		});
		// Optimistic update already applied in board; refetch to confirm
		refetchGroups();
	};

	const handleMoveIdea = async (
		ideaId: string,
		groupId: string,
		afterIdeaId: string | null,
	) => {
		await fetch(`/api/ideas/${ideaId}/move`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ group_id: groupId, after_idea_id: afterIdeaId }),
		});
		refetchIdeas();
	};

	// Idea dialog handlers
	const handleSaveIdea = async (
		id: string,
		data: { title?: string | null; content?: string | null; tag_ids?: string[] },
	) => {
		await fetch(`/api/ideas/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		refetchIdeas();
	};

	const handleCreateIdea = async (data: {
		title?: string;
		content?: string;
		group_id?: string;
		tag_ids?: string[];
	}) => {
		const workspaceId = filterQuery.workspace_id ?? null;
		await fetch("/api/ideas", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...data, workspace_id: workspaceId }),
		});
		refetchIdeas();
	};

	const handleMoveIdeaToGroup = async (ideaId: string, groupId: string) => {
		await fetch(`/api/ideas/${ideaId}/move`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ group_id: groupId }),
		});
		refetchIdeas();
	};

	const handleConvertIdea = (ideaId: string) => {
		console.log("Convert idea to post:", ideaId);
		// TODO: open NewPostDialog pre-filled with idea content
	};

	const handleClickIdea = (idea: Idea) => {
		setSelectedIdea(idea);
		setDetailOpen(true);
	};

	const handleNewIdea = (groupId: string | null) => {
		setCreateGroupId(groupId);
		setCreateDialogOpen(true);
	};

	const sortedGroups = [...groups].sort((a, b) => a.position - b.position);

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-medium">Ideas</h1>
				<div className="flex items-center gap-2">
					<FilterBar />
					{/* Tag filter */}
					{tags.length > 0 && (
						<Popover>
							<PopoverTrigger asChild>
								<Button variant="outline" size="sm" className={cn("h-7 text-xs gap-1", filterTagId && "border-primary")}>
									<Tags className="size-3" />
									{filterTagId ? tags.find((t) => t.id === filterTagId)?.name ?? "Tag" : "Tag"}
								</Button>
							</PopoverTrigger>
							<PopoverContent className="w-44 p-1.5" align="end">
								{tags.map((tag) => (
									<button
										key={tag.id}
										className={cn(
											"flex items-center gap-2 w-full rounded px-2 py-1.5 text-xs hover:bg-accent transition-colors",
											filterTagId === tag.id && "bg-accent",
										)}
										onClick={() => setFilterTagId(filterTagId === tag.id ? null : tag.id)}
									>
										<span className="size-2 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
										{tag.name}
									</button>
								))}
							</PopoverContent>
						</Popover>
					)}
					{hasFilters && (
						<button
							className="text-xs text-muted-foreground hover:text-foreground transition-colors"
							onClick={() => { setFilterTagId(null); setFilterAssignedTo(null); }}
						>
							<X className="size-3.5" />
						</button>
					)}
					{groups.length > 0 && (
						<Button
							size="sm"
							className="gap-1.5 h-7 text-xs"
							onClick={() => {
								setCreateGroupId(null);
								setCreateDialogOpen(true);
							}}
						>
							<Plus className="size-3.5" />
							New Idea
						</Button>
					)}
				</div>
			</div>

			{error && (
				<div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
					{error}
				</div>
			)}

			{loading ? (
				<div className="flex items-center justify-center py-20">
					<Loader2 className="size-5 animate-spin text-muted-foreground" />
				</div>
			) : groups.length === 0 ? (
				<motion.div
					variants={stagger}
					initial="hidden"
					animate="visible"
					className="flex flex-col items-center justify-center py-20"
				>
					<motion.div
						variants={fadeUp}
						className="rounded-md border border-dashed border-border p-12 text-center max-w-sm w-full"
					>
						<Lightbulb className="size-8 text-muted-foreground/40 mx-auto mb-3" />
						<p className="text-sm font-medium">Plan your content</p>
						<p className="text-xs text-muted-foreground mt-1 mb-4">
							Create your first idea group and start capturing content ideas
							before turning them into posts.
						</p>
						<Button
							size="sm"
							className="gap-1.5 h-7 text-xs"
							onClick={() => handleCreateGroup("Ideas", "#6366f1")}
						>
							<Plus className="size-3.5" />
							New Group
						</Button>
					</motion.div>
				</motion.div>
			) : (
				<div className="overflow-x-auto -mx-4 px-4 pb-2">
					<IdeaBoard
						groups={sortedGroups}
						ideasByGroup={ideasByGroup}
						onMoveIdea={handleMoveIdea}
						onReorderGroups={handleReorderGroups}
						onRenameGroup={handleRenameGroup}
						onDeleteGroup={handleDeleteGroup}
						onCreateGroup={handleCreateGroup}
						onClickIdea={handleClickIdea}
						onNewIdea={handleNewIdea}
					/>
				</div>
			)}

			{/* Edit dialog */}
			<IdeaDetailDialog
				open={detailOpen}
				onOpenChange={setDetailOpen}
				idea={selectedIdea}
				groups={sortedGroups}
				allTags={tags}
				onSave={handleSaveIdea}
				onCreate={handleCreateIdea}
				onMove={handleMoveIdeaToGroup}
				onConvert={handleConvertIdea}
				onRefetch={() => {
					refetchIdeas();
					refetchGroups();
				}}
			/>

			{/* Create dialog */}
			<IdeaDetailDialog
				open={createDialogOpen}
				onOpenChange={setCreateDialogOpen}
				createMode
				createGroupId={createGroupId}
				groups={sortedGroups}
				allTags={tags}
				onSave={handleSaveIdea}
				onCreate={handleCreateIdea}
				onMove={handleMoveIdeaToGroup}
				onConvert={handleConvertIdea}
				onRefetch={() => {
					refetchIdeas();
					refetchGroups();
				}}
			/>
		</div>
	);
}
