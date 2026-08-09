import { Loader2, Upload } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { usePaginatedApi } from "@/hooks/use-api";
import { uploadMedia } from "@/lib/upload-media";
import { INPUT_CLS } from "../field-styles";

export type MediaPickerKind = "image" | "video" | "audio" | "file";

export interface MediaLibraryItem {
	id: string;
	filename: string;
	mime_type: string;
	original_available: boolean;
	workspace_id: string | null;
	size: number;
	url: string | null;
	created_at: string;
}

const ALLOWED_MIME_TYPES: Record<MediaPickerKind, ReadonlySet<string>> = {
	image: new Set([
		"image/jpeg",
		"image/png",
		"image/gif",
		"image/webp",
		"image/heic",
		"image/heif",
		"image/avif",
	]),
	video: new Set(["video/mp4", "video/webm", "video/quicktime", "video/mpeg"]),
	audio: new Set([
		"audio/mpeg",
		"audio/mp4",
		"audio/webm",
		"audio/wav",
		"audio/ogg",
	]),
	file: new Set(["application/pdf"]),
};

const ACCEPT_BY_KIND: Record<MediaPickerKind, string> = {
	image:
		".jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.avif,image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,image/avif",
	video:
		".mp4,.webm,.mov,.mpeg,video/mp4,video/webm,video/quicktime,video/mpeg",
	audio:
		".mp3,.m4a,.webm,.wav,.ogg,audio/mpeg,audio/mp4,audio/webm,audio/wav,audio/ogg",
	file: ".pdf,application/pdf",
};

export function mediaAcceptForKind(kind: MediaPickerKind): string {
	return ACCEPT_BY_KIND[kind];
}

export function mediaMatchesKind(
	kind: MediaPickerKind,
	mimeType: string,
	filename = "",
): boolean {
	const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (ALLOWED_MIME_TYPES[kind].has(normalized)) return true;
	return (
		kind === "file" && !normalized && filename.toLowerCase().endsWith(".pdf")
	);
}

export function compatibleMediaItems(
	items: MediaLibraryItem[],
	kind: MediaPickerKind,
	workspaceId: string | null,
): Array<MediaLibraryItem & { url: string }> {
	return items.filter(
		(item): item is MediaLibraryItem & { url: string } =>
			(workspaceId
				? item.workspace_id === workspaceId || item.workspace_id === null
				: item.workspace_id === null) &&
			item.original_available &&
			typeof item.url === "string" &&
			item.url.length > 0 &&
			mediaMatchesKind(kind, item.mime_type, item.filename),
	);
}

export function formatMediaSize(bytes: number): string {
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
	return `${bytes} B`;
}

interface MediaLibraryContextValue {
	items: MediaLibraryItem[];
	loading: boolean;
	loadingMore: boolean;
	error: string | null;
	hasMore: boolean;
	loadMore(): Promise<MediaLibraryItem[]>;
	addUploaded(item: MediaLibraryItem): void;
}

const MediaLibraryContext = createContext<MediaLibraryContextValue | null>(
	null,
);

export function MediaLibraryProvider({
	children,
	enabled,
	workspaceId,
}: {
	children: ReactNode;
	enabled: boolean;
	workspaceId: string | null;
}) {
	const library = usePaginatedApi<MediaLibraryItem>(enabled ? "media" : null, {
		limit: 100,
		query: { workspace_id: workspaceId ?? undefined },
	});
	const value = useMemo<MediaLibraryContextValue>(
		() => ({
			items: library.data,
			loading: library.loading,
			loadingMore: library.loadingMore,
			error: library.error,
			hasMore: library.hasMore,
			loadMore: library.loadMore,
			addUploaded(item) {
				library.setData((current) => [
					item,
					...current.filter(
						(existing) => existing.id !== item.id && existing.url !== item.url,
					),
				]);
			},
		}),
		[
			library.data,
			library.error,
			library.hasMore,
			library.loadMore,
			library.loading,
			library.loadingMore,
			library.setData,
		],
	);

	return (
		<MediaLibraryContext.Provider value={value}>
			{children}
		</MediaLibraryContext.Provider>
	);
}

function useMediaLibrary(): MediaLibraryContextValue {
	const value = useContext(MediaLibraryContext);
	if (!value) {
		throw new Error(
			"MediaReferenceField must be rendered inside MediaLibraryProvider",
		);
	}
	return value;
}

export function MediaReferenceField({
	id,
	kind,
	label,
	optional = false,
	value,
	workspaceId,
	onChange,
}: {
	id: string;
	kind: MediaPickerKind;
	label: string;
	optional?: boolean;
	value: string;
	workspaceId: string | null;
	onChange(next: string): void;
}) {
	const library = useMediaLibrary();
	const inputRef = useRef<HTMLInputElement>(null);
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const items = useMemo(
		() => compatibleMediaItems(library.items, kind, workspaceId),
		[library.items, kind, workspaceId],
	);
	const isDurableReference = /^med_[A-Za-z0-9_-]+$/.test(value);
	const currentIsMissing =
		isDurableReference && !items.some((item) => item.id === value);
	const libraryValue = isDurableReference ? value : "";
	const externalValue = value.startsWith("med_") ? "" : value;

	const handleFile = async (file: File | undefined) => {
		if (!file) return;
		setUploadError(null);
		if (!mediaMatchesKind(kind, file.type, file.name)) {
			setUploadError(`Choose a supported ${kind} file.`);
			return;
		}
		setUploading(true);
		try {
			const uploaded = await uploadMedia(file, { workspaceId });
			// Without a durable id (an API build that predates it), fall back to
			// the URL: the server resolves a relay media URL back to the same row
			// by storage key and applies the same authorization checks.
			onChange(uploaded.id ?? uploaded.url);
			if (uploaded.id) {
				library.addUploaded({
					id: uploaded.id,
					filename: uploaded.filename,
					mime_type: uploaded.type,
					original_available: true,
					workspace_id: workspaceId,
					size: uploaded.size,
					url: uploaded.url,
					created_at: new Date().toISOString(),
				});
			}
		} catch (error) {
			setUploadError(error instanceof Error ? error.message : "Upload failed.");
		} finally {
			setUploading(false);
			if (inputRef.current) inputRef.current.value = "";
		}
	};

	return (
		<div className="space-y-2">
			<div>
				<label
					htmlFor={`${id}-library`}
					className="mb-1 block text-[11px] font-medium text-[#475569]"
				>
					{label}
					{optional ? " (optional)" : ""}
				</label>
				<div className="flex gap-2">
					<select
						id={`${id}-library`}
						value={libraryValue}
						onChange={(event) => {
							if (event.target.value) onChange(event.target.value);
						}}
						disabled={library.loading || uploading}
						className={INPUT_CLS}
					>
						<option value="">
							{library.loading
								? "Loading media…"
								: `Choose ${kind} from library…`}
						</option>
						{currentIsMissing ? (
							<option value={value}>Current selection · {value}</option>
						) : null}
						{items.map((item) => (
							<option key={item.id} value={item.id}>
								{item.filename} · {formatMediaSize(item.size)}
							</option>
						))}
					</select>
					<input
						ref={inputRef}
						type="file"
						accept={mediaAcceptForKind(kind)}
						className="hidden"
						onChange={(event) => void handleFile(event.target.files?.[0])}
						aria-label={`Upload ${kind}`}
					/>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={uploading}
						onClick={() => inputRef.current?.click()}
						className="h-10 shrink-0 gap-1 px-3 text-[11px]"
					>
						{uploading ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Upload className="size-3.5" />
						)}
						{uploading ? "Uploading" : "Upload"}
					</Button>
				</div>
				{library.hasMore ? (
					<button
						type="button"
						onClick={() => void library.loadMore()}
						disabled={library.loadingMore}
						className="mt-1 text-[10px] font-medium text-[#5a6373] hover:text-[#1f2937] disabled:opacity-50"
					>
						{library.loadingMore ? "Loading more…" : "Load more media"}
					</button>
				) : null}
				{library.error ? (
					<p className="mt-1 text-[10px] text-amber-700">
						Media library unavailable: {library.error} You can still upload or
						paste a URL.
					</p>
				) : null}
			</div>

			<div>
				<label
					htmlFor={`${id}-url`}
					className="mb-1 block text-[11px] font-medium text-[#475569]"
				>
					Or use an external URL (advanced)
				</label>
				<input
					id={`${id}-url`}
					type="url"
					value={externalValue}
					onChange={(event) => onChange(event.target.value)}
					className={INPUT_CLS}
					placeholder="https://…"
				/>
			</div>

			{uploadError ? (
				<p className="text-[11px] text-destructive" role="alert">
					{uploadError}
				</p>
			) : null}
		</div>
	);
}
