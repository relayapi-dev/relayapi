import { useEffect, useMemo, useState } from "react";
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

function sortIdeasByPosition(list: Idea[]) {
	return [...list].sort((a, b) => a.position - b.position);
}

function moveIdeaLocally(
	list: Idea[],
	ideaId: string,
	targetGroupId: string,
	afterIdeaId?: string | null,
) {
	const currentIdea = list.find((idea) => idea.id === ideaId);
	if (!currentIdea) return list;

	const sourceGroupId = currentIdea.group_id;
	const remainingIdeas = list.filter((idea) => idea.id !== ideaId);
	const sourceIdeas = sortIdeasByPosition(
		remainingIdeas.filter((idea) => idea.group_id === sourceGroupId),
	);
	const targetIdeas = sortIdeasByPosition(
		remainingIdeas.filter((idea) => idea.group_id === targetGroupId),
	);

	let insertIndex = targetIdeas.length;
	if (afterIdeaId === null) {
		insertIndex = 0;
	} else if (afterIdeaId) {
		const targetIndex = targetIdeas.findIndex((idea) => idea.id === afterIdeaId);
		insertIndex = targetIndex === -1 ? targetIdeas.length : targetIndex + 1;
	}

	const movedIdea: Idea = { ...currentIdea, group_id: targetGroupId };
	const nextTargetIdeas = [...targetIdeas];
	nextTargetIdeas.splice(insertIndex, 0, movedIdea);

	const nextById = new Map<string, Idea>();
	const reindex = (ideasToIndex: Idea[], groupId: string) => {
		ideasToIndex.forEach((idea, index) => {
			nextById.set(idea.id, {
				...idea,
				group_id: groupId,
				position: index,
			});
		});
	};

	if (sourceGroupId === targetGroupId) {
		reindex(nextTargetIdeas, targetGroupId);
	} else {
		reindex(sourceIdeas, sourceGroupId);
		reindex(nextTargetIdeas, targetGroupId);
	}

	return list.map((idea) => nextById.get(idea.id) ?? idea);
}

function applyGroupPositions(
	list: IdeaGroup[],
	reordered: { id: string; position: number }[],
) {
	const nextPositions = new Map(
		reordered.map((group) => [group.id, group.position]),
	);

	return list.map((group) =>
		nextPositions.has(group.id)
			? { ...group, position: nextPositions.get(group.id)! }
			: group,
	);
}

function moveGroupIdeasToDefault(
	list: Idea[],
	deletedGroupId: string,
	defaultGroupId: string,
) {
	const defaultIdeas = sortIdeasByPosition(
		list.filter((idea) => idea.group_id === defaultGroupId),
	);
	const movedIdeas = sortIdeasByPosition(
		list.filter((idea) => idea.group_id === deletedGroupId),
	);
	if (movedIdeas.length === 0) return list;

	const maxDefaultPosition = defaultIdeas.reduce(
		(maxPosition, idea) => Math.max(maxPosition, idea.position),
		-1,
	);
	const nextById = new Map<string, Idea>();
	movedIdeas.forEach((idea, index) => {
		nextById.set(idea.id, {
			...idea,
			group_id: defaultGroupId,
			position: maxDefaultPosition + index + 1,
		});
	});

	return list.map((idea) => nextById.get(idea.id) ?? idea);
}

export function IdeasPage() {
	const filterQuery = useFilterQuery();

	const {
		data: groups,
		loading: groupsLoading,
		error: groupsError,
		refetch: refetchGroups,
		setData: setGroups,
	} = usePaginatedApi<IdeaGroup>("idea-groups", {
		query: filterQuery,
		limit: 100,
	});

	const {
		data: ideas,
		loading: ideasLoading,
		error: ideasError,
		refetch: refetchIdeas,
		setData: setIdeas,
	} = usePaginatedApi<Idea>("ideas", {
		query: filterQuery,
		limit: 100,
	});

	const { data: tags } = usePaginatedApi<IdeaTag>("tags", {
		query: filterQuery,
		limit: 100,
	});

	const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [createGroupId, setCreateGroupId] = useState<string | null>(null);

	const [filterTagId, setFilterTagId] = useState<string | null>(null);
	const [filterAssignedTo, setFilterAssignedTo] = useState<string | null>(null);
	const hasFilters = filterTagId !== null || filterAssignedTo !== null;

	useEffect(() => {
		if (!selectedIdea) return;

		const nextSelectedIdea =
			ideas.find((idea) => idea.id === selectedIdea.id) ?? null;

		if (!nextSelectedIdea) {
			setSelectedIdea(null);
			setDetailOpen(false);
			return;
		}

		if (nextSelectedIdea !== selectedIdea) {
			setSelectedIdea(nextSelectedIdea);
		}
	}, [ideas, selectedIdea]);

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
			if (filterTagId && !idea.tags.some((tag) => tag.id === filterTagId)) {
				return false;
			}
			if (filterAssignedTo && idea.assigned_to !== filterAssignedTo) {
				return false;
			}
			return true;
		});

		for (const idea of sortIdeasByPosition(filtered)) {
			const groupIdeas = map.get(idea.group_id);
			if (groupIdeas) {
				groupIdeas.push(idea);
			} else {
				map.set(idea.group_id, [idea]);
			}
		}

		return map;
	}, [groups, ideas, filterTagId, filterAssignedTo]);

	const sortedGroups = useMemo(
		() => [...groups].sort((a, b) => a.position - b.position),
		[groups],
	);

	const loading = groupsLoading || ideasLoading;
	const loadingInitial = loading && groups.length === 0;
	const error = groupsError || ideasError;

	const handleCreateGroup = async (name: string, color: string) => {
		const body: Record<string, string> = { name, color };
		if (filterQuery.workspace_id) body.workspace_id = filterQuery.workspace_id;

		const res = await fetch("/api/idea-groups", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) return;

		const createdGroup = (await res.json()) as IdeaGroup;
		setGroups((prev) => [...prev, createdGroup]);
	};

	const handleRenameGroup = async (groupId: string, name: string) => {
		const res = await fetch(`/api/idea-groups/${groupId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
		});
		if (!res.ok) return;

		const updatedGroup = (await res.json()) as IdeaGroup;
		setGroups((prev) =>
			prev.map((group) => (group.id === groupId ? updatedGroup : group)),
		);
	};

	const handleDeleteGroup = async (groupId: string) => {
		const deletedGroup = groups.find((group) => group.id === groupId);
		const count = ideas.filter((idea) => idea.group_id === groupId).length;
		const confirmMsg =
			count > 0
				? `Delete this group and move its ${count} idea${
						count !== 1 ? "s" : ""
					} to Unassigned?`
				: "Delete this group?";
		if (!window.confirm(confirmMsg)) return;

		const res = await fetch(`/api/idea-groups/${groupId}`, {
			method: "DELETE",
		});
		if (!res.ok && res.status !== 204) return;

		setGroups((prev) => prev.filter((group) => group.id !== groupId));

		const defaultGroup = groups.find(
			(group) =>
				group.is_default &&
				group.workspace_id === deletedGroup?.workspace_id &&
				group.id !== groupId,
		);
		if (!defaultGroup) {
			refetchAll();
			return;
		}

		setIdeas((prev) => moveGroupIdeasToDefault(prev, groupId, defaultGroup.id));
	};

	const handleReorderGroups = async (
		reordered: { id: string; position: number }[],
	) => {
		const previousGroups = groups;
		setGroups((prev) => applyGroupPositions(prev, reordered));

		const res = await fetch("/api/idea-groups/reorder", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ groups: reordered }),
		});
		if (res.ok) return;

		setGroups(previousGroups);
		refetchGroups();
	};

	const handleMoveIdea = async (
		ideaId: string,
		groupId: string,
		afterIdeaId?: string | null,
	) => {
		const previousIdeas = ideas;
		setIdeas((prev) => moveIdeaLocally(prev, ideaId, groupId, afterIdeaId));

		const body: Record<string, unknown> = { group_id: groupId };
		if (afterIdeaId === null) {
			const firstTargetIdea = sortIdeasByPosition(
				ideas.filter((idea) => idea.group_id === groupId && idea.id !== ideaId),
			)[0];
			body.position = firstTargetIdea ? firstTargetIdea.position - 1 : 0;
		} else if (afterIdeaId) {
			body.after_idea_id = afterIdeaId;
		}

		const res = await fetch(`/api/ideas/${ideaId}/move`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			setIdeas(previousIdeas);
			refetchIdeas();
			return;
		}

		const updatedIdea = (await res.json()) as Idea;
		setIdeas((prev) =>
			prev.map((idea) => (idea.id === ideaId ? updatedIdea : idea)),
		);
	};

	const handleSaveIdea = async (
		id: string,
		data: { title?: string | null; content?: string | null; tag_ids?: string[] },
	) => {
		const res = await fetch(`/api/ideas/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			throw new Error(`Failed to save idea (${res.status})`);
		}

		const updatedIdea = (await res.json()) as Idea;
		setIdeas((prev) =>
			prev.map((idea) => (idea.id === id ? updatedIdea : idea)),
		);
	};

	const handleCreateIdea = async (data: {
		title?: string;
		content?: string;
		group_id?: string;
		media?: Array<{
			url: string;
			type?: "image" | "video" | "gif" | "document";
			alt?: string;
		}>;
		tag_ids?: string[];
	}) => {
		const body: Record<string, unknown> = { ...data };
		if (filterQuery.workspace_id) body.workspace_id = filterQuery.workspace_id;

		const res = await fetch("/api/ideas", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`Failed to create idea (${res.status})`);
		}

		const createdIdea = (await res.json()) as Idea;
		setIdeas((prev) => [...prev, createdIdea]);
		return createdIdea;
	};

	const handleMoveIdeaToGroup = async (ideaId: string, groupId: string) => {
		const previousIdeas = ideas;
		setIdeas((prev) => moveIdeaLocally(prev, ideaId, groupId));

		const res = await fetch(`/api/ideas/${ideaId}/move`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ group_id: groupId }),
		});
		if (!res.ok) {
			setIdeas(previousIdeas);
			refetchIdeas();
			throw new Error(`Failed to move idea (${res.status})`);
		}

		const updatedIdea = (await res.json()) as Idea;
		setIdeas((prev) =>
			prev.map((idea) => (idea.id === ideaId ? updatedIdea : idea)),
		);
	};

	const handleIdeaMediaChange = (ideaId: string, media: Idea["media"]) => {
		setIdeas((prev) =>
			prev.map((idea) => (idea.id === ideaId ? { ...idea, media } : idea)),
		);
	};

	const handleConvertIdea = (ideaId: string) => {
		console.log("Convert idea to post:", ideaId);
		// TODO: open NewPostDialog pre-filled with idea content
	};

	const handleDeleteIdea = async (ideaId: string) => {
		const previousIdeas = ideas;
		setIdeas((prev) => prev.filter((idea) => idea.id !== ideaId));

		const res = await fetch(`/api/ideas/${ideaId}`, { method: "DELETE" });
		if (!res.ok && res.status !== 204) {
			setIdeas(previousIdeas);
			throw new Error(`Failed to delete idea (${res.status})`);
		}
	};

	const handleClickIdea = (idea: Idea) => {
		setSelectedIdea(idea);
		setDetailOpen(true);
	};

	const handleNewIdea = (groupId: string | null) => {
		setCreateGroupId(groupId);
		setCreateDialogOpen(true);
	};

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-lg font-medium">Ideas</h1>
				<div className="flex items-center gap-2">
					<FilterBar />

					{tags.length > 0 && (
						<Popover>
							<PopoverTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className={cn(
										"h-7 text-xs gap-1",
										filterTagId && "border-primary",
									)}
								>
									<Tags className="size-3" />
									{filterTagId
										? tags.find((tag) => tag.id === filterTagId)?.name ?? "Tag"
										: "Tag"}
								</Button>
							</PopoverTrigger>
							<PopoverContent className="w-44 p-1.5" align="end">
								{tags.map((tag) => (
									<button
										key={tag.id}
										type="button"
										className={cn(
											"flex items-center gap-2 w-full rounded px-2 py-1.5 text-xs hover:bg-accent transition-colors",
											filterTagId === tag.id && "bg-accent",
										)}
										onClick={() =>
											setFilterTagId(
												filterTagId === tag.id ? null : tag.id,
											)
										}
									>
										<span
											className="size-2 rounded-full shrink-0"
											style={{ backgroundColor: tag.color }}
										/>
										{tag.name}
									</button>
								))}
							</PopoverContent>
						</Popover>
					)}

					{hasFilters && (
						<button
							type="button"
							className="text-xs text-muted-foreground hover:text-foreground transition-colors"
							onClick={() => {
								setFilterTagId(null);
								setFilterAssignedTo(null);
							}}
						>
							<X className="size-3.5" />
						</button>
					)}

					{groups.length > 0 && (
						<Button
							type="button"
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

			{loadingInitial ? (
				<div className="flex items-center justify-center py-20">
					<Loader2 className="size-5 animate-spin text-muted-foreground" />
				</div>
			) : groups.length === 0 ? (
				<motion.div
					variants={stagger}
					initial={false}
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
							type="button"
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
				<div className="overflow-x-auto -mx-4 px-4 pb-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
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
				onDelete={handleDeleteIdea}
				onMediaChange={handleIdeaMediaChange}
			/>

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
				onMediaChange={handleIdeaMediaChange}
			/>
		</div>
	);
}
