import { useState, useEffect } from "react";
import { Loader2, Rss, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

interface AutoPostRuleResponse {
  id: string;
  name: string;
  feed_url: string;
  polling_interval_minutes: number;
  content_template: string | null;
  append_feed_url: boolean;
  account_ids: string[];
  status: "active" | "paused" | "error";
  consecutive_errors: number;
  last_processed_url: string | null;
  last_processed_at: string | null;
  last_error: string | null;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AutoPostEditDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rule: AutoPostRuleResponse | null;
  onUpdated: () => void;
}

const INTERVAL_OPTIONS = [
  { value: 15, label: "Every 15 min" },
  { value: 30, label: "Every 30 min" },
  { value: 60, label: "Every 1 hour" },
  { value: 120, label: "Every 2 hours" },
  { value: 360, label: "Every 6 hours" },
  { value: 720, label: "Every 12 hours" },
  { value: 1440, label: "Every 24 hours" },
];

const TEMPLATE_VARS = ["{{title}}", "{{url}}", "{{description}}", "{{published_date}}"];

export function AutoPostEditDialog({ open, onOpenChange, rule, onUpdated }: AutoPostEditDialogProps) {
  const [name, setName] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [pollingInterval, setPollingInterval] = useState(60);
  const [contentTemplate, setContentTemplate] = useState("");
  const [appendFeedUrl, setAppendFeedUrl] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (rule) {
      setName(rule.name);
      setFeedUrl(rule.feed_url);
      setPollingInterval(rule.polling_interval_minutes);
      setContentTemplate(rule.content_template || "");
      setAppendFeedUrl(rule.append_feed_url);
      setConfirmDelete(false);
      setError(null);
    }
  }, [rule]);

  if (!rule) return null;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/auto-post-rules/${rule!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          feed_url: feedUrl.trim(),
          polling_interval_minutes: pollingInterval,
          content_template: contentTemplate || null,
          append_feed_url: appendFeedUrl,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || "Failed to update");
      }
      onOpenChange(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle() {
    setToggling(true);
    const action = rule!.status === "active" ? "pause" : "activate";
    try {
      const res = await fetch(`/api/auto-post-rules/${rule!.id}/${action}`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || `Failed to ${action}`);
      }
      onOpenChange(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setToggling(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/auto-post-rules/${rule!.id}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error("Failed to delete");
      }
      onOpenChange(false);
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  function insertVariable(v: string) {
    setContentTemplate((prev) => prev + v);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rss className="size-4" />
            Edit Auto-Post Rule
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1 pr-1">
          {/* Status info */}
          {rule.last_error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Last error: {rule.last_error}
            </div>
          )}

          {rule.last_processed_at && (
            <p className="text-[11px] text-muted-foreground">
              Last checked: {new Date(rule.last_processed_at).toLocaleString()}
            </p>
          )}

          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Feed URL */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Feed URL</label>
            <input
              type="url"
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Content Template */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Content Template <span className="text-muted-foreground/60">(optional)</span>
            </label>
            <textarea
              value={contentTemplate}
              onChange={(e) => setContentTemplate(e.target.value)}
              placeholder="{{title}}"
              rows={3}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
            <div className="flex flex-wrap gap-1 mt-1">
              {TEMPLATE_VARS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => insertVariable(v)}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-accent/40 text-muted-foreground hover:bg-accent/60 transition-colors font-mono"
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          {/* Polling Interval */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Polling Interval</label>
            <select
              value={pollingInterval}
              onChange={(e) => setPollingInterval(Number(e.target.value))}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Append Feed URL */}
          <div className="flex items-center gap-2">
            <Checkbox
              id="edit-append-url"
              checked={appendFeedUrl}
              onCheckedChange={(v) => setAppendFeedUrl(!!v)}
            />
            <label htmlFor="edit-append-url" className="text-xs text-muted-foreground cursor-pointer">
              Append article URL to post content
            </label>
          </div>
        </div>

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        <DialogFooter className="flex-row justify-between sm:justify-between">
          <div className="flex items-center gap-2">
            {confirmDelete ? (
              <>
                <span className="text-xs text-destructive">Sure?</span>
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setConfirmDelete(false)}>No</Button>
                <Button variant="destructive" size="sm" className="h-7 text-xs" disabled={deleting} onClick={handleDelete}>
                  {deleting ? <Loader2 className="size-3 animate-spin" /> : "Yes"}
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={handleDelete}>
                <Trash2 className="size-3 mr-1" />
                Delete
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={toggling}
              onClick={handleToggle}
            >
              {toggling && <Loader2 className="size-3 animate-spin mr-1" />}
              {rule.status === "active" ? "Pause" : "Activate"}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={!name.trim() || !feedUrl.trim() || saving}
              onClick={handleSave}
            >
              {saving && <Loader2 className="size-3 animate-spin mr-1" />}
              Save Changes
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
