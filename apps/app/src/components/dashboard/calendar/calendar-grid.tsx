import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
} from "date-fns";
import { CalendarDayCell } from "./calendar-day-cell";
import type { CalendarPost } from "./use-calendar-posts";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface CalendarGridProps {
  month: Date;
  postsByDate: Map<string, CalendarPost[]>;
  onClickDate: (date: Date) => void;
  onEdit?: (postId: string) => void;
  onDelete?: (postId: string) => void;
  timezone?: string;
}

export function CalendarGrid({ month, postsByDate, onClickDate, onEdit, onDelete, timezone }: CalendarGridProps) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const calendarStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

  const days = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

  return (
    <div className="rounded-md border border-border overflow-hidden overflow-x-auto">
      {/* Weekday headers */}
      <div className="grid grid-cols-7 border-b border-border bg-muted/30">
        {WEEKDAYS.map((day) => (
          <div key={day} className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground text-center">
            {day}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const key = day.toLocaleDateString("en-CA", { timeZone: tz });
          return (
            <CalendarDayCell
              key={key}
              date={day}
              posts={postsByDate.get(key) ?? []}
              currentMonth={month}
              onClickDate={onClickDate}
              onEdit={onEdit}
              onDelete={onDelete}
              timezone={tz}
            />
          );
        })}
      </div>
    </div>
  );
}
