import { startOfWeek, eachDayOfInterval, endOfWeek, format } from "date-fns";
import { cn } from "@/lib/utils";

function isTodayInTz(date: Date, tz: string): boolean {
  const dayStr = date.toLocaleDateString("en-CA", { timeZone: tz });
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  return dayStr === todayStr;
}

interface WeekHeaderProps {
  currentDate: Date;
  timezone?: string;
}

export function WeekHeader({ currentDate, timezone }: WeekHeaderProps) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: weekStart, end: weekEnd });

  return (
    <div className="grid grid-cols-[48px_repeat(7,1fr)] border-b border-border bg-muted/30">
      {/* Empty corner cell for time labels column */}
      <div className="border-r border-border" />
      {days.map((day) => {
        const today = isTodayInTz(day, tz);
        return (
          <div
            key={day.toISOString()}
            className={cn(
              "px-2 py-2 text-center border-r border-border last:border-r-0",
            )}
          >
            <span className="text-[11px] font-medium text-muted-foreground">
              {format(day, "EEE")}
            </span>
            <span
              className={cn(
                "ml-1.5 text-[11px] font-medium inline-flex items-center justify-center size-6 rounded-full",
                today ? "bg-foreground text-background" : "text-foreground",
              )}
            >
              {format(day, "d")}
            </span>
          </div>
        );
      })}
    </div>
  );
}
