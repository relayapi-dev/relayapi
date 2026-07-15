import { Lightbulb, Loader2, Plus, Tags, X } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountFilterButton } from "@/components/dashboard/account-filter-button";
import { useFilterQuery } from "@/components/dashboard/filter-context";
import { IdeaBoard } from "@/components/dashboard/ideas/idea-board";
import { IdeaDetailDialog } from "@/components/dashboard/ideas/idea-detail-dialog";
import type {
	Idea,
	IdeaGroup,
	IdeaTag,
} from "@/components/dashboard/ideas/types";
import { NewPostDialog } from "@/components/dashboard/new-post-dialog";
import { PageHeader } from "@/components/dashboard/page-header";
import { WorkspaceFilterButton } from "@/components/dashboard/workspace-filter-button";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { usePaginatedApi } from "@/hooks/use-api";
import { cn } from "@/lib/utils";

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
		const targetIndex = targetIdeas.findIndex(
			(idea) => idea.id === afterIdeaId,
		);
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

	return list.map((group) => {
		const nextPosition = nextPositions.get(group.id);
		return nextPosition === undefined
			? group
			: { ...group, position: nextPosition };
	});
}

export function IdeasPage() {
	const filterQuery = useFilterQuery();

	const scrollRef = useRef<HTMLDivElement>(null);
	const [showLeftFade, setShowLeftFade] = useState(false);
	const [showRightFade, setShowRightFade] = useState(false);

	const updateScrollFades = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const maxScroll = el.scrollWidth - el.clientWidth;
		setShowLeftFade(el.scrollLeft > 4);
		setShowRightFade(maxScroll > 4 && el.scrollLeft < maxScroll - 4);
	}, []);

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
	const [convertDialogOpen, setConvertDialogOpen] = useState(false);
	const [convertIdea, setConvertIdea] = useState<{
		id: string;
		content: string | null;
		media: Array<{ url: string; type?: string }>;
	} | null>(null);

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

	useEffect(() => {
		updateScrollFades();
		const el = scrollRef.current;
		if (!el) return;
		const observer = new ResizeObserver(updateScrollFades);
		observer.observe(el);
		window.addEventListener("resize", updateScrollFades);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", updateScrollFades);
		};
	}, [updateScrollFades, sortedGroups.length]);

	const loadingInitial =
		(groupsLoading && groups.length === 0) ||
		(ideasLoading && ideas.length === 0 && groups.length === 0);
	const ideasInitialLoading = ideasLoading && ideas.length === 0;
	const error = groupsError || ideasError;

	const handleCreateGroup = async (name: string, color: string) => {
		const body: Record<string, string> = { name, color };

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
		const group = groups.find((item) => item.id === groupId);
		if (!group) return;
		const res = await fetch(`/api/idea-groups/${groupId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, expected_revision: group.revision }),
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

		if (!deletedGroup) return;
		const res = await fetch(
			`/api/idea-groups/${groupId}?expected_revision=${deletedGroup.revision}`,
			{
				method: "DELETE",
			},
		);
		if (!res.ok && res.status !== 204) return;
		refetchAll();
	};

	const handleReorderGroups = async (
		reordered: { id: string; position: number }[],
	) => {
		const previousGroups = groups;
		setGroups((prev) => applyGroupPositions(prev, reordered));

		const revisionById = new Map(
			groups.map((group) => [group.id, group.revision]),
		);
		const res = await fetch("/api/idea-groups/reorder", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				groups: reordered.map((group) => ({
					...group,
					expected_revision: revisionById.get(group.id),
				})),
			}),
		});
		if (res.ok) {
			const response = (await res.json()) as { data: IdeaGroup[] };
			setGroups(response.data);
			return;
		}

		setGroups(previousGroups);
		refetchGroups();
	};

	const handleMoveIdea = async (
		ideaId: string,
		groupId: string,
		afterIdeaId?: string | null,
	) => {
		const previousIdeas = ideas;
		const currentIdea = previousIdeas.find((idea) => idea.id === ideaId);
		if (!currentIdea) return;
		setIdeas((prev) => moveIdeaLocally(prev, ideaId, groupId, afterIdeaId));

		const body: Record<string, unknown> = {
			group_id: groupId,
			expected_revision: currentIdea.revision,
		};
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
		refetchIdeas();
	};

	const handleSaveIdea = async (
		id: string,
		data: {
			title?: string | null;
			content?: string | null;
			tag_ids?: string[];
		},
	) => {
		const currentIdea = ideas.find((idea) => idea.id === id);
		if (!currentIdea) throw new Error("Idea no longer exists");
		const res = await fetch(`/api/ideas/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...data,
				expected_revision: currentIdea.revision,
			}),
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
		const currentIdea = previousIdeas.find((idea) => idea.id === ideaId);
		if (!currentIdea) return;
		setIdeas((prev) => moveIdeaLocally(prev, ideaId, groupId));

		const res = await fetch(`/api/ideas/${ideaId}/move`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				group_id: groupId,
				expected_revision: currentIdea.revision,
			}),
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
		refetchIdeas();
	};

	const handleIdeaMediaChange = (ideaId: string, media: Idea["media"]) => {
		setIdeas((prev) =>
			prev.map((idea) => (idea.id === ideaId ? { ...idea, media } : idea)),
		);
	};

	const handleConvertIdea = (ideaId: string) => {
		const idea = ideas.find((i) => i.id === ideaId);
		if (!idea) return;
		setConvertIdea({
			id: idea.id,
			content: idea.content,
			media: idea.media.flatMap((m) =>
				m.url ? [{ url: m.url, ...(m.type ? { type: m.type } : {}) }] : [],
			),
		});
		setDetailOpen(false);
		setConvertDialogOpen(true);
	};

	const handlePostCreatedFromIdea = () => {
		setConvertIdea(null);
		refetchIdeas();
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
		<div className="flex flex-col gap-5 h-[calc(100dvh-5rem)] md:h-[calc(100dvh-2rem)]">
			<PageHeader
				title="Ideas"
				className="shrink-0"
				action={
					<div className="flex items-center gap-2">
						<WorkspaceFilterButton />
						<AccountFilterButton />

						{tags.length > 0 && (
							<Popover>
								<PopoverTrigger asChild>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className={cn(
											"h-8 gap-1.5",
											filterTagId && "border-primary",
										)}
									>
										<Tags className="size-3.5" />
										{filterTagId
											? (tags.find((tag) => tag.id === filterTagId)?.name ??
												"Tag")
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
												setFilterTagId(filterTagId === tag.id ? null : tag.id)
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

						<Button
							type="button"
							size="sm"
							onClick={() => {
								setCreateGroupId(null);
								setCreateDialogOpen(true);
							}}
						>
							<Plus className="size-4" />
							New Idea
						</Button>
					</div>
				}
			/>

			{error && (
				<div className="rounded-[12px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
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
					initial="hidden"
					animate="visible"
					className="flex flex-col items-center justify-center py-20"
				>
					<motion.div
						variants={fadeUp}
						className="rounded-[12px] border border-dashed border-border p-12 text-center max-w-sm w-full"
					>
						<Lightbulb className="size-8 text-muted-foreground/40 mx-auto mb-3" />
						<p className="text-sm font-medium">Plan your content</p>
						<p className="text-xs text-muted-foreground mt-1 mb-4">
							Create your first idea group and start capturing content ideas
							before turning them into posts.
						</p>
						<Button
							type="button"
							onClick={() => handleCreateGroup("Ideas", "#6366f1")}
						>
							<Plus className="size-4" />
							New Group
						</Button>
					</motion.div>
				</motion.div>
			) : (
				<div className="relative -mx-4 flex-1 min-h-0">
					<div
						ref={scrollRef}
						onScroll={updateScrollFades}
						className="h-full overflow-x-auto px-4 pb-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
					>
						<IdeaBoard
							groups={sortedGroups}
							ideasByGroup={ideasByGroup}
							ideasLoading={ideasInitialLoading}
							onMoveIdea={handleMoveIdea}
							onReorderGroups={handleReorderGroups}
							onRenameGroup={handleRenameGroup}
							onDeleteGroup={handleDeleteGroup}
							onCreateGroup={handleCreateGroup}
							onClickIdea={handleClickIdea}
							onNewIdea={handleNewIdea}
						/>
					</div>
					<div
						aria-hidden
						className={cn(
							"pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent transition-opacity",
							showLeftFade ? "opacity-100" : "opacity-0",
						)}
					/>
					<div
						aria-hidden
						className={cn(
							"pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent transition-opacity",
							showRightFade ? "opacity-100" : "opacity-0",
						)}
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

			<NewPostDialog
				open={convertDialogOpen}
				onOpenChange={(next) => {
					setConvertDialogOpen(next);
					if (!next) setConvertIdea(null);
				}}
				onCreated={handlePostCreatedFromIdea}
				convertFromIdea={convertIdea}
			/>
		</div>
	);
}
