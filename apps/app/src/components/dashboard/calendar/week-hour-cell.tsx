import { useDroppable } from "@dnd-kit/core";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CalendarPostCard } from "./calendar-post-card";
import type { CalendarPost } from "./use-calendar-posts";

function isTodayInTz(date: Date, tz: string): boolean {
  const dayStr = date.toLocaleDateString("en-CA", { timeZone: tz });
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  return dayStr === todayStr;
}

function currentHourInTz(tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date()),
  );
}

interface WeekHourCellProps {
  date: Date;
  hour: number;
  posts: CalendarPost[];
  onClickDateTime: (date: Date) => void;
  onEdit?: (postId: string) => void;
  onDelete?: (postId: string) => void;
  timezone?: string;
}

const MAX_VISIBLE = 3;

export function WeekHourCell({ date, hour, posts, onClickDateTime, onEdit, onDelete, timezone }: WeekHourCellProps) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateStr = date.toLocaleDateString("en-CA", { timeZone: tz });
  const droppableId = `${dateStr}T${String(hour).padStart(2, "0")}:00`;

  const { setNodeRef, isOver } = useDroppable({
    id: droppableId,
    data: { date, hour },
  });

  const today = isTodayInTz(date, tz);
  // Dim past time slots
  const cellDate = new Date(date);
  cellDate.setHours(hour + 1, 0, 0, 0);
  const isPast = !today && cellDate.getTime() < Date.now();
  const isPastHourToday = today && currentHourInTz(tz) > hour;
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 30);
  const isTooFar = cellDate.getTime() > maxDate.getTime();

  const visiblePosts = posts.slice(0, MAX_VISIBLE);
  const overflowCount = posts.length - MAX_VISIBLE;

  const handleClick = (e: React.MouseEvent) => {
    if (isPast || isPastHourToday || isTooFar) return;
    // Ignore clicks on post cards or inside Radix portals (popovers, dialogs, dropdowns)
    const target = e.target as HTMLElement;
    if (target.closest("[data-post-card]")) return;
    if (target.closest("[data-radix-popper-content-wrapper]")) return;
    if (target.closest("[role='dialog']")) return;
    const clickDate = new Date(date);
    clickDate.setHours(hour, 0, 0, 0);
    onClickDateTime(clickDate);
  };

  return (
    <div
      ref={setNodeRef}
      onClick={handleClick}
      className={cn(
        "min-h-full min-w-0 overflow-hidden border-b border-r border-border px-0.5 pt-1 pb-0.5 transition-colors bg-white dark:bg-background",
        !(isPast || isPastHourToday || isTooFar) && "cursor-pointer hover:bg-accent/20",
        (isPast || isPastHourToday || isTooFar) && "cursor-default !bg-[#F3F2F0] dark:!bg-muted/40",
        isOver && "!bg-primary/10",
      )}
    >
      <div className="space-y-0.5" data-post-card>
        {visiblePosts.map((post) => (
          <CalendarPostCard key={post.id} post={post} compact onEdit={onEdit} onDelete={onDelete} timezone={tz} />
        ))}
        {/* Overflow popover — shows all posts for this slot */}
        {overflowCount > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground pl-1 pt-0.5"
                onClick={(e) => e.stopPropagation()}
              >
                <ChevronDown className="size-3" />
                {overflowCount} More
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-2 space-y-1 max-h-80 overflow-y-auto" side="right" align="start">
              {posts.map((post) => (
                <CalendarPostCard key={post.id} post={post} compact onEdit={onEdit} onDelete={onDelete} timezone={tz} />
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}
