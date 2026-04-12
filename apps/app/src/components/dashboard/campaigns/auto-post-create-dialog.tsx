import { useState, useEffect } from "react";
import { Loader2, Rss, ChevronDown, ChevronUp } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

interface AutoPostCreateDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

interface TestFeedItem {
  title: string;
  url: string;
  description: string;
  published_at: string | null;
  image_url: string | null;
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

export function AutoPostCreateDialog({ open, onOpenChange, onCreated }: AutoPostCreateDialogProps) {
  const [name, setName] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [pollingInterval, setPollingInterval] = useState(60);
  const [contentTemplate, setContentTemplate] = useState("");
  const [appendFeedUrl, setAppendFeedUrl] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Test feed state
  const [testItems, setTestItems] = useState<TestFeedItem[] | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testExpanded, setTestExpanded] = useState(false);

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setFeedUrl("");
      setPollingInterval(60);
      setContentTemplate("");
      setAppendFeedUrl(true);
      setError(null);
      setTestItems(null);
      setTestError(null);
      setTestExpanded(false);
    }
  }, [open]);

  async function handleTestFeed() {
    if (!feedUrl) return;
    setTestLoading(true);
    setTestError(null);
    setTestItems(null);
    try {
      const res = await fetch("/api/auto-post-rules/test-feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feed_url: feedUrl }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setTestError(data?.error?.message || "Failed to parse feed");
      } else {
        setTestItems(data?.items || []);
        setTestExpanded(true);
      }
    } catch {
      setTestError("Network error");
    } finally {
      setTestLoading(false);
    }
  }

  async function handleCreate() {
    if (!name.trim() || !feedUrl.trim()) {
      setError("Name and Feed URL are required");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/auto-post-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          feed_url: feedUrl.trim(),
          polling_interval_minutes: pollingInterval,
          content_template: contentTemplate || undefined,
          append_feed_url: appendFeedUrl,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || "Failed to create rule");
      }
      onOpenChange(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create rule");
    } finally {
      setSaving(false);
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
            Create Auto-Post Rule
          </DialogTitle>
          <DialogDescription>
            Automatically create posts from an RSS or Atom feed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1 px-1">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Company Blog RSS"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Feed URL */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Feed URL</label>
            <div className="flex gap-2">
              <input
                type="url"
                value={feedUrl}
                onChange={(e) => setFeedUrl(e.target.value)}
                placeholder="https://example.com/feed.xml"
                className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs whitespace-nowrap"
                disabled={!feedUrl || testLoading}
                onClick={handleTestFeed}
              >
                {testLoading ? <Loader2 className="size-3 animate-spin" /> : "Test Feed"}
              </Button>
            </div>
            {testError && (
              <p className="text-xs text-destructive mt-1">{testError}</p>
            )}
          </div>

          {/* Test Feed Results */}
          {testItems && testItems.length > 0 && (
            <div className="rounded-md border border-border">
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent/30 transition-colors"
                onClick={() => setTestExpanded(!testExpanded)}
              >
                <span>{testItems.length} feed items found</span>
                {testExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              </button>
              {testExpanded && (
                <div className="border-t border-border divide-y divide-border">
                  {testItems.map((item, i) => (
                    <div key={i} className="px-3 py-2 space-y-0.5">
                      <p className="text-xs font-medium truncate">{item.title}</p>
                      {item.published_at && (
                        <p className="text-[11px] text-muted-foreground">
                          {new Date(item.published_at).toLocaleDateString("en-US", {
                            month: "short", day: "numeric", year: "numeric",
                          })}
                        </p>
                      )}
                      <p className="text-[11px] text-muted-foreground line-clamp-2">{item.description}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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
              id="append-url"
              checked={appendFeedUrl}
              onCheckedChange={(v) => setAppendFeedUrl(!!v)}
            />
            <label htmlFor="append-url" className="text-xs text-muted-foreground cursor-pointer">
              Append article URL to post content
            </label>
          </div>
        </div>

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || !feedUrl.trim() || saving}
            onClick={handleCreate}
          >
            {saving && <Loader2 className="size-3 animate-spin mr-1" />}
            Create Rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
