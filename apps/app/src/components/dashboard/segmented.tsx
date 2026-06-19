import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label?: string;
  icon?: ReactNode;
  title?: string;
}

/**
 * Pill segmented control. `bg-muted` container, active pill `bg-card shadow-xs`.
 * Reference: ui_kits/dashboard/Overview.jsx Segmented + Posts.jsx tab/view groups.
 *
 * - size="default": text pills (All / Queue / Drafts ...)
 * - size="icon": square icon buttons (Calendar / List view toggle)
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "default",
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  size?: "default" | "icon";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5",
        className
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center justify-center whitespace-nowrap rounded-[6px] text-[13px] font-medium transition-colors ease-[var(--ease-relay)] [&_svg]:size-[15px] [&_svg]:shrink-0",
              size === "icon" ? "h-[26px] w-7" : "gap-1.5 px-3.5 py-1",
              active
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
