import { useState, useEffect, useCallback } from "react";
import { Loader2, ChevronDown, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

interface CommentAutomationFull {
  id: string;
  name: string;
  platform: "instagram" | "facebook";
  account_id: string;
  post_id: string | null;
  enabled: boolean;
  keywords: string[];
  match_mode: "contains" | "exact";
  dm_message: string;
  public_reply: string | null;
  once_per_user: boolean;
  stats: { total_triggered: number; last_triggered_at: string | null };
  created_at: string;
}

interface CommentAutomationEditDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  automation: CommentAutomationFull | null;
  onUpdated: () => void;
}

export function CommentAutomationEditDialog({
  open,
  onOpenChange,
  automation,
  onUpdated,
}: CommentAutomationEditDialogProps) {
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [matchMode, setMatchMode] = useState<"contains" | "exact">("contains");
  const [dmMessage, setDmMessage] = useState("");
  const [showPublicReply, setShowPublicReply] = useState(false);
  const [publicReply, setPublicReply] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [oncePerUser, setOncePerUser] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Populate form when automation changes
  useEffect(() => {
    if (automation) {
      setName(automation.name);
      setKeywords(automation.keywords.join(", "));
      setMatchMode(automation.match_mode);
      setDmMessage(automation.dm_message);
      setPublicReply(automation.public_reply ?? "");
      setShowPublicReply(!!automation.public_reply);
      setEnabled(automation.enabled);
      setOncePerUser(automation.once_per_user ?? true);
      setError(null);
      setConfirmDelete(false);
    }
  }, [automation]);

  // Reset confirm delete when dialog closes
  useEffect(() => {
    if (!open) setConfirmDelete(false);
  }, [open]);

  const handleSave = useCallback(async () => {
    if (!automation) return;
    setError(null);

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!dmMessage.trim()) {
      setError("DM message is required.");
      return;
    }

    const keywordList = keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    setSaving(true);
    try {
      const res = await fetch(`/api/comment-automations/${automation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          keywords: keywordList,
          match_mode: matchMode,
          dm_message: dmMessage.trim(),
          public_reply: showPublicReply && publicReply.trim() ? publicReply.trim() : null,
          once_per_user: oncePerUser,
          enabled,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Error ${res.status}`);
        return;
      }

      onUpdated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }, [automation, name, keywords, matchMode, dmMessage, showPublicReply, publicReply, oncePerUser, enabled, onUpdated, onOpenChange]);

  const handleDelete = useCallback(async () => {
    if (!automation) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/comment-automations/${automation.id}`, {
        method: "DELETE",
      });
      if (res.ok || res.status === 204) {
        onUpdated();
        onOpenChange(false);
      } else {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Delete failed: ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setDeleting(false);
    }
  }, [automation, onUpdated, onOpenChange]);

  if (!automation) return null;

  const busy = saving || deleting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Edit Automation</DialogTitle>
          <DialogDescription className="text-xs">
            Update settings for this comment-to-DM automation.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-3 py-2 pl-0.5 pr-6">
            {/* Name */}
            <div>
              <label htmlFor="ca-edit-name" className="text-xs font-medium text-muted-foreground">
                Name <span className="text-destructive">*</span>
              </label>
              <input
                id="ca-edit-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>

            {/* Info row: Platform + Post (read-only) */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs font-medium text-muted-foreground">Platform</label>
                <div className="mt-1 rounded-md border border-border bg-accent/20 px-3 py-2 text-sm text-muted-foreground capitalize">
                  {automation.platform}
                </div>
              </div>
              <div className="flex-1">
                <label className="text-xs font-medium text-muted-foreground">Scope</label>
                <div className="mt-1 rounded-md border border-border bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
                  {automation.post_id ? (
                    <span className="font-mono text-[11px]" title={automation.post_id}>
                      {automation.post_id.length > 20 ? `${automation.post_id.slice(0, 20)}...` : automation.post_id}
                    </span>
                  ) : (
                    "All posts"
                  )}
                </div>
              </div>
            </div>

            {/* Enabled toggle */}
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <label htmlFor="ca-edit-enabled" className="text-xs font-medium text-muted-foreground">
                Enabled
              </label>
              <button
                id="ca-edit-enabled"
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled(!enabled)}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                  enabled ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600"
                )}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                    enabled ? "translate-x-4" : "translate-x-0"
                  )}
                />
              </button>
            </div>

            {/* Once per user toggle */}
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <label htmlFor="ca-edit-once-per-user" className="text-xs font-medium text-muted-foreground">
                  Once per user
                </label>
                <p className="text-[10px] text-muted-foreground/70">Each user triggers the automation only once</p>
              </div>
              <button
                id="ca-edit-once-per-user"
                type="button"
                role="switch"
                aria-checked={oncePerUser}
                onClick={() => setOncePerUser(!oncePerUser)}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                  oncePerUser ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600"
                )}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                    oncePerUser ? "translate-x-4" : "translate-x-0"
                  )}
                />
              </button>
            </div>

            {/* Keywords */}
            <div>
              <label htmlFor="ca-edit-keywords" className="text-xs font-medium text-muted-foreground">
                Keywords
              </label>
              <input
                id="ca-edit-keywords"
                type="text"
                placeholder="e.g. free, guide, link (comma-separated)"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>

            {/* Match Mode */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Match Mode</label>
              <div className="mt-1 flex rounded-md border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setMatchMode("contains")}
                  className={cn(
                    "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
                    matchMode === "contains"
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Contains
                </button>
                <button
                  type="button"
                  onClick={() => setMatchMode("exact")}
                  className={cn(
                    "flex-1 px-3 py-1.5 text-xs font-medium transition-colors border-l border-border",
                    matchMode === "exact"
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Exact
                </button>
              </div>
            </div>

            {/* DM Message */}
            <div>
              <label htmlFor="ca-edit-dm" className="text-xs font-medium text-muted-foreground">
                DM Message <span className="text-destructive">*</span>
              </label>
              <textarea
                id="ca-edit-dm"
                value={dmMessage}
                onChange={(e) => setDmMessage(e.target.value)}
                rows={3}
                className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>

            {/* Public Reply */}
            <div>
              <button
                type="button"
                onClick={() => setShowPublicReply(!showPublicReply)}
                className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    showPublicReply && "rotate-180"
                  )}
                />
                Public reply
              </button>
              {showPublicReply && (
                <textarea
                  placeholder="Optional public reply to the comment..."
                  value={publicReply}
                  onChange={(e) => setPublicReply(e.target.value)}
                  rows={2}
                  className="mt-2 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                />
              )}
            </div>

            {/* Stats */}
            <div className="rounded-md border border-border bg-accent/10 px-3 py-2 text-xs text-muted-foreground">
              Triggered {automation.stats.total_triggered} time{automation.stats.total_triggered !== 1 ? "s" : ""}
              {automation.stats.last_triggered_at && (
                <> &middot; Last: {new Date(automation.stats.last_triggered_at).toLocaleDateString()}</>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-row justify-between sm:justify-between">
          <div>
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sure?</span>
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  No
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleDelete} disabled={busy}>
                  {deleting ? <Loader2 className="size-3.5 animate-spin" /> : "Yes"}
                </Button>
              </div>
            ) : (
              <Button type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={() => setConfirmDelete(true)} disabled={busy} title="Delete">
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={busy || !name.trim() || !dmMessage.trim()}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save Changes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
