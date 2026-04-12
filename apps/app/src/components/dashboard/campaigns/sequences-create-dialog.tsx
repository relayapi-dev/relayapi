import { useState, useEffect } from "react";
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
import { useMutation } from "@/hooks/use-api";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AccountSearchCombobox, type AccountOption } from "@/components/dashboard/account-search-combobox";

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

interface SequencesCreateDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

export function SequencesCreateDialog({ open, onOpenChange, onCreated }: SequencesCreateDialogProps) {
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [steps, setSteps] = useState<StepInput[]>([createEmptyStep()]);
  const [exitOnReply, setExitOnReply] = useState(true);
  const [exitOnUnsubscribe, setExitOnUnsubscribe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<AccountOption | null>(null);

  const createMutation = useMutation<{ id: string }>("sequences", "POST");

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setName("");
      setAccountId("");
      setSelectedAccount(null);
      setSteps([createEmptyStep()]);
      setExitOnReply(true);
      setExitOnUnsubscribe(true);
      setError(null);
    }
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

    const result = await createMutation.mutate({
      name: name.trim(),
      account_id: accountId,
      platform: selectedAccount?.platform || "whatsapp",
      steps: formattedSteps,
      exit_on_reply: exitOnReply,
      exit_on_unsubscribe: exitOnUnsubscribe,
    });

    if (result) {
      onCreated();
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Create Sequence</DialogTitle>
          <DialogDescription className="text-xs">
            Build an automated multi-step message sequence.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
        <div className="space-y-3 py-2 pl-0.5 pr-6">
          {/* Name */}
          <div>
            <label htmlFor="seq-name" className="text-xs font-medium text-muted-foreground">
              Name <span className="text-destructive">*</span>
            </label>
            <input
              id="seq-name"
              type="text"
              placeholder="e.g. Onboarding sequence"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Account */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Account <span className="text-destructive">*</span>
            </label>
            <div className="mt-1">
              <AccountSearchCombobox
                value={accountId || null}
                onSelect={(id) => setAccountId(id || "")}
                onSelectAccount={(acc) => setSelectedAccount(acc)}
                showAllOption={false}
                placeholder="Select an account"
                variant="input"
              />
            </div>
          </div>

          {/* Steps */}
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
          <Button type="button" size="sm" onClick={handleCreate} disabled={createMutation.loading}>
            {createMutation.loading ? <Loader2 className="size-3.5 animate-spin" /> : "Create Sequence"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
