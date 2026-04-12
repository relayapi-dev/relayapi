import { useState, useRef, useCallback, useEffect } from "react";
import { Upload, X, Loader2, Check, RotateCcw, Plus, ImageIcon, Film } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

type FileUploadStatus = "pending" | "uploading" | "success" | "error";

interface FileUploadItem {
  id: string;
  file: File;
  status: FileUploadStatus;
  progress: number;
  error?: string;
  preview?: string;
}

interface UploadMediaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUploaded: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

const MAX_CONCURRENT = 3;

export function UploadMediaDialog({ open, onOpenChange, onUploaded }: UploadMediaDialogProps) {
  const [files, setFiles] = useState<FileUploadItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const hasFiles = files.length > 0;
  const allDone = hasFiles && files.every((f) => f.status === "success" || f.status === "error");
  const successCount = files.filter((f) => f.status === "success").length;
  const errorCount = files.filter((f) => f.status === "error").length;
  const pendingCount = files.filter((f) => f.status === "pending").length;

  // Cleanup previews on unmount or close
  useEffect(() => {
    if (!open) {
      files.forEach((f) => {
        if (f.preview) URL.revokeObjectURL(f.preview);
      });
      setFiles([]);
      setIsUploading(false);
      setIsDragging(false);
      dragCounter.current = 0;
    }
  }, [open]);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const items: FileUploadItem[] = Array.from(newFiles).map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: "pending" as const,
      progress: 0,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    setFiles((prev) => [...prev, ...items]);
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (file?.preview) URL.revokeObjectURL(file.preview);
      return prev.filter((f) => f.id !== id);
    });
  }, []);

  const updateFile = useCallback((id: string, updates: Partial<FileUploadItem>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
  }, []);

  const uploadFile = useCallback(async (item: FileUploadItem) => {
    updateFile(item.id, { status: "uploading", progress: 0, error: undefined });

    // Simulated progress
    let progress = 0;
    const interval = setInterval(() => {
      progress += (85 - progress) * 0.12;
      updateFile(item.id, { progress: Math.round(progress) });
    }, 150);

    try {
      const res = await fetch(
        `/api/media/upload?filename=${encodeURIComponent(item.file.name)}`,
        { method: "POST", body: item.file },
      );

      clearInterval(interval);

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        updateFile(item.id, {
          status: "error",
          progress: 0,
          error: err?.error?.message || `Upload failed (${res.status})`,
        });
      } else {
        updateFile(item.id, { status: "success", progress: 100 });
      }
    } catch {
      clearInterval(interval);
      updateFile(item.id, { status: "error", progress: 0, error: "Network error" });
    }
  }, [updateFile]);

  const startUpload = useCallback(async () => {
    setIsUploading(true);
    const pending = files.filter((f) => f.status === "pending" || f.status === "error");
    const queue = [...pending];
    const active: Promise<void>[] = [];

    const next = async (): Promise<void> => {
      const item = queue.shift();
      if (!item) return;
      await uploadFile(item);
      await next();
    };

    for (let i = 0; i < Math.min(MAX_CONCURRENT, queue.length); i++) {
      active.push(next());
    }

    await Promise.all(active);
    setIsUploading(false);
  }, [files, uploadFile]);

  const handleDone = useCallback(() => {
    if (successCount > 0) onUploaded();
    onOpenChange(false);
  }, [successCount, onUploaded, onOpenChange]);

  // Drag events
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    setIsDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = "";
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isUploading) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Upload Media</DialogTitle>
          <DialogDescription>
            Upload images and videos to your media library
          </DialogDescription>
        </DialogHeader>

        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onFileInputChange}
          accept="image/*,video/*,.gif"
        />

        {/* Drop zone or file list */}
        {!hasFiles ? (
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={onDragOver}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-10 cursor-pointer transition-colors ${
              isDragging
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-foreground/40 hover:bg-accent/20"
            }`}
          >
            <Upload className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              Drag & drop files here, or click to browse
            </p>
            <p className="text-xs text-muted-foreground/60">
              Images, videos, and GIFs
            </p>
          </div>
        ) : (
          <div
            className="space-y-2"
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDragOver={onDragOver}
            onDrop={onDrop}
          >
            {!isUploading && !allDone && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 h-7 text-xs w-full"
                onClick={() => inputRef.current?.click()}
              >
                <Plus className="size-3" />
                Add more files
              </Button>
            )}

            <ScrollArea className="max-h-[280px]">
              <div className="space-y-1.5">
              {files.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 rounded-md border border-border p-2"
                >
                  {/* Thumbnail */}
                  <div className="size-10 rounded bg-accent/30 flex items-center justify-center shrink-0 overflow-hidden">
                    {item.preview ? (
                      <img src={item.preview} alt="" className="size-full object-cover" />
                    ) : item.file.type.startsWith("video/") ? (
                      <Film className="size-4 text-muted-foreground/60" />
                    ) : (
                      <ImageIcon className="size-4 text-muted-foreground/60" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <p className="text-xs font-medium truncate">{item.file.name}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] text-muted-foreground">
                        {formatFileSize(item.file.size)}
                      </p>
                      {item.status === "error" && item.error && (
                        <p className="text-[11px] text-destructive truncate">{item.error}</p>
                      )}
                    </div>

                    {/* Progress bar */}
                    {item.status === "uploading" && (
                      <div className="mt-1 h-1 w-full rounded-full bg-accent/30 overflow-hidden">
                        <div
                          className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                    )}
                  </div>

                  {/* Status / Actions */}
                  <div className="shrink-0">
                    {item.status === "pending" && (
                      <button
                        onClick={() => removeFile(item.id)}
                        className="rounded p-1 hover:bg-accent/30 transition-colors"
                        title="Remove"
                      >
                        <X className="size-3.5 text-muted-foreground" />
                      </button>
                    )}
                    {item.status === "uploading" && (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    )}
                    {item.status === "success" && (
                      <Check className="size-4 text-emerald-500" />
                    )}
                    {item.status === "error" && (
                      <button
                        onClick={() => {
                          updateFile(item.id, { status: "pending", progress: 0, error: undefined });
                        }}
                        className="rounded p-1 hover:bg-accent/30 transition-colors"
                        title="Retry"
                      >
                        <RotateCcw className="size-3.5 text-muted-foreground" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              </div>
            </ScrollArea>
          </div>
        )}

        <DialogFooter>
          {allDone ? (
            <>
              <p className="text-xs text-muted-foreground mr-auto self-center">
                {successCount} uploaded{errorCount > 0 ? `, ${errorCount} failed` : ""}
              </p>
              {errorCount > 0 && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={startUpload}>
                  Retry failed
                </Button>
              )}
              <Button size="sm" className="h-7 text-xs" onClick={handleDone}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onOpenChange(false)}
                disabled={isUploading}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="gap-1.5 h-7 text-xs"
                onClick={startUpload}
                disabled={!hasFiles || isUploading || pendingCount === 0}
              >
                {isUploading ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="size-3" />
                    Upload {pendingCount > 0 ? `(${pendingCount})` : ""}
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
