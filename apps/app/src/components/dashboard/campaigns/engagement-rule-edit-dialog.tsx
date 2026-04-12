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
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";

interface EngagementRuleResponse {
  id: string;
  name: string;
  account_id: string;
  trigger_metric: "likes" | "comments" | "shares" | "views";
  trigger_threshold: number;
  action_type: "repost" | "reply" | "repost_from_account";
  action_account_id: string | null;
  action_content: string | null;
  check_interval_minutes: number;
  max_checks: number;
  status: "active" | "paused";
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EngagementRuleEditDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rule: EngagementRuleResponse | null;
  onUpdated: () => void;
}

const TRIGGER_METRICS = ["likes", "comments", "shares", "views"] as const;
type TriggerMetric = (typeof TRIGGER_METRICS)[number];

const ACTION_TYPES = [
  { value: "repost", label: "Retweet/Reshare" },
  { value: "reply", label: "Reply with text" },
  { value: "repost_from_account", label: "Repost from account" },
] as const;
type ActionType = (typeof ACTION_TYPES)[number]["value"];

const CHECK_INTERVALS = [
  { value: 60, label: "1h" },
  { value: 180, label: "3h" },
  { value: 360, label: "6h" },
  { value: 720, label: "12h" },
  { value: 1440, label: "24h" },
] as const;

export type { EngagementRuleResponse };

export function EngagementRuleEditDialog({
  open,
  onOpenChange,
  rule,
  onUpdated,
}: EngagementRuleEditDialogProps) {
  const [name, setName] = useState("");
  const [triggerMetric, setTriggerMetric] = useState<TriggerMetric>("likes");
  const [triggerThreshold, setTriggerThreshold] = useState("");
  const [actionType, setActionType] = useState<ActionType>("repost");
  const [actionContent, setActionContent] = useState("");
  const [actionAccountId, setActionAccountId] = useState<string | null>(null);
  const [checkIntervalMinutes, setCheckIntervalMinutes] = useState(360);
  const [maxChecks, setMaxChecks] = useState("3");
  const [status, setStatus] = useState<"active" | "paused">("active");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Populate form when rule changes
  useEffect(() => {
    if (rule) {
      setName(rule.name);
      setTriggerMetric(rule.trigger_metric);
      setTriggerThreshold(String(rule.trigger_threshold));
      setActionType(rule.action_type);
      setActionContent(rule.action_content ?? "");
      setActionAccountId(rule.action_account_id);
      setCheckIntervalMinutes(rule.check_interval_minutes);
      setMaxChecks(String(rule.max_checks));
      setStatus(rule.status);
      setError(null);
      setConfirmDelete(false);
    }
  }, [rule]);

  // Reset confirm delete when dialog closes
  useEffect(() => {
    if (!open) setConfirmDelete(false);
  }, [open]);

  const handleSave = useCallback(async () => {
    if (!rule) return;
    setError(null);

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    const threshold = Number(triggerThreshold);
    if (!triggerThreshold || threshold < 1 || !Number.isFinite(threshold)) {
      setError("Trigger threshold must be at least 1.");
      return;
    }

    if (actionType === "reply" && !actionContent.trim()) {
      setError("Reply content is required when action type is 'Reply with text'.");
      return;
    }

    if (actionType === "repost_from_account" && !actionAccountId) {
      setError("Please select an account to repost from.");
      return;
    }

    const checks = Number(maxChecks);
    if (!maxChecks || checks < 1 || checks > 10 || !Number.isInteger(checks)) {
      setError("Max checks must be between 1 and 10.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/engagement-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          trigger_metric: triggerMetric,
          trigger_threshold: threshold,
          action_type: actionType,
          action_content: actionType === "reply" ? actionContent.trim() : null,
          action_account_id: actionType === "repost_from_account" ? actionAccountId : null,
          check_interval_minutes: checkIntervalMinutes,
          max_checks: checks,
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
  }, [rule, name, triggerMetric, triggerThreshold, actionType, actionContent, actionAccountId, checkIntervalMinutes, maxChecks, onUpdated, onOpenChange]);

  const handleToggleStatus = useCallback(async () => {
    if (!rule) return;
    setToggling(true);
    setError(null);

    const endpoint = status === "active"
      ? `/api/engagement-rules/${rule.id}/pause`
      : `/api/engagement-rules/${rule.id}/activate`;

    try {
      const res = await fetch(endpoint, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Error ${res.status}`);
        return;
      }
      setStatus((prev) => (prev === "active" ? "paused" : "active"));
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setToggling(false);
    }
  }, [rule, status, onUpdated]);

  const handleDelete = useCallback(async () => {
    if (!rule) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/engagement-rules/${rule.id}`, {
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
  }, [rule, onUpdated, onOpenChange]);

  if (!rule) return null;

  const busy = saving || deleting || toggling;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Edit Engagement Rule</DialogTitle>
          <DialogDescription className="text-xs">
            Update settings for this engagement rule.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-3 py-2 pl-0.5 pr-6">
            {/* Name */}
            <div>
              <label htmlFor="er-edit-name" className="text-xs font-medium text-muted-foreground">
                Name <span className="text-destructive">*</span>
              </label>
              <input
                id="er-edit-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>

            {/* Account (read-only) */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Account</label>
              <div className="mt-1 rounded-md border border-border bg-accent/20 px-3 py-2 text-sm text-muted-foreground font-mono text-[11px]">
                {rule.account_id}
              </div>
            </div>

            {/* Status toggle */}
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div>
                <label htmlFor="er-edit-status" className="text-xs font-medium text-muted-foreground">
                  Status
                </label>
                <p className="text-[10px] text-muted-foreground/70">
                  {status === "active" ? "Rule is actively monitoring" : "Rule is paused"}
                </p>
              </div>
              <button
                id="er-edit-status"
                type="button"
                role="switch"
                aria-checked={status === "active"}
                onClick={handleToggleStatus}
                disabled={busy}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                  status === "active" ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600",
                  busy && "opacity-50 cursor-not-allowed"
                )}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                    status === "active" ? "translate-x-4" : "translate-x-0"
                  )}
                />
              </button>
            </div>

            {/* Trigger Metric */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Trigger Metric</label>
              <div className="mt-1 flex rounded-md border border-border overflow-hidden">
                {TRIGGER_METRICS.map((metric, i) => (
                  <button
                    key={metric}
                    type="button"
                    onClick={() => setTriggerMetric(metric)}
                    className={cn(
                      "flex-1 px-3 py-1.5 text-xs font-medium transition-colors capitalize",
                      i > 0 && "border-l border-border",
                      triggerMetric === metric
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {metric}
                  </button>
                ))}
              </div>
            </div>

            {/* Trigger Threshold */}
            <div>
              <label htmlFor="er-edit-threshold" className="text-xs font-medium text-muted-foreground">
                Trigger Threshold <span className="text-destructive">*</span>
              </label>
              <input
                id="er-edit-threshold"
                type="number"
                min={1}
                placeholder="e.g. 50"
                value={triggerThreshold}
                onChange={(e) => setTriggerThreshold(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>

            {/* Action Type */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Action Type</label>
              <div className="mt-1 flex rounded-md border border-border overflow-hidden">
                {ACTION_TYPES.map((action, i) => (
                  <button
                    key={action.value}
                    type="button"
                    onClick={() => setActionType(action.value)}
                    className={cn(
                      "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
                      i > 0 && "border-l border-border",
                      actionType === action.value
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Action Content (only for reply) */}
            {actionType === "reply" && (
              <div>
                <label htmlFor="er-edit-action-content" className="text-xs font-medium text-muted-foreground">
                  Reply Content <span className="text-destructive">*</span>
                </label>
                <textarea
                  id="er-edit-action-content"
                  placeholder="The text to reply with..."
                  value={actionContent}
                  onChange={(e) => setActionContent(e.target.value)}
                  rows={3}
                  className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                />
              </div>
            )}

            {/* Action Account (only for repost_from_account) */}
            {actionType === "repost_from_account" && (
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Repost From Account <span className="text-destructive">*</span>
                </label>
                <AccountSearchCombobox
                  value={actionAccountId}
                  onSelect={setActionAccountId}
                  workspaceId={rule.workspace_id}
                  showAllOption={false}
                  placeholder="Search accounts..."
                  variant="input"
                  className="mt-1"
                />
              </div>
            )}

            {/* Check Interval */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Check Interval</label>
              <div className="mt-1 flex rounded-md border border-border overflow-hidden">
                {CHECK_INTERVALS.map((interval, i) => (
                  <button
                    key={interval.value}
                    type="button"
                    onClick={() => setCheckIntervalMinutes(interval.value)}
                    className={cn(
                      "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
                      i > 0 && "border-l border-border",
                      checkIntervalMinutes === interval.value
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {interval.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Max Checks */}
            <div>
              <label htmlFor="er-edit-max-checks" className="text-xs font-medium text-muted-foreground">
                Max Checks
              </label>
              <input
                id="er-edit-max-checks"
                type="number"
                min={1}
                max={10}
                value={maxChecks}
                onChange={(e) => setMaxChecks(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                How many times to check (1-10).
              </p>
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
              disabled={busy || !name.trim() || !triggerThreshold}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save Changes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
