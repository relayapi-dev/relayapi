import { useState, useEffect, useCallback } from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface BroadcastFull {
  id: string;
  name: string | null;
  account_id: string;
  message_text: string | null;
  status: "draft" | "scheduled" | "sending" | "sent" | "partially_failed" | "failed" | "cancelled";
  sent_count: number;
  failed_count: number;
  created_at: string;
}

interface BroadcastDetail {
  id: string;
  name: string | null;
  description: string | null;
  platform: string;
  account_id: string;
  status: string;
  message_text: string | null;
  template_name: string | null;
  template_language: string | null;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  scheduled_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface BroadcastsEditDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  broadcast: BroadcastFull | null;
  onUpdated: () => void;
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; classes: string }> = {
    draft: { label: "Draft", classes: "text-neutral-400 bg-neutral-400/10" },
    scheduled: { label: "Scheduled", classes: "text-blue-400 bg-blue-400/10" },
    sending: { label: "Sending", classes: "text-amber-400 bg-amber-400/10" },
    sent: { label: "Sent", classes: "text-emerald-400 bg-emerald-400/10" },
    partially_failed: { label: "Partial", classes: "text-amber-400 bg-amber-400/10" },
    failed: { label: "Failed", classes: "text-red-400 bg-red-400/10" },
    cancelled: { label: "Cancelled", classes: "text-neutral-400 bg-neutral-400/10" },
  };
  const cfg = map[status] ?? map.draft!;
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cfg!.classes)}>
      {cfg!.label}
    </span>
  );
}

export function BroadcastsEditDialog({
  open,
  onOpenChange,
  broadcast,
  onUpdated,
}: BroadcastsEditDialogProps) {
  const [name, setName] = useState("");
  const [messageText, setMessageText] = useState("");
  const [description, setDescription] = useState("");
  const [detail, setDetail] = useState<BroadcastDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Fetch full broadcast detail when opened
  useEffect(() => {
    if (!broadcast || !open) return;
    setName(broadcast.name ?? "");
    setMessageText(broadcast.message_text ?? "");
    setError(null);
    setConfirmDelete(false);
    setLoadingDetail(true);

    fetch(`/api/broadcasts/${broadcast.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Error ${res.status}`);
        return res.json();
      })
      .then((data: BroadcastDetail) => {
        setDetail(data);
        setName(data.name ?? "");
        setMessageText(data.message_text ?? "");
        setDescription(data.description ?? "");
      })
      .catch(() => {
        setDetail(null);
      })
      .finally(() => setLoadingDetail(false));
  }, [broadcast, open]);

  useEffect(() => {
    if (!open) setConfirmDelete(false);
  }, [open]);

  const isDraft = broadcast?.status === "draft";
  const canDelete = broadcast?.status === "draft" || broadcast?.status === "cancelled";

  const handleSave = useCallback(async () => {
    if (!broadcast || !isDraft) return;
    setError(null);

    if (!messageText.trim()) {
      setError("Message is required.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/broadcasts/${broadcast.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || null,
          description: description.trim() || null,
          message_text: messageText.trim(),
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
  }, [broadcast, isDraft, name, description, messageText, onUpdated, onOpenChange]);

  const handleDelete = useCallback(async () => {
    if (!broadcast) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/broadcasts/${broadcast.id}`, {
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
  }, [broadcast, onUpdated, onOpenChange]);

  if (!broadcast) return null;

  const busy = saving || deleting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">
            {isDraft ? "Edit Broadcast" : "Broadcast Details"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isDraft
              ? "Update broadcast settings before sending."
              : "View broadcast details."}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-3 py-2 pl-0.5 pr-6">
            {loadingDetail ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* Status */}
                <div className="flex items-center gap-2">
                  <label className="text-xs font-medium text-muted-foreground">Status</label>
                  {statusBadge(broadcast.status)}
                </div>

                {/* Name */}
                <div>
                  <label htmlFor="bc-edit-name" className="text-xs font-medium text-muted-foreground">
                    Name
                  </label>
                  {isDraft ? (
                    <input
                      id="bc-edit-name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Welcome campaign"
                      className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                    />
                  ) : (
                    <div className="mt-1 rounded-md border border-border bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
                      {name || <span className="text-muted-foreground/50">—</span>}
                    </div>
                  )}
                </div>

                {/* Account (read-only) */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Account</label>
                  <div className="mt-1 rounded-md border border-border bg-accent/20 px-3 py-2 text-sm text-muted-foreground font-mono text-xs">
                    {broadcast.account_id}
                  </div>
                </div>

                {/* Message */}
                <div>
                  <label htmlFor="bc-edit-message" className="text-xs font-medium text-muted-foreground">
                    Message
                  </label>
                  {isDraft ? (
                    <textarea
                      id="bc-edit-message"
                      value={messageText}
                      onChange={(e) => setMessageText(e.target.value)}
                      rows={4}
                      className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                    />
                  ) : (
                    <div className="mt-1 rounded-md border border-border bg-accent/20 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap">
                      {messageText || <span className="text-muted-foreground/50">—</span>}
                    </div>
                  )}
                </div>

                {/* Description (only for drafts) */}
                {isDraft && (
                  <div>
                    <label htmlFor="bc-edit-desc" className="text-xs font-medium text-muted-foreground">
                      Description
                    </label>
                    <input
                      id="bc-edit-desc"
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Optional internal note"
                      className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                    />
                  </div>
                )}

                {/* Stats */}
                <div className="rounded-md border border-border bg-accent/10 px-3 py-2 text-xs text-muted-foreground">
                  <span className="text-emerald-400">{broadcast.sent_count}</span> sent
                  {" · "}
                  <span className="text-red-400">{broadcast.failed_count}</span> failed
                  {detail?.recipient_count != null && (
                    <> · {detail.recipient_count} recipients</>
                  )}
                  {detail?.scheduled_at && (
                    <> · Scheduled: {new Date(detail.scheduled_at).toLocaleString()}</>
                  )}
                  {detail?.completed_at && (
                    <> · Completed: {new Date(detail.completed_at).toLocaleString()}</>
                  )}
                </div>

                {/* Error */}
                {error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-row justify-between sm:justify-between">
          <div>
            {canDelete && (
              confirmDelete ? (
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
              )
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              {isDraft ? "Cancel" : "Close"}
            </Button>
            {isDraft && (
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={busy || loadingDetail || !messageText.trim()}
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save Changes"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
