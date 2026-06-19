import { format, startOfWeek, endOfWeek, isSameMonth } from "date-fns";
import { ChevronLeft, ChevronRight, FileEdit } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/dashboard/icon-button";
import { Segmented } from "@/components/dashboard/segmented";

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
    <div className="flex items-center justify-between flex-wrap gap-3">
      <div className="flex items-center gap-2.5">
        <div className="flex gap-1">
          <IconButton
            className="border border-border bg-card hover:bg-sidebar-accent"
            onClick={onPrev}
            title="Previous"
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            className="border border-border bg-card hover:bg-sidebar-accent"
            onClick={onNext}
            title="Next"
          >
            <ChevronRight />
          </IconButton>
        </div>
        <Button variant="outline" size="sm" onClick={onToday}>
          Today
        </Button>
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] min-w-[140px]">
          {dateLabel}
        </h2>
      </div>

      <div className="flex items-center gap-2">
        <Segmented
          value={period}
          onChange={onPeriodChange}
          options={[
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />

        <Button
          variant={draftsOpen ? "secondary" : "outline"}
          size="sm"
          className="gap-1.5"
          onClick={onToggleDrafts}
        >
          <FileEdit className="size-3.5" />
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
