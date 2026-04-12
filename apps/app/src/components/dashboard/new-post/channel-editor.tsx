import {
	CircleDot,
	Film,
	Image,
	ImageIcon,
	Link2,
	Link2Off,
	Loader2,
	Plus,
	Upload,
	X,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
	platformAvatars,
	platformColors,
	platformLabels,
} from "@/lib/platform-maps";
import { TagInput } from "../tag-input";
import { EditorToolbar } from "./emoji-hashtag-toolbar";

// ── Types ──

interface Account {
	id: string;
	platform: string;
	platform_account_id: string;
	username: string | null;
	display_name: string | null;
	avatar_url: string | null;
	metadata: Record<string, unknown> | null;
	connected_at: string;
	updated_at: string;
}

interface ChannelEditorProps {
	accounts: Account[];
	activeTabId: string;
	// Content
	sharedContent: string;
	channelOverrides: Record<
		string,
		{ content?: string; media?: Array<{ url: string; type?: string; previewUrl?: string }> }
	>;
	unlinkedFields: Record<string, Set<string>>;
	onContentChange: (accountId: string, value: string) => void;
	onUnlinkField: (accountId: string, field: "content" | "media") => void;
	onRelinkField: (accountId: string, field: "content" | "media") => void;
	// Media
	sharedMedia: Array<{ url: string; type?: string; previewUrl?: string }>;
	onAddMediaUrl: (accountId: string, url: string) => void;
	onRemoveMedia: (accountId: string, index: number) => void;
	onFileUpload: (file: File) => void;
	uploading: boolean;
	// Platform options
	targetOptions: Record<string, Record<string, any>>;
	onSetOption: (platform: string, key: string, value: unknown) => void;
	onGetOption: (platform: string, key: string, fallback?: any) => any;
	// Textarea ref for emoji/hashtag insertion
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

// ── Content type configs ──

const IG_CONTENT_TYPES = [
	{ key: "post", label: "Post", icon: Image },
	{ key: "reels", label: "Reel", icon: Film },
	{ key: "story", label: "Story", icon: CircleDot },
];

// ── Small field helpers ──

function FieldLabel({
	children,
	required,
}: {
	children: React.ReactNode;
	required?: boolean;
}) {
	return (
		<label className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
			{children}
			{required && <span className="text-destructive">*</span>}
		</label>
	);
}

function FieldInput({
	value,
	onChange,
	placeholder,
	type = "text",
	className,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	type?: string;
	className?: string;
}) {
	return (
		<input
			type={type}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			className={cn(
				"w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground",
				className,
			)}
		/>
	);
}

function FieldTextarea({
	value,
	onChange,
	placeholder,
	rows = 2,
}: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	rows?: number;
}) {
	return (
		<textarea
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			rows={rows}
			className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
		/>
	);
}

function FieldCheckbox({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (v: boolean) => void;
	label: string;
}) {
	return (
		<label className="flex items-center gap-2 cursor-pointer">
			<Checkbox checked={checked} onCheckedChange={(c) => onChange(!!c)} />
			<span className="text-xs text-foreground">{label}</span>
		</label>
	);
}

// ── Media thumbnail with proper error handling ──

function MediaThumbnail({
	item,
	onRemove,
}: {
	item: { url: string; type?: string; previewUrl?: string };
	onRemove: () => void;
}) {
	const [imgError, setImgError] = useState(false);
	const [videoError, setVideoError] = useState(false);

	const isImage =
		item.type === "image" ||
		item.type === "gif" ||
		/\.(jpg|jpeg|png|webp|avif|gif|svg)(\?|$)/i.test(item.url);
	const isVideo =
		item.type === "video" ||
		/\.(mp4|mov|avi|webm|mkv)(\?|$)/i.test(item.url);

	const displayUrl = item.previewUrl || item.url;

	return (
		<div className="group relative rounded-xl overflow-hidden border border-border bg-accent/5">
			{isImage && !imgError ? (
				<img
					src={displayUrl}
					alt=""
					className="w-full max-h-52 object-cover"
					onError={() => setImgError(true)}
				/>
			) : isImage && imgError ? (
				<div className="w-full h-32 flex flex-col items-center justify-center gap-2 bg-accent/10">
					<ImageIcon className="size-8 text-muted-foreground/50" />
					<span className="text-[10px] text-muted-foreground font-mono truncate max-w-48 px-2">
						{item.url.split("/").pop()?.split("?")[0] || "image"}
					</span>
				</div>
			) : isVideo && !videoError ? (
				<video
					src={displayUrl}
					className="w-full max-h-64 bg-black rounded-none"
					preload="metadata"
					controls
					playsInline
					onError={() => setVideoError(true)}
				/>
			) : isVideo && videoError ? (
				<div className="w-full h-32 flex flex-col items-center justify-center gap-2 bg-accent/10">
					<Film className="size-8 text-muted-foreground/50" />
					<span className="text-[10px] text-muted-foreground">Video preview unavailable</span>
				</div>
			) : (
				<div className="w-full h-32 flex flex-col items-center justify-center gap-2 bg-accent/10">
					<ImageIcon className="size-8 text-muted-foreground/50" />
					<span className="text-[10px] text-muted-foreground uppercase">
						{item.type || "file"}
					</span>
				</div>
			)}
			{/* Type badge */}
			{item.type && (
				<span className="absolute bottom-2 left-2 text-[9px] rounded-md bg-black/60 px-1.5 py-0.5 text-white uppercase pointer-events-none">
					{item.type}
				</span>
			)}
			{/* Remove button */}
			<button
				type="button"
				onClick={onRemove}
				className="absolute top-2 right-2 rounded-full bg-black/60 p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

// ── Main component ──

export function ChannelEditor({
	accounts,
	activeTabId,
	sharedContent,
	channelOverrides,
	unlinkedFields,
	onContentChange,
	onUnlinkField,
	onRelinkField,
	sharedMedia,
	onAddMediaUrl,
	onRemoveMedia,
	onFileUpload,
	uploading,
	targetOptions,
	onSetOption,
	onGetOption,
	textareaRef,
}: ChannelEditorProps) {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const mediaUrlRef = useRef<HTMLInputElement>(null);

	const activeAccount = accounts.find((a) => a.id === activeTabId);
	const activePlatform = activeAccount?.platform || "";

	const isContentUnlinked = unlinkedFields[activeTabId]?.has("content");
	const isMediaUnlinked = unlinkedFields[activeTabId]?.has("media");

	const effectiveContent = isContentUnlinked
		? channelOverrides[activeTabId]?.content ?? sharedContent
		: sharedContent;

	const effectiveMedia = isMediaUnlinked
		? channelOverrides[activeTabId]?.media ?? sharedMedia
		: sharedMedia;

	// All active platforms (for char count badges)
	const activePlatforms = useMemo(
		() => new Set(accounts.map((a) => a.platform)),
		[accounts],
	);

	const igContentType = onGetOption("instagram", "content_type", "post");

	const handleInsertText = useCallback(
		(text: string) => {
			const ta = textareaRef.current;
			if (ta) {
				const start = ta.selectionStart;
				const end = ta.selectionEnd;
				const before = effectiveContent.slice(0, start);
				const after = effectiveContent.slice(end);
				const newContent = before + text + after;
				onContentChange(activeTabId, newContent);
				// Restore cursor position after React re-render
				requestAnimationFrame(() => {
					ta.focus();
					ta.setSelectionRange(start + text.length, start + text.length);
				});
			} else {
				onContentChange(activeTabId, effectiveContent + text);
			}
		},
		[textareaRef, effectiveContent, onContentChange, activeTabId],
	);

	const handleAddMediaUrl = () => {
		const url = mediaUrlRef.current?.value.trim();
		if (!url) return;
		onAddMediaUrl(activeTabId, url);
		if (mediaUrlRef.current) mediaUrlRef.current.value = "";
	};

	return (
		<div className="flex flex-col">
			<div className="px-5 space-y-4 pb-2">
				{/* ── Content type selector (platform-specific) ── */}
				{activeAccount && activePlatform === "instagram" && (
					<div className="flex items-center gap-2">
						<div
							className={cn(
								"flex size-5 items-center justify-center rounded text-[8px] font-bold text-white shrink-0",
								platformColors.instagram,
							)}
						>
							{platformAvatars.instagram}
						</div>
						<div className="flex gap-1">
							{IG_CONTENT_TYPES.map((ct) => (
								<button
									key={ct.key}
									type="button"
									onClick={() =>
										onSetOption("instagram", "content_type", ct.key)
									}
									className={cn(
										"inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors border",
										igContentType === ct.key
											? "border-primary bg-primary/10 text-primary"
											: "border-border text-muted-foreground hover:bg-accent/30",
									)}
								>
									<ct.icon className="size-3 shrink-0" />
									{ct.label}
								</button>
							))}
						</div>
					</div>
				)}

				{/* ── Combined content + media editor (Buffer-style) ── */}
				<ContentMediaEditor
					textareaRef={textareaRef}
					effectiveContent={effectiveContent}
					effectiveMedia={effectiveMedia}
					isContentUnlinked={!!isContentUnlinked}
					isMediaUnlinked={!!isMediaUnlinked}
					activePlatform={activePlatform}
					activePlatforms={activePlatforms}
					activeTabId={activeTabId}
					activeAccount={activeAccount}
					igContentType={igContentType}
					uploading={uploading}
					fileInputRef={fileInputRef}
					mediaUrlRef={mediaUrlRef}
					onContentChange={onContentChange}
					onUnlinkField={onUnlinkField}
					onRelinkField={onRelinkField}
					onRemoveMedia={onRemoveMedia}
					onFileUpload={onFileUpload}
					handleAddMediaUrl={handleAddMediaUrl}
					handleInsertText={handleInsertText}
				/>

				{/* ── Platform-specific options (only when a channel is selected) ── */}
				{activeAccount && (
					<PlatformOptions
						platform={activePlatform}
						onSetOption={onSetOption}
						onGetOption={onGetOption}
						igContentType={igContentType}
					/>
				)}
			</div>
		</div>
	);
}

// ── Combined content + media editor (Buffer-style) ──

function ContentMediaEditor({
	textareaRef,
	effectiveContent,
	effectiveMedia,
	isContentUnlinked,
	isMediaUnlinked,
	activePlatform,
	activePlatforms,
	activeTabId,
	activeAccount,
	igContentType,
	uploading,
	fileInputRef,
	mediaUrlRef,
	onContentChange,
	onUnlinkField,
	onRelinkField,
	onRemoveMedia,
	onFileUpload,
	handleAddMediaUrl,
	handleInsertText,
}: {
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	effectiveContent: string;
	effectiveMedia: Array<{ url: string; type?: string; previewUrl?: string }>;
	isContentUnlinked: boolean;
	isMediaUnlinked: boolean;
	activePlatform: string;
	activePlatforms: Set<string>;
	activeTabId: string;
	activeAccount: any;
	igContentType: string;
	uploading: boolean;
	fileInputRef: React.RefObject<HTMLInputElement | null>;
	mediaUrlRef: React.RefObject<HTMLInputElement | null>;
	onContentChange: (accountId: string, value: string) => void;
	onUnlinkField: (accountId: string, field: "content" | "media") => void;
	onRelinkField: (accountId: string, field: "content" | "media") => void;
	onRemoveMedia: (accountId: string, index: number) => void;
	onFileUpload: (file: File) => void;
	handleAddMediaUrl: () => void;
	handleInsertText: (text: string) => void;
}) {
	const [dragging, setDragging] = useState(false);
	const [showUrlInput, setShowUrlInput] = useState(false);

	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setDragging(true);
	};

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setDragging(false);
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setDragging(false);
		const file = e.dataTransfer.files?.[0];
		if (file) onFileUpload(file);
	};

	const hasCustomization = isContentUnlinked || isMediaUnlinked;

	return (
		<div
			className={cn(
				"rounded-lg border transition-colors overflow-hidden",
				dragging
					? "border-primary bg-primary/[0.02]"
					: hasCustomization
						? "border-primary/30 bg-primary/[0.02]"
						: "border-border",
			)}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{/* Linked/unlinked badges */}
			{activeAccount && (isContentUnlinked || isMediaUnlinked) && (
				<div className="flex items-center gap-2 px-3 pt-2">
					{isContentUnlinked && (
						<button
							type="button"
							onClick={() => onRelinkField(activeTabId, "content")}
							className="flex items-center gap-1 text-[10px] rounded-md px-1.5 py-0.5 text-primary bg-primary/10 hover:bg-primary/20 transition-colors"
						>
							<Link2Off className="size-3" />
							Content: Custom
						</button>
					)}
					{isMediaUnlinked && (
						<button
							type="button"
							onClick={() => onRelinkField(activeTabId, "media")}
							className="flex items-center gap-1 text-[10px] rounded-md px-1.5 py-0.5 text-primary bg-primary/10 hover:bg-primary/20 transition-colors"
						>
							<Link2Off className="size-3" />
							Media: Custom
						</button>
					)}
				</div>
			)}

			{/* Textarea */}
			<div className="px-3 pt-3">
				<textarea
					ref={textareaRef}
					value={effectiveContent}
					onChange={(e) => onContentChange(activeTabId, e.target.value)}
					placeholder="What would you like to share?"
					rows={6}
					className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
				/>
			</div>

			{/* Media previews (inside the content area like Buffer) */}
			{effectiveMedia.length > 0 && (
				<div className="px-3 pb-2">
					<div
						className="grid gap-2"
						style={{
							gridTemplateColumns:
								effectiveMedia.length === 1 ? "max-content" : "repeat(auto-fill, minmax(120px, 1fr))",
						}}
					>
						{effectiveMedia.map((item, i) => (
							<MediaThumbnail
								key={`${item.url}-${i}`}
								item={item}
								onRemove={() => onRemoveMedia(activeTabId, i)}
							/>
						))}
					</div>
				</div>
			)}

			{/* Drop zone (shown when no media and not dragging) */}
			{effectiveMedia.length === 0 && !dragging && (
				<div className="px-3 pb-2">
					<button
						type="button"
						onClick={() => fileInputRef.current?.click()}
						className="w-32 h-28 rounded-lg border-2 border-dashed border-border hover:border-primary/40 flex flex-col items-center justify-center gap-1.5 transition-colors cursor-pointer"
					>
						<Upload className="size-5 text-muted-foreground" />
						<span className="text-[11px] text-muted-foreground leading-tight text-center">
							Drag & drop or{" "}
							<span className="text-primary font-medium">select a file</span>
						</span>
					</button>
				</div>
			)}

			{/* Drag overlay */}
			{dragging && (
				<div className="px-3 pb-2">
					<div className="w-full h-28 rounded-lg border-2 border-dashed border-primary bg-primary/5 flex items-center justify-center">
						<span className="text-sm text-primary font-medium">Drop file here</span>
					</div>
				</div>
			)}

			{/* Bottom toolbar */}
			<div className="flex items-center gap-1 px-3 py-2 border-t border-border">
				{/* Add media dropdown */}
				<button
					type="button"
					onClick={() => fileInputRef.current?.click()}
					disabled={uploading}
					className="rounded-md p-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors disabled:opacity-50"
					title="Upload file"
				>
					{uploading ? (
						<Loader2 className="size-4 animate-spin" />
					) : (
						<Upload className="size-4" />
					)}
				</button>
				<button
					type="button"
					onClick={() => setShowUrlInput(!showUrlInput)}
					className={cn(
						"rounded-md p-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-colors",
						showUrlInput && "bg-accent/50 text-foreground",
					)}
					title="Add media URL"
				>
					<Link2 className="size-4" />
				</button>
				{/* Emoji / hashtag toolbar */}
				<EditorToolbar
					content={effectiveContent}
					activePlatforms={activePlatforms}
					activePlatform={activePlatform}
					onInsertText={handleInsertText}
				/>
				{/* Customize buttons */}
				{activeAccount && !isContentUnlinked && (
					<button
						type="button"
						onClick={() => onUnlinkField(activeTabId, "content")}
						className="ml-auto flex items-center gap-1 text-[10px] rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-accent/50 transition-colors"
						title="Customize content for this channel"
					>
						<Link2 className="size-3" />
					</button>
				)}
			</div>

			{/* URL input (collapsible) */}
			{showUrlInput && (
				<div className="flex gap-2 px-3 pb-2 border-t border-border pt-2">
					<div className="relative flex-1 min-w-0">
						<Link2 className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
						<input
							ref={mediaUrlRef}
							type="url"
							placeholder="https://example.com/image.jpg"
							className="w-full rounded-md border border-border bg-background pl-8 pr-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring font-mono"
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									handleAddMediaUrl();
								}
							}}
						/>
					</div>
					<button
						type="button"
						onClick={handleAddMediaUrl}
						className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent/30 hover:text-foreground transition-colors"
					>
						<Plus className="size-3.5" />
					</button>
				</div>
			)}

			{/* Hidden file input */}
			<input
				ref={fileInputRef}
				type="file"
				className="hidden"
				accept={
					activePlatform === "instagram" && igContentType === "post"
						? "image/*,.gif"
						: "image/*,video/*,.gif,.pdf"
				}
				onChange={(e) => {
					const file = e.target.files?.[0];
					if (file) onFileUpload(file);
					e.target.value = "";
				}}
			/>
		</div>
	);
}

// ── Platform Options (rendered inline, not in accordions) ──

function PlatformOptions({
	platform,
	onSetOption,
	onGetOption,
	igContentType,
}: {
	platform: string;
	onSetOption: (platform: string, key: string, value: unknown) => void;
	onGetOption: (platform: string, key: string, fallback?: any) => any;
	igContentType: string;
}) {
	const renderSection = () => {
		switch (platform) {
			case "instagram":
				return (
					<>
						<div className="space-y-1">
							<FieldLabel>First comment</FieldLabel>
							<FieldTextarea
								value={onGetOption("instagram", "first_comment")}
								onChange={(v) =>
									onSetOption("instagram", "first_comment", v)
								}
								placeholder="Auto-post a comment after publishing"
							/>
						</div>
						{igContentType === "reels" && (
							<>
								<FieldCheckbox
									checked={onGetOption("instagram", "share_to_feed", false)}
									onChange={(v) =>
										onSetOption("instagram", "share_to_feed", v)
									}
									label="Share to feed"
								/>
								<div className="space-y-1">
									<FieldLabel>Thumbnail offset (ms)</FieldLabel>
									<FieldInput
										type="number"
										value={onGetOption("instagram", "thumb_offset", "")}
										onChange={(v) =>
											onSetOption(
												"instagram",
												"thumb_offset",
												v ? Number(v) : "",
											)
										}
										placeholder="0"
									/>
								</div>
							</>
						)}
						<div className="space-y-1">
							<FieldLabel>Collaborators</FieldLabel>
							<TagInput
								value={onGetOption("instagram", "collaborators", [])}
								onChange={(v) =>
									onSetOption("instagram", "collaborators", v)
								}
								placeholder="Enter usernames"
							/>
						</div>
					</>
				);

			case "reddit":
				return (
					<>
						<div className="space-y-1">
							<FieldLabel required>Subreddit</FieldLabel>
							<div className="relative">
								<span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
									r/
								</span>
								<FieldInput
									value={onGetOption("reddit", "subreddit")}
									onChange={(v) => onSetOption("reddit", "subreddit", v)}
									placeholder="programming"
									className="pl-7"
								/>
							</div>
						</div>
						<div className="space-y-1">
							<FieldLabel>Title</FieldLabel>
							<FieldInput
								value={onGetOption("reddit", "title")}
								onChange={(v) => onSetOption("reddit", "title", v)}
								placeholder="Post title (max 300 chars)"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel>Link URL</FieldLabel>
							<FieldInput
								type="url"
								value={onGetOption("reddit", "url")}
								onChange={(v) => onSetOption("reddit", "url", v)}
								placeholder="https://example.com"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel>Flair ID</FieldLabel>
							<FieldInput
								value={onGetOption("reddit", "flair_id")}
								onChange={(v) => onSetOption("reddit", "flair_id", v)}
								placeholder="Flair ID"
							/>
						</div>
						<div className="flex gap-4">
							<FieldCheckbox
								checked={onGetOption("reddit", "nsfw", false)}
								onChange={(v) => onSetOption("reddit", "nsfw", v)}
								label="NSFW"
							/>
							<FieldCheckbox
								checked={onGetOption("reddit", "spoiler", false)}
								onChange={(v) => onSetOption("reddit", "spoiler", v)}
								label="Spoiler"
							/>
						</div>
					</>
				);

			case "linkedin":
				return (
					<>
						<div className="space-y-1">
							<FieldLabel>Organization URN</FieldLabel>
							<FieldInput
								value={onGetOption("linkedin", "organization_urn")}
								onChange={(v) =>
									onSetOption("linkedin", "organization_urn", v)
								}
								placeholder="urn:li:organization:12345"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel>Document title</FieldLabel>
							<FieldInput
								value={onGetOption("linkedin", "document_title")}
								onChange={(v) =>
									onSetOption("linkedin", "document_title", v)
								}
								placeholder="Title for document media"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel>First comment</FieldLabel>
							<FieldTextarea
								value={onGetOption("linkedin", "first_comment")}
								onChange={(v) =>
									onSetOption("linkedin", "first_comment", v)
								}
								placeholder="Auto-post a comment after publishing"
							/>
						</div>
						<FieldCheckbox
							checked={onGetOption("linkedin", "disable_link_preview", false)}
							onChange={(v) =>
								onSetOption("linkedin", "disable_link_preview", v)
							}
							label="Disable link preview"
						/>
					</>
				);

			case "twitter":
				return (
					<div className="space-y-1">
						<FieldLabel>Reply to tweet ID</FieldLabel>
						<FieldInput
							value={onGetOption("twitter", "reply_to")}
							onChange={(v) => onSetOption("twitter", "reply_to", v)}
							placeholder="1234567890"
						/>
					</div>
				);

			case "youtube":
				return (
					<>
						<div className="space-y-1">
							<FieldLabel>Video title</FieldLabel>
							<FieldInput
								value={onGetOption("youtube", "title")}
								onChange={(v) => onSetOption("youtube", "title", v)}
								placeholder="Video title (max 100 chars)"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel>Visibility</FieldLabel>
							<Select
								value={onGetOption("youtube", "visibility", "public")}
								onValueChange={(v) =>
									onSetOption("youtube", "visibility", v)
								}
							>
								<SelectTrigger size="sm" className="w-full text-xs h-7">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="public">Public</SelectItem>
									<SelectItem value="private">Private</SelectItem>
									<SelectItem value="unlisted">Unlisted</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1">
							<FieldLabel>Category ID</FieldLabel>
							<FieldInput
								value={onGetOption("youtube", "category_id")}
								onChange={(v) => onSetOption("youtube", "category_id", v)}
								placeholder="22 (default)"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel>Tags</FieldLabel>
							<TagInput
								value={onGetOption("youtube", "tags", [])}
								onChange={(v) => onSetOption("youtube", "tags", v)}
								placeholder="Add tags"
							/>
						</div>
						<FieldCheckbox
							checked={onGetOption("youtube", "made_for_kids", false)}
							onChange={(v) => onSetOption("youtube", "made_for_kids", v)}
							label="Made for kids"
						/>
						<FieldCheckbox
							checked={onGetOption(
								"youtube",
								"contains_synthetic_media",
								false,
							)}
							onChange={(v) =>
								onSetOption("youtube", "contains_synthetic_media", v)
							}
							label="Contains synthetic media"
						/>
						<div className="space-y-1">
							<FieldLabel>First comment</FieldLabel>
							<FieldTextarea
								value={onGetOption("youtube", "first_comment")}
								onChange={(v) =>
									onSetOption("youtube", "first_comment", v)
								}
								placeholder="Auto-post a comment after publishing"
							/>
						</div>
					</>
				);

			case "pinterest":
				return (
					<>
						<div className="space-y-1">
							<FieldLabel required>Board ID</FieldLabel>
							<FieldInput
								value={onGetOption("pinterest", "board_id")}
								onChange={(v) => onSetOption("pinterest", "board_id", v)}
								placeholder="Board ID"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel>Pin title</FieldLabel>
							<FieldInput
								value={onGetOption("pinterest", "title")}
								onChange={(v) => onSetOption("pinterest", "title", v)}
								placeholder="Pin title (max 100 chars)"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel>Destination link</FieldLabel>
							<FieldInput
								type="url"
								value={onGetOption("pinterest", "link")}
								onChange={(v) => onSetOption("pinterest", "link", v)}
								placeholder="https://example.com"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel>Cover image URL</FieldLabel>
							<FieldInput
								type="url"
								value={onGetOption("pinterest", "cover_image_url")}
								onChange={(v) =>
									onSetOption("pinterest", "cover_image_url", v)
								}
								placeholder="https://example.com/cover.jpg"
							/>
						</div>
					</>
				);

			case "sms":
				return (
					<>
						<div className="space-y-1">
							<FieldLabel required>From number</FieldLabel>
							<FieldInput
								value={onGetOption("sms", "from_number")}
								onChange={(v) => onSetOption("sms", "from_number", v)}
								placeholder="+15017122661"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel required>Phone numbers</FieldLabel>
							<TagInput
								value={onGetOption("sms", "phone_numbers", [])}
								onChange={(v) => onSetOption("sms", "phone_numbers", v)}
								placeholder="Enter phone numbers"
							/>
						</div>
					</>
				);

			case "discord":
				return (
					<>
						<div className="space-y-1">
							<FieldLabel>Username override</FieldLabel>
							<FieldInput
								value={onGetOption("discord", "username")}
								onChange={(v) => onSetOption("discord", "username", v)}
								placeholder="Bot username"
							/>
						</div>
						<div className="space-y-1">
							<FieldLabel>Avatar URL override</FieldLabel>
							<FieldInput
								type="url"
								value={onGetOption("discord", "avatar_url")}
								onChange={(v) => onSetOption("discord", "avatar_url", v)}
								placeholder="https://example.com/avatar.png"
							/>
						</div>
					</>
				);

			case "telegram":
				return (
					<>
						<div className="space-y-1">
							<FieldLabel>Parse mode</FieldLabel>
							<Select
								value={onGetOption("telegram", "parse_mode", "")}
								onValueChange={(v) =>
									onSetOption("telegram", "parse_mode", v)
								}
							>
								<SelectTrigger size="sm" className="w-full text-xs h-7">
									<SelectValue placeholder="Default" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="HTML">HTML</SelectItem>
									<SelectItem value="Markdown">Markdown</SelectItem>
									<SelectItem value="MarkdownV2">MarkdownV2</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<FieldCheckbox
							checked={onGetOption("telegram", "silent", false)}
							onChange={(v) => onSetOption("telegram", "silent", v)}
							label="Silent (no notification)"
						/>
						<FieldCheckbox
							checked={onGetOption("telegram", "protect_content", false)}
							onChange={(v) =>
								onSetOption("telegram", "protect_content", v)
							}
							label="Protect content (no forwarding)"
						/>
						<FieldCheckbox
							checked={onGetOption("telegram", "disable_preview", false)}
							onChange={(v) =>
								onSetOption("telegram", "disable_preview", v)
							}
							label="Disable link preview"
						/>
					</>
				);

			default:
				return null;
		}
	};

	const content = renderSection();
	if (!content) return null;

	return (
		<div className="rounded-lg border border-border p-3 space-y-2.5">
			<div className="flex items-center gap-2">
				<div
					className={cn(
						"flex size-5 items-center justify-center rounded text-[8px] font-bold text-white shrink-0",
						platformColors[platform] || "bg-neutral-700",
					)}
				>
					{platformAvatars[platform] || platform.slice(0, 2).toUpperCase()}
				</div>
				<span className="text-xs font-medium">
					{platformLabels[platform] || platform} Options
				</span>
			</div>
			{content}
		</div>
	);
}
