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
import { useMutation } from "@/hooks/use-api";
import { ScrollArea } from "@/components/ui/scroll-area";

const DAYS = [
  { label: "Sunday", value: 0 },
  { label: "Monday", value: 1 },
  { label: "Tuesday", value: 2 },
  { label: "Wednesday", value: 3 },
  { label: "Thursday", value: 4 },
  { label: "Friday", value: 5 },
  { label: "Saturday", value: 6 },
] as const;

interface SlotInput {
  day_of_week: number;
  time: string;
}

function createEmptySlot(): SlotInput {
  return { day_of_week: 1, time: "09:00" };
}

interface ScheduleCreateDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

export function ScheduleCreateDialog({ open, onOpenChange, onCreated }: ScheduleCreateDialogProps) {
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(() =>
    typeof window !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"
  );
  const [slots, setSlots] = useState<SlotInput[]>([createEmptySlot()]);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation<{ id: string }>("queue/slots", "POST");

  useEffect(() => {
    if (!open) {
      setName("");
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
      setSlots([createEmptySlot()]);
      setError(null);
    }
  }, [open]);

  const updateSlot = (index: number, updates: Partial<SlotInput>) => {
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...updates } : s)));
  };

  const addSlot = () => {
    setSlots((prev) => [...prev, createEmptySlot()]);
  };

  const removeSlot = (index: number) => {
    setSlots((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCreate = async () => {
    setError(null);

    if (slots.length === 0) {
      setError("Add at least one time slot.");
      return;
    }

    const hasEmptyTime = slots.some((s) => !s.time);
    if (hasEmptyTime) {
      setError("All slots must have a time set.");
      return;
    }

    const result = await createMutation.mutate({
      name: name.trim() || undefined,
      timezone,
      slots: slots.map((s) => ({
        day_of_week: s.day_of_week,
        time: s.time,
        timezone,
      })),
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
          <DialogTitle className="text-base">Create Queue Schedule</DialogTitle>
          <DialogDescription className="text-xs">
            Define recurring time slots for auto-scheduling posts.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-4 py-2 pl-0.5 pr-6">
            {/* Name */}
            <div>
              <label htmlFor="sched-name" className="text-xs font-medium text-muted-foreground">
                Name
              </label>
              <input
                id="sched-name"
                type="text"
                placeholder="e.g. Weekday mornings"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>

            {/* Timezone */}
            <div>
              <label htmlFor="sched-tz" className="text-xs font-medium text-muted-foreground">
                Timezone <span className="text-destructive">*</span>
              </label>
              <input
                id="sched-tz"
                type="text"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
            </div>

            {/* Slots */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Time Slots <span className="text-destructive">*</span>
                </label>
                <Button type="button" variant="ghost" size="sm" className="h-6 text-xs gap-1" onClick={addSlot}>
                  <Plus className="size-3" />
                  Add Slot
                </Button>
              </div>
              <div className="space-y-2">
                {slots.map((slot, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select
                      value={slot.day_of_week}
                      onChange={(e) => updateSlot(i, { day_of_week: Number(e.target.value) })}
                      className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                    >
                      {DAYS.map((d) => (
                        <option key={d.value} value={d.value}>{d.label}</option>
                      ))}
                    </select>
                    <input
                      type="time"
                      value={slot.time}
                      onChange={(e) => updateSlot(i, { time: e.target.value })}
                      className="w-28 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                    />
                    {slots.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeSlot(i)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {(error || createMutation.error) && (
              <p className="text-xs text-destructive">{error || createMutation.error}</p>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={createMutation.loading}>
            {createMutation.loading && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
            Create Schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
