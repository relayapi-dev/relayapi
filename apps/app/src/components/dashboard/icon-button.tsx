import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Compact 32x32 ghost icon button used across the dashboard toolbars
 * (sync, filters, etc.). Reference: ui_kits/dashboard/Posts.jsx IconBtn.
 */
export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { active?: boolean }
>(({ className, active, type = "button", ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex size-8 items-center justify-center rounded-md transition-colors ease-[var(--ease-relay)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
      active
        ? "bg-accent text-foreground"
        : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
      className
    )}
    {...props}
  />
));
IconButton.displayName = "IconButton";
