import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
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
import { useMutation } from "@/hooks/use-api";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import { WorkspaceSearchCombobox } from "@/components/dashboard/workspace-search-combobox";

interface EngagementRuleCreateDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
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

export function EngagementRuleCreateDialog({ open, onOpenChange, onCreated }: EngagementRuleCreateDialogProps) {
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [triggerMetric, setTriggerMetric] = useState<TriggerMetric>("likes");
  const [triggerThreshold, setTriggerThreshold] = useState("");
  const [actionType, setActionType] = useState<ActionType>("repost");
  const [actionContent, setActionContent] = useState("");
  const [actionAccountId, setActionAccountId] = useState<string | null>(null);
  const [checkIntervalMinutes, setCheckIntervalMinutes] = useState(360);
  const [maxChecks, setMaxChecks] = useState("3");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation<{ id: string }>("engagement-rules", "POST");

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setName("");
      setWorkspaceId(null);
      setAccountId(null);
      setTriggerMetric("likes");
      setTriggerThreshold("");
      setActionType("repost");
      setActionContent("");
      setActionAccountId(null);
      setCheckIntervalMinutes(360);
      setMaxChecks("3");
      setError(null);
    }
  }, [open]);

  const handleWorkspaceChange = (id: string | null) => {
    setWorkspaceId(id);
    setAccountId(null);
  };

  const handleCreate = async () => {
    setError(null);

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!accountId) {
      setError("Please select an account.");
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

    const result = await createMutation.mutate({
      name: name.trim(),
      account_id: accountId,
      trigger_metric: triggerMetric,
      trigger_threshold: threshold,
      action_type: actionType,
      ...(actionType === "reply" ? { action_content: actionContent.trim() } : {}),
      ...(actionType === "repost_from_account" ? { action_account_id: actionAccountId } : {}),
      check_interval_minutes: checkIntervalMinutes,
      max_checks: checks,
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    });

    if (result) {
      onCreated();
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Create Engagement Rule</DialogTitle>
          <DialogDescription className="text-xs">
            Automatically take action when a post reaches an engagement threshold.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
        <div className="space-y-3 py-2 pl-0.5 pr-6">
          {/* Name */}
          <div>
            <label htmlFor="er-name" className="text-xs font-medium text-muted-foreground">
              Name <span className="text-destructive">*</span>
            </label>
            <input
              id="er-name"
              type="text"
              placeholder="e.g. Auto-retweet viral posts"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Workspace (optional filter) */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Workspace
            </label>
            <WorkspaceSearchCombobox
              value={workspaceId}
              onSelect={handleWorkspaceChange}
              showAllOption
              placeholder="All workspaces"
              variant="input"
              className="mt-1"
            />
          </div>

          {/* Account */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Account <span className="text-destructive">*</span>
            </label>
            <AccountSearchCombobox
              value={accountId}
              onSelect={setAccountId}
              workspaceId={workspaceId}
              showAllOption={false}
              placeholder="Search accounts..."
              variant="input"
              className="mt-1"
            />
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
            <label htmlFor="er-threshold" className="text-xs font-medium text-muted-foreground">
              Trigger Threshold <span className="text-destructive">*</span>
            </label>
            <input
              id="er-threshold"
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
              <label htmlFor="er-action-content" className="text-xs font-medium text-muted-foreground">
                Reply Content <span className="text-destructive">*</span>
              </label>
              <textarea
                id="er-action-content"
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
                workspaceId={workspaceId}
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
            <label htmlFor="er-max-checks" className="text-xs font-medium text-muted-foreground">
              Max Checks
            </label>
            <input
              id="er-max-checks"
              type="number"
              min={1}
              max={10}
              value={maxChecks}
              onChange={(e) => setMaxChecks(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              How many times to check (1-10). Default: 3.
            </p>
          </div>

          {/* Error */}
          {(error || createMutation.error) && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error || createMutation.error}
            </div>
          )}
        </div>
        </ScrollArea>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={createMutation.loading}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleCreate} disabled={createMutation.loading || !name.trim() || !accountId || !triggerThreshold}>
            {createMutation.loading ? <Loader2 className="size-3.5 animate-spin" /> : "Create Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
