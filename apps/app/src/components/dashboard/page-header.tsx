import type { ReactNode } from "react";
import { BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Standard dashboard page header: big title (22px/600/-0.01em) + optional docs
 * book icon + right-aligned primary action. Reference: ui_kits/dashboard/Posts.jsx.
 */
export function PageHeader({
  title,
  docsHref,
  subtitle,
  action,
  className,
}: {
  title: ReactNode;
  docsHref?: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-[22px] font-semibold leading-none tracking-[-0.01em]">
            {title}
          </h1>
          {docsHref && (
            <a
              href={docsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <BookOpen className="size-[17px]" strokeWidth={1.6} />
            </a>
          )}
        </div>
        {subtitle && (
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
