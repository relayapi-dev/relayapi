import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { platformLabels } from "@/lib/platform-maps";

export interface PostErrorEntry {
  platform: string;
  message: string;
  detail?: string;
}

/**
 * Build the per-account error rows for a post from its mapped targets.
 * Surfaces any target that carries an error (failed or partial posts).
 */
export function collectPostErrors(
  targets: Record<string, { platform: string; error?: { message: string; detail?: string } }>,
): PostErrorEntry[] {
  return Object.values(targets)
    .filter((t): t is typeof t & { error: { message: string; detail?: string } } => Boolean(t.error))
    .map((t) => ({ platform: t.platform, message: t.error.message, detail: t.error.detail }));
}

function ErrorRow({ entry }: { entry: PostErrorEntry }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!entry.detail) return;
    try {
      await navigator.clipboard.writeText(entry.detail);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2">
      <span className="font-medium text-red-400 capitalize">
        {platformLabels[entry.platform] || entry.platform}
      </span>
      <p className="text-muted-foreground mt-0.5 whitespace-pre-wrap break-words">{entry.message}</p>
      {entry.detail && (
        <div className="mt-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Raw response
            </span>
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="max-h-48 overflow-auto rounded bg-muted/50 p-2 text-[11px] font-mono whitespace-pre-wrap break-all select-text text-foreground/80">
            {entry.detail}
          </pre>
        </div>
      )}
    </div>
  );
}

/**
 * Content-only list of post publish errors (no surrounding dialog).
 * Reused inline (popover) and inside a Dialog (modal, posts list).
 */
export function PostErrorDetails({ errors }: { errors: PostErrorEntry[] }) {
  if (errors.length === 0) {
    return <p className="text-xs text-muted-foreground">No error details available.</p>;
  }
  return (
    <div className="space-y-2 text-xs">
      {errors.map((entry, i) => (
        <ErrorRow key={`${entry.platform}-${i}`} entry={entry} />
      ))}
    </div>
  );
}

/**
 * Dialog wrapper around PostErrorDetails for contexts that aren't already a floating
 * surface (the post-detail modal and the posts list).
 */
export function PostErrorDialog({
  open,
  onOpenChange,
  errors,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  errors: PostErrorEntry[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">Error details</DialogTitle>
        </DialogHeader>
        <PostErrorDetails errors={errors} />
      </DialogContent>
    </Dialog>
  );
}
