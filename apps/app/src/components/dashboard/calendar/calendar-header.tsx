import { format, startOfWeek, endOfWeek, isSameMonth } from "date-fns";
import { ChevronLeft, ChevronRight, FileEdit } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CalendarPeriod = "week" | "month";

interface CalendarHeaderProps {
  currentDate: Date;
  period: CalendarPeriod;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onPeriodChange: (period: CalendarPeriod) => void;
  draftCount: number;
  onToggleDrafts: () => void;
  draftsOpen: boolean;
}

export function CalendarHeader({
  currentDate,
  period,
  onPrev,
  onNext,
  onToday,
  onPeriodChange,
  draftCount,
  onToggleDrafts,
  draftsOpen,
}: CalendarHeaderProps) {
  const dateLabel = period === "week"
    ? formatWeekRange(currentDate)
    : format(currentDate, "MMMM yyyy");

  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={onPrev}>
          <ChevronLeft className="size-3.5" />
        </Button>
        <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={onNext}>
          <ChevronRight className="size-3.5" />
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onToday}>
          Today
        </Button>
        <h2 className="text-sm font-medium min-w-[140px]">
          {dateLabel}
        </h2>
      </div>

      <div className="flex items-center gap-2">
        {/* Week/Month toggle — styled like the Drafts button */}
        <div className="inline-flex items-center rounded-md border border-border bg-background h-7 p-0.5 text-xs">
          <button
            onClick={() => onPeriodChange("week")}
            className={cn(
              "inline-flex items-center justify-center rounded-sm px-2.5 h-full font-medium transition-colors",
              period === "week"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Week
          </button>
          <button
            onClick={() => onPeriodChange("month")}
            className={cn(
              "inline-flex items-center justify-center rounded-sm px-2.5 h-full font-medium transition-colors",
              period === "month"
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Month
          </button>
        </div>

        <Button
          variant={draftsOpen ? "secondary" : "outline"}
          size="sm"
          className="h-7 text-xs gap-1.5"
          onClick={onToggleDrafts}
        >
          <FileEdit className="size-3" />
          Drafts{draftCount > 0 && ` (${draftCount})`}
        </Button>
      </div>
    </div>
  );
}

function formatWeekRange(date: Date): string {
  const weekStart = startOfWeek(date, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(date, { weekStartsOn: 1 });

  if (isSameMonth(weekStart, weekEnd)) {
    // "Apr 7 - 13, 2026"
    return `${format(weekStart, "MMM d")} - ${format(weekEnd, "d, yyyy")}`;
  }

  // Cross-month: "Mar 30 - Apr 5, 2026"
  if (weekStart.getFullYear() === weekEnd.getFullYear()) {
    return `${format(weekStart, "MMM d")} - ${format(weekEnd, "MMM d, yyyy")}`;
  }
  // Cross-year: "Dec 29, 2025 - Jan 4, 2026"
  return `${format(weekStart, "MMM d, yyyy")} - ${format(weekEnd, "MMM d, yyyy")}`;
}
