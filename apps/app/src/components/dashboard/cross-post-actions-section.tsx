import { useCallback } from "react";
import {
  Clock,
  MessageSquare,
  Plus,
  Quote,
  Repeat2,
  Trash2,
  Zap,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import { cn } from "@/lib/utils";

// ── Types ──

export interface CrossPostAction {
  action_type: "repost" | "comment" | "quote";
  target_account_id: string;
  content?: string;
  delay_minutes: number;
}

interface CrossPostActionsSectionProps {
  actions: CrossPostAction[];
  onChange: (actions: CrossPostAction[]) => void;
}

// ── Action type config ──

const ACTION_TYPES = [
  { value: "repost" as const, label: "Repost", icon: Repeat2 },
  { value: "comment" as const, label: "Comment", icon: MessageSquare },
  { value: "quote" as const, label: "Quote", icon: Quote },
] as const;

// ── Delay options ──

const DELAY_OPTIONS = [
  { value: "0", label: "Immediately" },
  { value: "60", label: "1h" },
  { value: "120", label: "2h" },
  { value: "180", label: "3h" },
  { value: "360", label: "6h" },
  { value: "720", label: "12h" },
  { value: "1440", label: "24h" },
] as const;

// ── Trigger button (goes in the footer) ──

export function CrossPostActionsTrigger({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <Zap className="size-3.5" />
      <span>Actions</span>
      {count > 0 && (
        <span className="inline-flex items-center justify-center rounded-full bg-primary/10 text-primary min-w-[16px] h-4 px-1 text-[10px] font-semibold tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}

// ── Expanded panel (renders above the footer when open) ──

export function CrossPostActionsPanel({
  actions,
  onChange,
}: CrossPostActionsSectionProps) {
  const addAction = useCallback(() => {
    onChange([
      ...actions,
      {
        action_type: "repost",
        target_account_id: "",
        delay_minutes: 0,
      },
    ]);
  }, [actions, onChange]);

  const updateAction = useCallback(
    (index: number, patch: Partial<CrossPostAction>) => {
      const updated = actions.map((a, i) =>
        i === index ? { ...a, ...patch } : a,
      );
      onChange(updated);
    },
    [actions, onChange],
  );

  const removeAction = useCallback(
    (index: number) => {
      onChange(actions.filter((_, i) => i !== index));
    },
    [actions, onChange],
  );

  return (
    <div className="px-5 pb-2 space-y-1.5">
      {actions.map((action, index) => (
        <div key={index} className="space-y-1.5">
          {/* Row: type pills + account + delay + remove */}
          <div className="flex items-center gap-1.5">
            {/* Action type pills */}
            <div className="flex items-center gap-0.5 shrink-0">
              {ACTION_TYPES.map((type) => {
                const Icon = type.icon;
                const isActive = action.action_type === type.value;
                return (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() =>
                      updateAction(index, {
                        action_type: type.value,
                        ...(type.value === "repost"
                          ? { content: undefined }
                          : {}),
                      })
                    }
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors",
                      isActive
                        ? "font-medium text-foreground bg-accent"
                        : "text-muted-foreground/60 hover:text-muted-foreground",
                    )}
                  >
                    <Icon className="size-3" />
                    {type.label}
                  </button>
                );
              })}
            </div>

            {/* Account */}
            <div className="flex-1 min-w-0">
              <AccountSearchCombobox
                value={action.target_account_id || null}
                onSelect={(id) =>
                  updateAction(index, { target_account_id: id ?? "" })
                }
                showAllOption={false}
                placeholder="Select account"
                className="w-full"
              />
            </div>

            {/* Delay */}
            <div className="flex items-center gap-1 shrink-0">
              <Clock className="size-3 text-muted-foreground/50" />
              <Select
                value={String(action.delay_minutes)}
                onValueChange={(v) =>
                  updateAction(index, { delay_minutes: Number(v) })
                }
              >
                <SelectTrigger
                  size="sm"
                  className="w-auto h-7 text-[11px] gap-1 border-0 bg-transparent shadow-none hover:bg-accent px-1.5"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DELAY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Remove */}
            <button
              type="button"
              onClick={() => removeAction(index)}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground/40 hover:text-destructive transition-colors shrink-0"
              title="Remove"
            >
              <Trash2 className="size-3" />
            </button>
          </div>

          {/* Content textarea for comment and quote */}
          {(action.action_type === "comment" ||
            action.action_type === "quote") && (
            <textarea
              value={action.content ?? ""}
              onChange={(e) =>
                updateAction(index, { content: e.target.value })
              }
              placeholder={
                action.action_type === "comment"
                  ? "Comment text..."
                  : "Quote text..."
              }
              rows={2}
              className="w-full rounded-md bg-accent/30 px-3 py-2 text-xs outline-none resize-none border-0 focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
            />
          )}
        </div>
      ))}

      {/* Add another */}
      <button
        type="button"
        onClick={addAction}
        className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors py-1"
      >
        <Plus className="size-3" />
        Add action
      </button>
    </div>
  );
}

// ── Legacy wrapper (backwards compat) ──

export function CrossPostActionsSection({
  actions,
  onChange,
}: CrossPostActionsSectionProps) {
  return (
    <CrossPostActionsPanel actions={actions} onChange={onChange} />
  );
}
