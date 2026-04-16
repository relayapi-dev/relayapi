import { useCallback, useEffect, useRef, useState } from "react";
import {
	ArrowRightLeft,
	ChevronDown,
	Film,
	Image as ImageIcon,
	Loader2,
	MessageCircle,
	Paperclip,
	Send,
	Tag,
	Trash2,
	Upload,
	X,
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

interface ActivityEntry {
	id: string;
	actor_id: string | null;
	action: string;
	created_at: string;
}

interface IdeaDetailDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	idea?: Idea | null;
	createMode?: boolean;
	createGroupId?: string | null;
	groups: IdeaGroup[];
	allTags: IdeaTag[];
	onSave: (
		id: string,
		data: { title?: string | null; content?: string | null; tag_ids?: string[] },
	) => Promise<void>;
	onCreate: (data: {
		title?: string;
		content?: string;
		group_id?: string;
		tag_ids?: string[];
		media?: Array<{
			url: string;
			type?: "image" | "video" | "gif" | "document";
			alt?: string;
		}>;
	}) => Promise<Idea>;
	onMove: (id: string, groupId: string) => Promise<void>;
	onConvert: (id: string) => void;
	onDelete?: (id: string) => Promise<void>;
	onMediaChange: (ideaId: string, media: IdeaMedia[]) => void;
}

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

function sortMedia(list: IdeaMedia[]) {
	return [...list].sort((a, b) => a.position - b.position);
}

interface PendingFile {
	id: string;
	file: File;
	previewUrl: string;
	kind: "image" | "video" | "gif" | "document";
}

function pendingKind(file: File): PendingFile["kind"] {
	const mime = file.type.toLowerCase();
	if (mime === "image/gif") return "gif";
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("video/")) return "video";
	return "document";
}

function MediaTile({
	url,
	type,
	onRemove,
}: {
	url: string;
	type?: "image" | "video" | "gif" | "document" | string;
	onRemove: () => void;
}) {
	const [imgError, setImgError] = useState(false);
	const [videoError, setVideoError] = useState(false);

	const isImage =
		type === "image" ||
		type === "gif" ||
		/\.(jpg|jpeg|png|webp|avif|gif|svg)(\?|$)/i.test(url);
	const isVideo =
		type === "video" ||
		/\.(mp4|mov|avi|webm|mkv)(\?|$)/i.test(url);

	return (
		<div className="group relative rounded-xl overflow-hidden border border-border bg-accent/5">
			{isImage && !imgError ? (
				<img
					src={url}
					alt=""
					className="w-full max-h-52 object-cover"
					onError={() => setImgError(true)}
				/>
			) : isImage && imgError ? (
				<div className="w-full h-32 flex flex-col items-center justify-center gap-2 bg-accent/10">
					<ImageIcon className="size-8 text-muted-foreground/50" />
					<span className="text-[10px] text-muted-foreground font-mono truncate max-w-48 px-2">
						{url.split("/").pop()?.split("?")[0] || "image"}
					</span>
				</div>
			) : isVideo && !videoError ? (
				<video
					src={url}
					className="w-full max-h-64 bg-black rounded-none"
					preload="metadata"
					controls
					playsInline
					onError={() => setVideoError(true)}
				/>
			) : isVideo && videoError ? (
				<div className="w-full h-32 flex flex-col items-center justify-center gap-2 bg-accent/10">
					<Film className="size-8 text-muted-foreground/50" />
					<span className="text-[10px] text-muted-foreground">
						Video preview unavailable
					</span>
				</div>
			) : (
				<div className="w-full h-32 flex flex-col items-center justify-center gap-2 bg-accent/10">
					<ImageIcon className="size-8 text-muted-foreground/50" />
					<span className="text-[10px] text-muted-foreground uppercase">
						{type || "file"}
					</span>
				</div>
			)}
			{type && (
				<span className="absolute bottom-2 left-2 text-[9px] rounded-md bg-black/60 px-1.5 py-0.5 text-white uppercase pointer-events-none">
					{type}
				</span>
			)}
			<button
				type="button"
				onClick={onRemove}
				className="absolute top-2 right-2 rounded-full bg-black/60 p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
				aria-label="Remove media"
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

function commentInitials(comment: IdeaComment): string {
	const name = comment.author?.name?.trim();
	if (name) {
		const parts = name.split(/\s+/).filter(Boolean);
		if (parts.length >= 2) {
			return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
		}
		return name.slice(0, 2).toUpperCase();
	}
	const fallback = comment.author?.id ?? comment.author_id;
	return fallback.slice(-2).toUpperCase();
}

function CommentAvatar({ comment }: { comment: IdeaComment }) {
	if (comment.author?.image) {
		return (
			<img
				src={comment.author.image}
				alt={comment.author.name ?? ""}
				className="size-6 rounded-full object-cover shrink-0 mt-0.5"
			/>
		);
	}
	return (
		<div className="size-6 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-medium shrink-0 mt-0.5">
			{commentInitials(comment)}
		</div>
	);
}

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
				<CommentAvatar comment={comment} />
				<div className="flex-1">
					<p className="text-xs text-muted-foreground mb-0.5">
						{comment.author?.name && (
							<span className="text-foreground font-medium mr-1.5">
								{comment.author.name}
							</span>
						)}
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
					{replies.map((reply) => (
						<div key={reply.id} className="flex gap-2">
							<CommentAvatar comment={reply} />
							<div className="flex-1">
								<p className="text-xs text-muted-foreground mb-0.5">
									{reply.author?.name && (
										<span className="text-foreground font-medium mr-1.5">
											{reply.author.name}
										</span>
									)}
									<time dateTime={reply.created_at}>
										{new Date(reply.created_at).toLocaleDateString(undefined, {
											month: "short",
											day: "numeric",
											hour: "2-digit",
											minute: "2-digit",
										})}
									</time>
								</p>
								<p className="text-sm">{reply.content}</p>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

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
	onDelete,
	onMediaChange,
}: IdeaDetailDialogProps) {
	const isEditMode = !createMode && !!idea;

	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const [groupId, setGroupId] = useState("");
	const [media, setMedia] = useState<IdeaMedia[]>([]);
	const [comments, setComments] = useState<IdeaComment[]>([]);
	const [commentsLoading, setCommentsLoading] = useState(false);
	const [newComment, setNewComment] = useState("");
	const [submittingComment, setSubmittingComment] = useState(false);
	const [showActivity, setShowActivity] = useState(false);
	const [activity, setActivity] = useState<ActivityEntry[]>([]);
	const [activityLoading, setActivityLoading] = useState(false);
	const [activityFetched, setActivityFetched] = useState(false);
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
	const [uploadingMedia, setUploadingMedia] = useState(false);
	const [mediaError, setMediaError] = useState<string | null>(null);
	const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

	const submitInFlightRef = useRef(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const contentRef = useAutoResize(content);

	useEffect(() => {
		if (!open) return;

		setTitle(idea?.title ?? "");
		setContent(idea?.content ?? "");
		setSelectedTagIds(idea?.tags.map((tag) => tag.id) ?? []);
		setGroupId(idea?.group_id ?? createGroupId ?? groups[0]?.id ?? "");
		setMedia(sortMedia(idea?.media ?? []));
		setMediaError(null);
		setPendingFiles((prev) => {
			for (const p of prev) URL.revokeObjectURL(p.previewUrl);
			return [];
		});
		setComments([]);
		setNewComment("");
		setShowActivity(false);
		setActivity([]);
		setActivityFetched(false);
	}, [open, idea?.id, createGroupId]);

	useEffect(() => {
		return () => {
			setPendingFiles((prev) => {
				for (const p of prev) URL.revokeObjectURL(p.previewUrl);
				return [];
			});
		};
	}, []);

	useEffect(() => {
		if (!open || !isEditMode || !idea) return;

		setCommentsLoading(true);
		fetch(`/api/ideas/${idea.id}/comments?limit=50`)
			.then((response) => (response.ok ? response.json() : { data: [] }))
			.then((response) => setComments(response.data ?? []))
			.catch(() => {})
			.finally(() => setCommentsLoading(false));
	}, [open, isEditMode, idea?.id]);

	const handleToggleActivity = useCallback(() => {
		const next = !showActivity;
		setShowActivity(next);

		if (next && !activityFetched && idea) {
			setActivityLoading(true);
			fetch(`/api/ideas/${idea.id}/activity?limit=20`)
				.then((response) => (response.ok ? response.json() : { data: [] }))
				.then((response) => {
					setActivity(response.data ?? []);
					setActivityFetched(true);
				})
				.catch(() => setActivityFetched(true))
				.finally(() => setActivityLoading(false));
		}
	}, [showActivity, activityFetched, idea?.id]);

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
			// Ignore inline comment errors for now.
		} finally {
			setSubmittingComment(false);
		}
	}, [newComment, idea?.id]);

	const syncMedia = useCallback(
		(nextMedia: IdeaMedia[]) => {
			const sorted = sortMedia(nextMedia);
			setMedia(sorted);
			if (idea) {
				onMediaChange(idea.id, sorted);
			}
		},
		[idea, onMediaChange],
	);

	const handleUploadMedia = useCallback(
		async (files: FileList | null) => {
			if (!idea || !files?.length) return;

			setUploadingMedia(true);
			setMediaError(null);

			try {
				for (const file of Array.from(files)) {
					const formData = new FormData();
					formData.set("file", file);

					const res = await fetch(`/api/ideas/${idea.id}/media`, {
						method: "POST",
						body: formData,
					});
					if (!res.ok) {
						const errorBody = await res.json().catch(() => null);
						throw new Error(
							errorBody?.error?.message || `Upload failed (${res.status})`,
						);
					}

					const uploadedMedia = (await res.json()) as IdeaMedia;
					setMedia((prev) => {
						const next = sortMedia([...prev, uploadedMedia]);
						onMediaChange(idea.id, next);
						return next;
					});
				}
			} catch (error) {
				setMediaError(
					error instanceof Error ? error.message : "Failed to upload media.",
				);
			} finally {
				setUploadingMedia(false);
				if (fileInputRef.current) {
					fileInputRef.current.value = "";
				}
			}
		},
		[idea, onMediaChange],
	);

	const handleBufferFiles = useCallback((files: FileList | null) => {
		if (!files?.length) return;
		const additions: PendingFile[] = Array.from(files).map((file) => ({
			id: `pending-${crypto.randomUUID()}`,
			file,
			previewUrl: URL.createObjectURL(file),
			kind: pendingKind(file),
		}));
		setPendingFiles((prev) => [...prev, ...additions]);
		setMediaError(null);
	}, []);

	const handleRemovePendingFile = useCallback((id: string) => {
		setPendingFiles((prev) => {
			const target = prev.find((p) => p.id === id);
			if (target) URL.revokeObjectURL(target.previewUrl);
			return prev.filter((p) => p.id !== id);
		});
	}, []);

	const handleFileInputChange = useCallback(
		(files: FileList | null) => {
			if (isEditMode) {
				void handleUploadMedia(files);
			} else {
				handleBufferFiles(files);
				if (fileInputRef.current) fileInputRef.current.value = "";
			}
		},
		[isEditMode, handleUploadMedia, handleBufferFiles],
	);

	const handleDeleteMedia = useCallback(
		async (mediaId: string) => {
			if (!idea) return;

			const previousMedia = media;
			const nextMedia = previousMedia.filter((item) => item.id !== mediaId);
			syncMedia(nextMedia);
			setMediaError(null);

			const res = await fetch(`/api/ideas/${idea.id}/media/${mediaId}`, {
				method: "DELETE",
			});
			if (res.ok || res.status === 204) return;

			syncMedia(previousMedia);
			const errorBody = await res.json().catch(() => null);
			setMediaError(
				errorBody?.error?.message || `Failed to delete media (${res.status})`,
			);
		},
		[idea, media, syncMedia],
	);

	const handleGroupChange = useCallback(
		async (newGroupId: string) => {
			setGroupId(newGroupId);

			if (!isEditMode || !idea || newGroupId === idea.group_id) {
				return;
			}

			try {
				await onMove(idea.id, newGroupId);
			} catch {
				setGroupId(idea.group_id);
			}
		},
		[isEditMode, idea, onMove],
	);

	const handleSubmit = useCallback(async () => {
		if (submitInFlightRef.current) return;

		submitInFlightRef.current = true;
		setSaving(true);
		setMediaError(null);

		try {
			if (isEditMode && idea) {
				await onSave(idea.id, {
					title: title.trim() || null,
					content: content.trim() || null,
					tag_ids: selectedTagIds,
				});
			} else {
				let uploadedMedia:
					| Array<{
							url: string;
							type?: "image" | "video" | "gif" | "document";
							alt?: string;
					  }>
					| undefined;

				if (pendingFiles.length > 0) {
					uploadedMedia = [];
					for (const pending of pendingFiles) {
						const qs = new URLSearchParams({ filename: pending.file.name });
						const res = await fetch(`/api/media/upload?${qs.toString()}`, {
							method: "POST",
							headers: {
								"Content-Type":
									pending.file.type || "application/octet-stream",
							},
							body: pending.file,
						});
						if (!res.ok) {
							const errorBody = await res.json().catch(() => null);
							throw new Error(
								errorBody?.error?.message || `Upload failed (${res.status})`,
							);
						}
						const uploaded = (await res.json()) as { url: string };
						uploadedMedia.push({ url: uploaded.url, type: pending.kind });
					}
				}

				await onCreate({
					title: title.trim() || undefined,
					content: content.trim() || undefined,
					group_id: groupId || undefined,
					tag_ids: selectedTagIds,
					media: uploadedMedia,
				});
			}

			onOpenChange(false);
		} catch (error) {
			if (!isEditMode) {
				setMediaError(
					error instanceof Error ? error.message : "Failed to create idea.",
				);
			}
			// Edit-mode errors are handled by parent mutation handlers.
		} finally {
			submitInFlightRef.current = false;
			setSaving(false);
		}
	}, [
		isEditMode,
		idea,
		title,
		content,
		selectedTagIds,
		groupId,
		pendingFiles,
		onSave,
		onCreate,
		onOpenChange,
	]);

	const handleDelete = useCallback(async () => {
		if (!isEditMode || !idea || !onDelete) return;
		if (!window.confirm("Delete this idea? This cannot be undone.")) return;

		setDeleting(true);
		try {
			await onDelete(idea.id);
			onOpenChange(false);
		} catch {
			// Parent mutation handlers already own the failure path.
		} finally {
			setDeleting(false);
		}
	}, [isEditMode, idea, onDelete, onOpenChange]);

	const topLevelComments = comments.filter((comment) => !comment.parent_id);
	const repliesMap = comments.reduce<Record<string, IdeaComment[]>>(
		(acc, comment) => {
			if (comment.parent_id) {
				acc[comment.parent_id] = [...(acc[comment.parent_id] ?? []), comment];
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
				<DialogHeader className="flex-row items-center justify-between px-5 py-3 border-b border-border gap-3 space-y-0">
					<DialogTitle className="text-sm font-medium shrink-0">
						{dialogTitle}
					</DialogTitle>

					<div className="flex items-center gap-2 ml-auto">
						{groups.length > 0 && (
							<Select value={groupId} onValueChange={handleGroupChange}>
								<SelectTrigger size="sm" className="h-7 text-xs gap-1 pr-2">
									<SelectValue placeholder="Group" />
								</SelectTrigger>
								<SelectContent align="end">
									{groups.map((group) => (
										<SelectItem key={group.id} value={group.id}>
											<span className="flex items-center gap-1.5">
												{group.color && (
													<span
														className="size-2 rounded-full shrink-0"
														style={{ backgroundColor: group.color }}
													/>
												)}
												{group.name}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}

						<Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
							<PopoverTrigger asChild>
								<Button
									type="button"
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
														onCheckedChange={(value) => {
															setSelectedTagIds((prev) =>
																value
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

				<div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">
					<input
						type="text"
						value={title}
						onChange={(event) => setTitle(event.target.value)}
						placeholder="Add a title..."
						className="w-full bg-transparent text-base font-medium placeholder:text-muted-foreground/50 outline-none border-none focus:ring-0 p-0"
					/>

					<textarea
						ref={contentRef}
						value={content}
						onChange={(event) => setContent(event.target.value)}
						placeholder="Write your idea..."
						rows={3}
						className="w-full bg-transparent text-sm placeholder:text-muted-foreground/50 outline-none border-none focus:ring-0 p-0 resize-none overflow-hidden"
					/>

					<input
						ref={fileInputRef}
						type="file"
						multiple
						className="hidden"
						accept="image/*,video/*,.gif,.pdf"
						onChange={(event) => handleFileInputChange(event.target.files)}
					/>

					<div className="space-y-2">
						<div className="flex items-center justify-between gap-3">
							<p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
								<Paperclip className="size-3" />
								Media
							</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7 text-xs gap-1"
								onClick={() => fileInputRef.current?.click()}
								disabled={uploadingMedia || saving}
							>
								{uploadingMedia ? (
									<Loader2 className="size-3 animate-spin" />
								) : (
									<Upload className="size-3" />
								)}
								Add media
							</Button>
						</div>

						{mediaError && (
							<p className="text-xs text-destructive">{mediaError}</p>
						)}

						{(() => {
							const tiles: Array<{
								key: string;
								url: string;
								type?: "image" | "video" | "gif" | "document";
								onRemove: () => void;
							}> =
								isEditMode && idea
									? media.map((item) => ({
											key: item.id,
											url: item.url,
											type: item.type,
											onRemove: () => void handleDeleteMedia(item.id),
										}))
									: pendingFiles.map((item) => ({
											key: item.id,
											url: item.previewUrl,
											type: item.kind,
											onRemove: () => handleRemovePendingFile(item.id),
										}));

							if (tiles.length > 0) {
								return (
									<div
										className="grid gap-2"
										style={{
											gridTemplateColumns:
												tiles.length === 1
													? "max-content"
													: "repeat(auto-fill, minmax(120px, 1fr))",
										}}
									>
										{tiles.map((tile) => (
											<MediaTile
												key={tile.key}
												url={tile.url}
												type={tile.type}
												onRemove={tile.onRemove}
											/>
										))}
									</div>
								);
							}

							return (
								<button
									type="button"
									onClick={() => fileInputRef.current?.click()}
									className="w-32 h-28 rounded-lg border-2 border-dashed border-border hover:border-primary/40 flex flex-col items-center justify-center gap-1.5 transition-colors cursor-pointer"
								>
									<Upload className="size-5 text-muted-foreground" />
									<span className="text-[11px] text-muted-foreground leading-tight text-center px-2">
										Click to attach media
									</span>
								</button>
							);
						})()}
					</div>

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
									{topLevelComments.map((comment) => (
										<CommentItem
											key={comment.id}
											comment={comment}
											replies={repliesMap[comment.id] ?? []}
										/>
									))}
								</div>
							)}

							<div className="flex items-center gap-2 border border-border rounded-md px-3 py-2 mt-2">
								<input
									type="text"
									value={newComment}
									onChange={(event) => setNewComment(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter" && !event.shiftKey) {
											event.preventDefault();
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

				<div className="flex items-center justify-between px-5 py-3 border-t border-border gap-3">
					<div className="flex items-center gap-1">
						{isEditMode && (
							<Button
								type="button"
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
						{isEditMode && idea && onDelete && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 text-xs gap-1 text-muted-foreground hover:text-destructive"
								onClick={() => void handleDelete()}
								disabled={deleting}
								aria-label="Delete idea"
							>
								{deleting ? (
									<Loader2 className="size-3 animate-spin" />
								) : (
									<Trash2 className="size-3" />
								)}
								Delete
							</Button>
						)}
					</div>

					<div className="flex items-center gap-2">
						{isEditMode && idea && (
							<Button
								type="button"
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

						<Button
							type="button"
							size="sm"
							className="h-7 text-xs"
							onClick={() => void handleSubmit()}
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
