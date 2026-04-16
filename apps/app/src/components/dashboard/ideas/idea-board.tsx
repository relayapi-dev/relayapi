import { useEffect, useState } from "react";
import {
	DndContext,
	DragOverlay,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
	type DragEndEvent,
	type DragOverEvent,
	type DragStartEvent,
} from "@dnd-kit/core";
import {
	SortableContext,
	arrayMove,
	horizontalListSortingStrategy,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Idea, IdeaGroup } from "./types";
import { IdeaCard } from "./idea-card";
import { IdeaColumn } from "./idea-column";
import { GroupCreateInline } from "./group-create-inline";

interface IdeaBoardProps {
	groups: IdeaGroup[];
	ideasByGroup: Map<string, Idea[]>;
	onMoveIdea: (
		ideaId: string,
		groupId: string,
		afterIdeaId?: string | null,
	) => void;
	onReorderGroups: (groups: { id: string; position: number }[]) => void;
	onRenameGroup: (groupId: string, name: string) => void;
	onDeleteGroup: (groupId: string) => void;
	onCreateGroup: (name: string, color: string) => void;
	onClickIdea: (idea: Idea) => void;
	onNewIdea: (groupId: string | null) => void;
}

// Prefix constants to distinguish column DnD ids from card DnD ids
const COLUMN_PREFIX = "col::";
const CARD_PREFIX = "card::";

interface SortableCardProps {
	idea: Idea;
	onClick: () => void;
}

function SortableCard({ idea, onClick }: SortableCardProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: `${CARD_PREFIX}${idea.id}` });

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.4 : 1,
	};

	return (
		<div ref={setNodeRef} style={style} {...attributes} {...listeners}>
			<IdeaCard
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

interface SortableColumnProps {
	group: IdeaGroup;
	ideas: Idea[];
	onRename: (name: string) => void;
	onDelete: () => void;
	onClickIdea: (idea: Idea) => void;
	onNewIdea: () => void;
}

function SortableColumn({
	group,
	ideas,
	onRename,
	onDelete,
	onClickIdea,
	onNewIdea,
}: SortableColumnProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: `${COLUMN_PREFIX}${group.id}` });

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	const cardIds = ideas.map((i) => `${CARD_PREFIX}${i.id}`);

	return (
		<div ref={setNodeRef} style={style}>
			<IdeaColumn
				id={group.id}
				name={group.name}
				color={group.color}
				isDefault={group.is_default}
				count={ideas.length}
				dragHandleProps={{ ...attributes, ...listeners }}
				onRename={onRename}
				onDelete={onDelete}
				onNewIdea={onNewIdea}
			>
				<SortableContext
					items={cardIds}
					strategy={verticalListSortingStrategy}
				>
					{ideas.map((idea) => (
						<SortableCard
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
	const [localGroups, setLocalGroups] = useState<IdeaGroup[]>(groups);
	const [localIdeasByGroup, setLocalIdeasByGroup] =
		useState<Map<string, Idea[]>>(ideasByGroup);

	useEffect(() => {
		setLocalGroups(groups);
	}, [groups]);

	useEffect(() => {
		setLocalIdeasByGroup(ideasByGroup);
	}, [ideasByGroup]);

	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 8 },
		}),
	);

	const columnIds = localGroups.map((g) => `${COLUMN_PREFIX}${g.id}`);

	const activeIdea = activeId?.startsWith(CARD_PREFIX)
		? (() => {
				const id = activeId.slice(CARD_PREFIX.length);
				for (const ideas of localIdeasByGroup.values()) {
					const found = ideas.find((i) => i.id === id);
					if (found) return found;
				}
				return null;
			})()
		: null;

	const activeGroup = activeId?.startsWith(COLUMN_PREFIX)
		? localGroups.find(
				(g) => g.id === activeId.slice(COLUMN_PREFIX.length),
			) ?? null
		: null;

	const handleDragStart = (event: DragStartEvent) => {
		setActiveId(String(event.active.id));
	};

	const handleDragOver = (event: DragOverEvent) => {
		const { active, over } = event;
		if (!over) return;

		const activeIdStr = String(active.id);
		const overIdStr = String(over.id);

		// Only handle card-over-column or card-over-card (cross-column moves)
		if (!activeIdStr.startsWith(CARD_PREFIX)) return;

		const activeCardId = activeIdStr.slice(CARD_PREFIX.length);

		// Find source group
		let sourceGroupId: string | null = null;
		for (const [gId, ideas] of localIdeasByGroup.entries()) {
			if (ideas.some((i) => i.id === activeCardId)) {
				sourceGroupId = gId;
				break;
			}
		}
		if (!sourceGroupId) return;

		// Find target group
		let targetGroupId: string | null = null;
		if (overIdStr.startsWith(COLUMN_PREFIX)) {
			targetGroupId = overIdStr.slice(COLUMN_PREFIX.length);
		} else if (overIdStr.startsWith(CARD_PREFIX)) {
			const overCardId = overIdStr.slice(CARD_PREFIX.length);
			for (const [gId, ideas] of localIdeasByGroup.entries()) {
				if (ideas.some((i) => i.id === overCardId)) {
					targetGroupId = gId;
					break;
				}
			}
		}

		if (!targetGroupId || sourceGroupId === targetGroupId) return;

		// Move card across columns optimistically
		setLocalIdeasByGroup((prev) => {
			const next = new Map(prev);
			const sourceIdeas = [...(next.get(sourceGroupId!) ?? [])];
			const targetIdeas = [...(next.get(targetGroupId!) ?? [])];
			const idx = sourceIdeas.findIndex((i) => i.id === activeCardId);
			if (idx === -1) return prev;
			const [movedIdea] = sourceIdeas.splice(idx, 1);
			if (!movedIdea) return prev;
			targetIdeas.push({ ...movedIdea, group_id: targetGroupId! });
			next.set(sourceGroupId!, sourceIdeas);
			next.set(targetGroupId!, targetIdeas);
			return next;
		});
	};

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		setActiveId(null);

		if (!over) return;

		const activeIdStr = String(active.id);
		const overIdStr = String(over.id);

		// Column reorder
		if (
			activeIdStr.startsWith(COLUMN_PREFIX) &&
			overIdStr.startsWith(COLUMN_PREFIX) &&
			activeIdStr !== overIdStr
		) {
			const oldIndex = localGroups.findIndex(
				(g) => `${COLUMN_PREFIX}${g.id}` === activeIdStr,
			);
			const newIndex = localGroups.findIndex(
				(g) => `${COLUMN_PREFIX}${g.id}` === overIdStr,
			);
			if (oldIndex !== -1 && newIndex !== -1) {
				const reordered = arrayMove(localGroups, oldIndex, newIndex);
				setLocalGroups(reordered);
				onReorderGroups(
					reordered.map((g, i) => ({ id: g.id, position: i })),
				);
			}
			return;
		}

		// Card reorder / move
		if (activeIdStr.startsWith(CARD_PREFIX)) {
			const activeCardId = activeIdStr.slice(CARD_PREFIX.length);

			// Original source group — read from parent prop (unmutated by drag-over)
			let originalGroupId: string | null = null;
			for (const [gId, ideas] of ideasByGroup.entries()) {
				if (ideas.some((i) => i.id === activeCardId)) {
					originalGroupId = gId;
					break;
				}
			}
			if (!originalGroupId) return;

			// Determine target group and position
			let targetGroupId: string | null = null;
			let afterIdeaId: string | null | undefined;

			if (overIdStr.startsWith(COLUMN_PREFIX)) {
				targetGroupId = overIdStr.slice(COLUMN_PREFIX.length);
				// Dropped on column — place at end
				afterIdeaId = undefined;
			} else if (overIdStr.startsWith(CARD_PREFIX)) {
				const overCardId = overIdStr.slice(CARD_PREFIX.length);
				for (const [gId, ideas] of localIdeasByGroup.entries()) {
					if (ideas.some((i) => i.id === overCardId)) {
						targetGroupId = gId;
						break;
					}
				}

				if (targetGroupId) {
					const targetIdeas = localIdeasByGroup.get(targetGroupId) ?? [];
					const overIndex = targetIdeas.findIndex(
						(i) => i.id === overCardId,
					);
					// afterIdeaId is the idea just before the dropped position
					afterIdeaId =
						overIndex > 0
							? (targetIdeas[overIndex - 1]?.id ?? null)
							: null;
				}
			}

			if (!targetGroupId) return;

			// Cross-column move — drag-over already updated local UI optimistically
			if (targetGroupId !== originalGroupId) {
				onMoveIdea(activeCardId, targetGroupId, afterIdeaId);
				return;
			}

			// Same-group reorder — only meaningful when dropped on another card
			if (!overIdStr.startsWith(CARD_PREFIX)) return;
			const overCardId = overIdStr.slice(CARD_PREFIX.length);
			if (overCardId === activeCardId) return;

			const currentIdeas = localIdeasByGroup.get(originalGroupId) ?? [];
			const activeIndex = currentIdeas.findIndex((i) => i.id === activeCardId);
			const overIndex = currentIdeas.findIndex((i) => i.id === overCardId);
			if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
				return;
			}

			const reordered = arrayMove(currentIdeas, activeIndex, overIndex);
			setLocalIdeasByGroup((prev) => {
				const next = new Map(prev);
				next.set(originalGroupId!, reordered);
				return next;
			});
			const nextAfterIdeaId =
				overIndex > 0 ? (reordered[overIndex - 1]?.id ?? null) : null;
			onMoveIdea(activeCardId, targetGroupId, nextAfterIdeaId);
		}
	};

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragStart={handleDragStart}
			onDragOver={handleDragOver}
			onDragEnd={handleDragEnd}
		>
			<SortableContext
				items={columnIds}
				strategy={horizontalListSortingStrategy}
			>
				<div className="flex gap-4 items-start pb-4">
					{localGroups.map((group) => {
						const ideas = localIdeasByGroup.get(group.id) ?? [];
						return (
							<SortableColumn
								key={group.id}
								group={group}
								ideas={ideas}
								onRename={(name) => onRenameGroup(group.id, name)}
								onDelete={() => onDeleteGroup(group.id)}
								onClickIdea={onClickIdea}
								onNewIdea={() => onNewIdea(group.id)}
							/>
						);
					})}
					<GroupCreateInline onSubmit={onCreateGroup} />
				</div>
			</SortableContext>

			<DragOverlay>
				{activeIdea && (
					<div className="w-72 rotate-1 shadow-lg">
						<IdeaCard
							title={activeIdea.title}
							content={activeIdea.content}
							tags={activeIdea.tags}
							mediaCount={activeIdea.media.length}
							commentCount={0}
							assignedTo={activeIdea.assigned_to}
							convertedToPostId={activeIdea.converted_to_post_id}
							onClick={() => {}}
						/>
					</div>
				)}
				{activeGroup && (
					<div className="w-72 shadow-lg opacity-80">
						<IdeaColumn
							id={activeGroup.id}
							name={activeGroup.name}
							color={activeGroup.color}
							isDefault={activeGroup.is_default}
							count={
								localIdeasByGroup.get(activeGroup.id)?.length ?? 0
							}
							onRename={() => {}}
							onDelete={() => {}}
							onNewIdea={() => {}}
						>
							{(localIdeasByGroup.get(activeGroup.id) ?? [])
								.slice(0, 3)
								.map((idea) => (
									<IdeaCard
										key={idea.id}
										title={idea.title}
										content={idea.content}
										tags={idea.tags}
										mediaCount={idea.media.length}
										commentCount={0}
										assignedTo={idea.assigned_to}
										convertedToPostId={idea.converted_to_post_id}
										onClick={() => {}}
									/>
								))}
						</IdeaColumn>
					</div>
				)}
			</DragOverlay>
		</DndContext>
	);
}
