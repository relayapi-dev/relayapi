import { FileIcon, X } from "lucide-react";

interface Props {
  url: string;
  type: string;
  filename: string;
  progress?: number;
  onRemove: () => void;
}

export function ComposerAttachmentChip({ url, type, filename, progress, onRemove }: Props) {
  const isImage = type.startsWith("image/");
  const isVideo = type.startsWith("video/");
  const isAudio = type.startsWith("audio/");
  const uploading = typeof progress === "number" && progress < 100;

  return (
    <div className="group relative inline-flex h-14 items-center gap-2 rounded-md border border-[#e5e7eb] bg-[#f8fafc] px-2">
      {isImage ? (
        <img src={url} alt={filename} className="h-10 w-10 rounded object-cover" />
      ) : isVideo ? (
        <video src={url} className="h-10 w-10 rounded object-cover" muted />
      ) : isAudio ? (
        <audio src={url} controls className="h-10 w-44" />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded bg-white">
          <FileIcon className="size-4 text-slate-500" />
        </div>
      )}
      <span className="max-w-[10rem] truncate text-xs text-slate-600">{filename}</span>
      {uploading && (
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-white/70 text-[11px] font-medium text-slate-600">
          {progress}%
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 rounded-full p-0.5 text-slate-400 hover:bg-white hover:text-slate-700"
        title="Remove"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
