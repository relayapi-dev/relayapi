import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { format, isSameMonth, isPast as isDayPast, startOfDay } from "date-fns";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { CalendarPostCard } from "./calendar-post-card";
import type { CalendarPost } from "./use-calendar-posts";

function isTodayInTz(date: Date, tz: string): boolean {
  const dayStr = date.toLocaleDateString("en-CA", { timeZone: tz });
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  return dayStr === todayStr;
}

interface CalendarDayCellProps {
  date: Date;
  posts: CalendarPost[];
  currentMonth: Date;
  onClickDate: (date: Date) => void;
  onEdit?: (postId: string) => void;
  onDelete?: (postId: string) => void;
  timezone?: string;
}

const MAX_VISIBLE = 3;

export function CalendarDayCell({ date, posts, currentMonth, onClickDate, onEdit, onDelete, timezone }: CalendarDayCellProps) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [showAll, setShowAll] = useState(false);
  const dateKey = date.toLocaleDateString("en-CA", { timeZone: tz });
  const { setNodeRef, isOver } = useDroppable({
    id: dateKey,
    data: { date },
  });

  const isCurrentMonth = isSameMonth(date, currentMonth);
  const today = isTodayInTz(date, tz);
  const past = !today && isDayPast(startOfDay(date));
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 30);
  const tooFar = date > maxDate;
  const visiblePosts = showAll ? posts : posts.slice(0, MAX_VISIBLE);
  const overflowCount = posts.length - MAX_VISIBLE;

  return (
    <div
      ref={setNodeRef}
      onClick={(e) => {
        if (past || tooFar) return;
        const target = e.target as HTMLElement;
        if (target.closest("[data-post-card]")) return;
        if (target.closest("[data-radix-popper-content-wrapper]")) return;
        if (target.closest("[role='dialog']")) return;
        onClickDate(date);
      }}
      className={cn(
        "min-h-[120px] border-b border-r border-border p-1 transition-colors bg-white dark:bg-background",
        !(past || tooFar) && "cursor-pointer hover:bg-accent/30",
        (past || tooFar) && "cursor-default",
        !isCurrentMonth && "!bg-[#F3F2F0] dark:!bg-muted/40",
        (past || tooFar) && "!bg-[#F3F2F0] dark:!bg-muted/40",
        isOver && "!bg-primary/10",
      )}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className={cn(
            "text-xs font-medium size-6 flex items-center justify-center rounded-full",
            today && "bg-foreground text-background",
            !isCurrentMonth && "text-muted-foreground/50",
          )}
        >
          {format(date, "d")}
        </span>
      </div>
      <div className="space-y-0.5" data-post-card>
        {visiblePosts.map((post) => (
          <CalendarPostCard key={post.id} post={post} onEdit={onEdit} onDelete={onDelete} timezone={tz} />
        ))}
        {overflowCount > 0 && !showAll && (
          <button
            className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground pl-1"
            onClick={(e) => {
              e.stopPropagation();
              setShowAll(true);
            }}
          >
            <ChevronDown className="size-3" />
            {overflowCount} More
          </button>
        )}
        {showAll && overflowCount > 0 && (
          <button
            className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground pl-1"
            onClick={(e) => {
              e.stopPropagation();
              setShowAll(false);
            }}
          >
            <ChevronUp className="size-3" />
            Show less
          </button>
        )}
      </div>
    </div>
  );
}
