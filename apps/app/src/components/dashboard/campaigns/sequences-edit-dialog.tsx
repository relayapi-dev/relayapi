import { useState, useEffect, useCallback } from "react";
import { Loader2, Trash2, Plus } from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";

interface SequenceFull {
  id: string;
  name: string;
  account_id: string;
  status: "draft" | "active" | "paused";
  steps_count: number;
  total_enrolled: number;
  total_completed: number;
  total_exited: number;
  created_at: string;
}

interface StepFromApi {
  id: string;
  order: number;
  message_text: string;
  delay_minutes: number;
}

interface StepInput {
  message: string;
  delay_minutes: number;
  custom_delay: string;
  use_custom: boolean;
}

const DELAY_OPTIONS = [
  { label: "1 hour", value: 60 },
  { label: "6 hours", value: 360 },
  { label: "1 day", value: 1440 },
  { label: "3 days", value: 4320 },
  { label: "7 days", value: 10080 },
  { label: "Custom", value: -1 },
] as const;

function createEmptyStep(): StepInput {
  return { message: "", delay_minutes: 1440, custom_delay: "", use_custom: false };
}

function stepFromApi(s: StepFromApi): StepInput {
  const preset = DELAY_OPTIONS.find((o) => o.value === s.delay_minutes);
  if (preset) {
    return { message: s.message_text, delay_minutes: s.delay_minutes, custom_delay: "", use_custom: false };
  }
  return { message: s.message_text, delay_minutes: -1, custom_delay: String(s.delay_minutes), use_custom: true };
}

interface SequencesEditDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sequence: SequenceFull | null;
  onUpdated: () => void;
}

export function SequencesEditDialog({
  open,
  onOpenChange,
  sequence,
  onUpdated,
}: SequencesEditDialogProps) {
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<StepInput[]>([createEmptyStep()]);
  const [exitOnReply, setExitOnReply] = useState(true);
  const [exitOnUnsubscribe, setExitOnUnsubscribe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Fetch full sequence detail (with steps) when opened
  useEffect(() => {
    if (!sequence || !open) return;
    setName(sequence.name);
    setError(null);
    setConfirmDelete(false);
    setLoadingDetail(true);

    fetch(`/api/sequences/${sequence.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Error ${res.status}`);
        return res.json();
      })
      .then((data: { steps?: StepFromApi[]; exit_on_reply?: boolean; exit_on_unsubscribe?: boolean }) => {
        if (data.steps && data.steps.length > 0) {
          setSteps(data.steps.sort((a: StepFromApi, b: StepFromApi) => a.order - b.order).map(stepFromApi));
        } else {
          setSteps([createEmptyStep()]);
        }
        setExitOnReply(data.exit_on_reply ?? true);
        setExitOnUnsubscribe(data.exit_on_unsubscribe ?? true);
      })
      .catch(() => {
        setSteps([createEmptyStep()]);
      })
      .finally(() => setLoadingDetail(false));
  }, [sequence, open]);

  useEffect(() => {
    if (!open) setConfirmDelete(false);
  }, [open]);

  const updateStep = (index: number, updates: Partial<StepInput>) => {
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, ...updates } : s))
    );
  };

  const addStep = () => {
    setSteps((prev) => [...prev, createEmptyStep()]);
  };

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = useCallback(async () => {
    if (!sequence) return;
    setError(null);

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    const hasEmptyMessage = steps.some((s) => !s.message.trim());
    if (hasEmptyMessage) {
      setError("All steps must have a message.");
      return;
    }

    const formattedSteps = steps.map((s, i) => ({
      order: i + 1,
      message_text: s.message.trim(),
      delay_minutes: s.use_custom ? (Number.parseInt(s.custom_delay, 10) || 60) : s.delay_minutes,
    }));

    setSaving(true);
    try {
      const res = await fetch(`/api/sequences/${sequence.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          steps: formattedSteps,
          exit_on_reply: exitOnReply,
          exit_on_unsubscribe: exitOnUnsubscribe,
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
  }, [sequence, name, steps, exitOnReply, exitOnUnsubscribe, onUpdated, onOpenChange]);

  const handleDelete = useCallback(async () => {
    if (!sequence) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/sequences/${sequence.id}`, {
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
  }, [sequence, onUpdated, onOpenChange]);

  if (!sequence) return null;

  const busy = saving || deleting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Edit Sequence</DialogTitle>
          <DialogDescription className="text-xs">
            Update the sequence name, steps, and exit conditions.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-3 py-2 pl-0.5 pr-6">
            {/* Name */}
            <div>
              <label htmlFor="seq-edit-name" className="text-xs font-medium text-muted-foreground">
                Name <span className="text-destructive">*</span>
              </label>
              <input
                id="seq-edit-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>

            {/* Account (read-only) */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">Account</label>
              <div className="mt-1 rounded-md border border-border bg-accent/20 px-3 py-2 text-sm text-muted-foreground font-mono text-xs">
                {sequence.account_id}
              </div>
            </div>

            {/* Steps */}
            {loadingDetail ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Steps</label>
                {steps.map((step, index) => (
                  <div
                    key={index}
                    className="rounded-md border border-border p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                        Step {index + 1}
                      </span>
                      {steps.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeStep(index)}
                          className="rounded p-1 hover:bg-accent/50 transition-colors"
                          title="Remove step"
                        >
                          <Trash2 className="size-3.5 text-muted-foreground" />
                        </button>
                      )}
                    </div>
                    <textarea
                      placeholder="Message for this step..."
                      value={step.message}
                      onChange={(e) => updateStep(index, { message: e.target.value })}
                      rows={2}
                      className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                    />
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-muted-foreground shrink-0">Delay:</label>
                      <select
                        value={step.use_custom ? -1 : step.delay_minutes}
                        onChange={(e) => {
                          const val = Number.parseInt(e.target.value, 10);
                          if (val === -1) {
                            updateStep(index, { use_custom: true });
                          } else {
                            updateStep(index, { delay_minutes: val, use_custom: false });
                          }
                        }}
                        className="rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                      >
                        {DELAY_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      {step.use_custom && (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            placeholder="60"
                            value={step.custom_delay}
                            onChange={(e) => updateStep(index, { custom_delay: e.target.value })}
                            className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                            min={1}
                          />
                          <span className="text-[11px] text-muted-foreground">minutes</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addStep}
                  className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors w-full justify-center"
                >
                  <Plus className="size-3" />
                  Add Step
                </button>
              </div>
            )}

            {/* Exit conditions */}
            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={exitOnReply} onCheckedChange={(c) => setExitOnReply(!!c)} />
                <span className="text-xs text-foreground">Stop sequence when contact replies</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={exitOnUnsubscribe} onCheckedChange={(c) => setExitOnUnsubscribe(!!c)} />
                <span className="text-xs text-foreground">Stop sequence when contact unsubscribes</span>
              </label>
            </div>

            {/* Stats */}
            <div className="rounded-md border border-border bg-accent/10 px-3 py-2 text-xs text-muted-foreground">
              {sequence.total_enrolled} enrolled &middot; {sequence.total_completed} completed &middot; {sequence.total_exited} exited
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
              disabled={busy || loadingDetail || !name.trim()}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save Changes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
