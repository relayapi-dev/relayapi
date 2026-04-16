import {
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	ArrowRightLeft,
	ChevronDown,
	FileText,
	Loader2,
	MessageCircle,
	Paperclip,
	Send,
	Tag,
	Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Idea, IdeaComment, IdeaGroup, IdeaMedia, IdeaTag } from "./types";

// ── Types ──

interface ActivityEntry {
	id: string;
	actor_id: string | null;
	action: string;
	diff: Record<string, unknown> | null;
	created_at: string;
}

interface IdeaDetailDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	// Edit mode
	idea?: Idea | null;
	// Create mode
	createMode?: boolean;
	createGroupId?: string | null;
	// Data
	groups: IdeaGroup[];
	allTags: IdeaTag[];
	// Callbacks
	onSave: (
		id: string,
		data: { title?: string | null; content?: string | null; tag_ids?: string[] },
	) => Promise<void>;
	onCreate: (data: {
		title?: string;
		content?: string;
		group_id?: string;
		tag_ids?: string[];
	}) => Promise<void>;
	onMove: (id: string, groupId: string) => Promise<void>;
	onConvert: (id: string) => void;
	onRefetch: () => void;
}

// ── Helper: auto-resize textarea ──

function useAutoResize(value: string) {
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [value]);
	return ref;
}

// ── Media thumbnail ──

function MediaThumb({ item }: { item: IdeaMedia }) {
	if (item.type === "image" || item.type === "gif") {
		return (
			<img
				src={item.url}
				alt={item.alt ?? "media"}
				className="size-16 rounded object-cover border border-border"
			/>
		);
	}
	const Icon = item.type === "video" ? Video : FileText;
	return (
		<div className="size-16 rounded border border-border bg-accent/30 flex items-center justify-center">
			<Icon className="size-6 text-muted-foreground" />
		</div>
	);
}

// ── Comment thread ──

function CommentItem({
	comment,
	replies,
}: {
	comment: IdeaComment;
	replies: IdeaComment[];
}) {
	return (
		<div className="space-y-2">
			<div className="flex gap-2">
				<div className="size-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-medium shrink-0 mt-0.5">
					{comment.author_id.slice(0, 2).toUpperCase()}
				</div>
				<div className="flex-1">
					<p className="text-xs text-muted-foreground mb-0.5">
						<time dateTime={comment.created_at}>
							{new Date(comment.created_at).toLocaleDateString(undefined, {
								month: "short",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							})}
						</time>
					</p>
					<p className="text-sm">{comment.content}</p>
				</div>
			</div>
			{replies.length > 0 && (
				<div className="ml-6 space-y-2">
					{replies.map((r) => (
						<div key={r.id} className="flex gap-2">
							<div className="size-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-medium shrink-0 mt-0.5">
								{r.author_id.slice(0, 2).toUpperCase()}
							</div>
							<div className="flex-1">
								<p className="text-xs text-muted-foreground mb-0.5">
									<time dateTime={r.created_at}>
										{new Date(r.created_at).toLocaleDateString(undefined, {
											month: "short",
											day: "numeric",
											hour: "2-digit",
											minute: "2-digit",
										})}
									</time>
								</p>
								<p className="text-sm">{r.content}</p>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ── Main component ──

export function IdeaDetailDialog({
	open,
	onOpenChange,
	idea,
	createMode = false,
	createGroupId,
	groups,
	allTags,
	onSave,
	onCreate,
	onMove,
	onConvert,
	onRefetch,
}: IdeaDetailDialogProps) {
	const isEditMode = !createMode && !!idea;

	// Form state
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const [groupId, setGroupId] = useState<string>("");

	// Comments state
	const [comments, setComments] = useState<IdeaComment[]>([]);
	const [commentsLoading, setCommentsLoading] = useState(false);
	const [newComment, setNewComment] = useState("");
	const [submittingComment, setSubmittingComment] = useState(false);

	// Activity state
	const [showActivity, setShowActivity] = useState(false);
	const [activity, setActivity] = useState<ActivityEntry[]>([]);
	const [activityLoading, setActivityLoading] = useState(false);
	const [activityFetched, setActivityFetched] = useState(false);

	// Save state
	const [saving, setSaving] = useState(false);

	// Tag popover
	const [tagPopoverOpen, setTagPopoverOpen] = useState(false);

	// Auto-resize ref
	const contentRef = useAutoResize(content);

	// Sync state when idea changes
	useEffect(() => {
		if (open) {
			setTitle(idea?.title ?? "");
			setContent(idea?.content ?? "");
			setSelectedTagIds(idea?.tags?.map((t) => t.id) ?? []);
			setGroupId(idea?.group_id ?? createGroupId ?? groups[0]?.id ?? "");
			setComments([]);
			setNewComment("");
			setShowActivity(false);
			setActivity([]);
			setActivityFetched(false);
		}
	}, [open, idea, createGroupId, groups]);

	// Fetch comments when dialog opens (edit mode only)
	useEffect(() => {
		if (!open || !isEditMode || !idea) return;
		setCommentsLoading(true);
		fetch(`/api/ideas/${idea.id}/comments?limit=50`)
			.then((r) => (r.ok ? r.json() : { data: [] }))
			.then((res) => setComments(res.data ?? []))
			.catch(() => {})
			.finally(() => setCommentsLoading(false));
	}, [open, isEditMode, idea?.id]);

	// Fetch activity on first toggle
	const handleToggleActivity = useCallback(() => {
		const next = !showActivity;
		setShowActivity(next);
		if (next && !activityFetched && idea) {
			setActivityLoading(true);
			fetch(`/api/ideas/${idea.id}/activity?limit=20`)
				.then((r) => (r.ok ? r.json() : { data: [] }))
				.then((res) => {
					setActivity(res.data ?? []);
					setActivityFetched(true);
				})
				.catch(() => setActivityFetched(true))
				.finally(() => setActivityLoading(false));
		}
	}, [showActivity, activityFetched, idea?.id]);

	// Submit comment
	const handleSubmitComment = useCallback(async () => {
		if (!newComment.trim() || !idea) return;
		setSubmittingComment(true);
		try {
			const res = await fetch(`/api/ideas/${idea.id}/comments`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: newComment.trim() }),
			});
			if (res.ok) {
				const created = await res.json();
				setComments((prev) => [...prev, created]);
				setNewComment("");
			}
		} catch {
			// silently ignore
		} finally {
			setSubmittingComment(false);
		}
	}, [newComment, idea?.id]);

	// Handle group change
	const handleGroupChange = useCallback(
		async (newGroupId: string) => {
			setGroupId(newGroupId);
			if (isEditMode && idea && newGroupId !== idea.group_id) {
				await onMove(idea.id, newGroupId);
				onRefetch();
			}
		},
		[isEditMode, idea, onMove, onRefetch],
	);

	// Handle save / create
	const handleSubmit = useCallback(async () => {
		setSaving(true);
		try {
			if (isEditMode && idea) {
				await onSave(idea.id, {
					title: title.trim() || null,
					content: content.trim() || null,
					tag_ids: selectedTagIds,
				});
				onRefetch();
				onOpenChange(false);
			} else {
				await onCreate({
					title: title.trim() || undefined,
					content: content.trim() || undefined,
					group_id: groupId || undefined,
					tag_ids: selectedTagIds,
				});
				onRefetch();
				onOpenChange(false);
			}
		} catch {
			// silently ignore — parent should handle errors
		} finally {
			setSaving(false);
		}
	}, [
		isEditMode,
		idea,
		title,
		content,
		selectedTagIds,
		groupId,
		onSave,
		onCreate,
		onRefetch,
		onOpenChange,
	]);

	// Build threaded comment list
	const topLevelComments = comments.filter((c) => !c.parent_id);
	const repliesMap = comments.reduce<Record<string, IdeaComment[]>>(
		(acc, c) => {
			if (c.parent_id) {
				acc[c.parent_id] = [...(acc[c.parent_id] ?? []), c];
			}
			return acc;
		},
		{},
	);

	const dialogTitle = isEditMode ? "Edit Idea" : "New Idea";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0"
			>
				{/* Header */}
				<DialogHeader className="flex-row items-center justify-between px-5 py-3 border-b border-border gap-3 space-y-0">
					<DialogTitle className="text-sm font-medium shrink-0">
						{dialogTitle}
					</DialogTitle>

					<div className="flex items-center gap-2 ml-auto">
						{/* Group select */}
						{groups.length > 0 && (
							<Select value={groupId} onValueChange={handleGroupChange}>
								<SelectTrigger size="sm" className="h-7 text-xs gap-1 pr-2">
									<SelectValue placeholder="Group" />
								</SelectTrigger>
								<SelectContent align="end">
									{groups.map((g) => (
										<SelectItem key={g.id} value={g.id}>
											<span className="flex items-center gap-1.5">
												{g.color && (
													<span
														className="size-2 rounded-full shrink-0"
														style={{ backgroundColor: g.color }}
													/>
												)}
												{g.name}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}

						{/* Tags popover */}
						<Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
							<PopoverTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									className="h-7 text-xs gap-1 px-2"
								>
									<Tag className="size-3" />
									Tags
									{selectedTagIds.length > 0 && (
										<span className="ml-0.5 rounded-full bg-primary text-primary-foreground px-1 text-[10px] leading-4">
											{selectedTagIds.length}
										</span>
									)}
									<ChevronDown className="size-3 opacity-50" />
								</Button>
							</PopoverTrigger>
							<PopoverContent align="end" className="w-52 p-2">
								{allTags.length === 0 ? (
									<p className="text-xs text-muted-foreground text-center py-2">
										No tags yet
									</p>
								) : (
									<div className="space-y-1">
										{allTags.map((tag) => {
											const checked = selectedTagIds.includes(tag.id);
											return (
												<label
													key={tag.id}
													className="flex items-center gap-2 rounded px-1.5 py-1 cursor-pointer hover:bg-accent/40 text-sm"
												>
													<Checkbox
														checked={checked}
														onCheckedChange={(v) => {
															setSelectedTagIds((prev) =>
																v
																	? [...prev, tag.id]
																	: prev.filter((id) => id !== tag.id),
															);
														}}
													/>
													<span
														className="size-2 rounded-full shrink-0"
														style={{ backgroundColor: tag.color }}
													/>
													{tag.name}
												</label>
											);
										})}
									</div>
								)}
							</PopoverContent>
						</Popover>

						{/* Close button */}
						<button
							type="button"
							onClick={() => onOpenChange(false)}
							className="rounded-xs opacity-70 hover:opacity-100 transition-opacity p-0.5"
							aria-label="Close"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M18 6 6 18" />
								<path d="m6 6 12 12" />
							</svg>
						</button>
					</div>
				</DialogHeader>

				{/* Scrollable content */}
				<div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">
					{/* Title */}
					<input
						type="text"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Add a title..."
						className="w-full bg-transparent text-base font-medium placeholder:text-muted-foreground/50 outline-none border-none focus:ring-0 p-0"
					/>

					{/* Content */}
					<textarea
						ref={contentRef}
						value={content}
						onChange={(e) => setContent(e.target.value)}
						placeholder="Write your idea..."
						rows={3}
						className="w-full bg-transparent text-sm placeholder:text-muted-foreground/50 outline-none border-none focus:ring-0 p-0 resize-none overflow-hidden"
					/>

					{/* Media (edit mode only) */}
					{isEditMode && idea && idea.media.length > 0 && (
						<div>
							<p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
								<Paperclip className="size-3" />
								Media
							</p>
							<div className="flex flex-wrap gap-2">
								{idea.media
									.slice()
									.sort((a, b) => a.position - b.position)
									.map((m) => (
										<MediaThumb key={m.id} item={m} />
									))}
							</div>
						</div>
					)}

					{/* Comments (edit mode only) */}
					{isEditMode && (
						<div>
							<p className="text-xs font-medium text-muted-foreground mb-3 flex items-center gap-1">
								<MessageCircle className="size-3" />
								Comments
							</p>

							{commentsLoading ? (
								<div className="flex items-center justify-center py-4">
									<Loader2 className="size-4 animate-spin text-muted-foreground" />
								</div>
							) : topLevelComments.length === 0 ? (
								<p className="text-xs text-muted-foreground py-2">
									No comments yet.
								</p>
							) : (
								<div className="space-y-4 mb-3">
									{topLevelComments.map((c) => (
										<CommentItem
											key={c.id}
											comment={c}
											replies={repliesMap[c.id] ?? []}
										/>
									))}
								</div>
							)}

							{/* Comment input */}
							<div className="flex items-center gap-2 border border-border rounded-md px-3 py-2 mt-2">
								<input
									type="text"
									value={newComment}
									onChange={(e) => setNewComment(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											void handleSubmitComment();
										}
									}}
									placeholder="Add a comment..."
									className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground/50 outline-none border-none focus:ring-0 p-0"
								/>
								<button
									type="button"
									onClick={() => void handleSubmitComment()}
									disabled={!newComment.trim() || submittingComment}
									className={cn(
										"text-muted-foreground transition-colors",
										newComment.trim() && !submittingComment
											? "hover:text-foreground"
											: "opacity-40 cursor-not-allowed",
									)}
								>
									{submittingComment ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<Send className="size-4" />
									)}
								</button>
							</div>
						</div>
					)}

					{/* Activity section (edit mode, toggle) */}
					{isEditMode && showActivity && (
						<div>
							<p className="text-xs font-medium text-muted-foreground mb-3">
								Activity
							</p>
							{activityLoading ? (
								<div className="flex items-center justify-center py-4">
									<Loader2 className="size-4 animate-spin text-muted-foreground" />
								</div>
							) : activity.length === 0 ? (
								<p className="text-xs text-muted-foreground py-2">
									No activity yet.
								</p>
							) : (
								<div className="space-y-2">
									{activity.map((entry) => (
										<div key={entry.id} className="flex items-start gap-2 text-xs">
											<div className="size-5 rounded-full bg-muted flex items-center justify-center text-[9px] font-medium text-muted-foreground shrink-0 mt-0.5">
												{entry.actor_id
													? entry.actor_id.slice(0, 2).toUpperCase()
													: "–"}
											</div>
											<div className="flex-1">
												<span className="text-foreground">{entry.action}</span>
												<span className="ml-2 text-muted-foreground">
													{new Date(entry.created_at).toLocaleDateString(
														undefined,
														{
															month: "short",
															day: "numeric",
															hour: "2-digit",
															minute: "2-digit",
														},
													)}
												</span>
											</div>
										</div>
									))}
								</div>
							)}
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-between px-5 py-3 border-t border-border gap-3">
					{/* Left: Activity toggle (edit mode only) */}
					<div>
						{isEditMode && (
							<Button
								variant="ghost"
								size="sm"
								className="h-7 text-xs gap-1"
								onClick={handleToggleActivity}
							>
								Activity
								<ChevronDown
									className={cn(
										"size-3 opacity-50 transition-transform",
										showActivity && "rotate-180",
									)}
								/>
							</Button>
						)}
					</div>

					{/* Right: Actions */}
					<div className="flex items-center gap-2">
						{/* Convert to Post (edit mode only) */}
						{isEditMode && idea && (
							<Button
								variant="outline"
								size="sm"
								className="h-7 text-xs gap-1"
								onClick={() => onConvert(idea.id)}
								disabled={!!idea.converted_to_post_id}
								title={
									idea.converted_to_post_id
										? "Already converted to a post"
										: "Convert to Post"
								}
							>
								<ArrowRightLeft className="size-3" />
								Convert to Post
							</Button>
						)}

						{/* Save / Create */}
						<Button
							size="sm"
							className="h-7 text-xs"
							onClick={handleSubmit}
							disabled={saving}
						>
							{saving ? (
								<Loader2 className="size-3 animate-spin mr-1" />
							) : null}
							{isEditMode ? "Save" : "Create"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
