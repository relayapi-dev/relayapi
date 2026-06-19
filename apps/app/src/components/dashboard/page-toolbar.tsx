import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One-row controls bar under the page header: left = segmented tabs, right =
 * icon toolbar (sync + workspace/account filters + view toggles).
 * Reference: ui_kits/dashboard/Posts.jsx controls row.
 */
export function PageToolbar({
  left,
  right,
  className,
}: {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <div className="flex min-w-0 items-center gap-2">{left}</div>
      {right && <div className="flex items-center gap-1">{right}</div>}
    </div>
  );
}

/** Thin vertical hairline used between toolbar groups. */
export function ToolbarDivider({ className }: { className?: string }) {
  return <span className={cn("mx-1.5 h-[18px] w-px bg-border", className)} />;
}
