import { useState, useCallback } from "react";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { addMonths, subMonths, addWeeks, subWeeks, startOfMonth, startOfWeek, format } from "date-fns";
import { Loader2 } from "lucide-react";
import { CalendarHeader, type CalendarPeriod } from "./calendar-header";
import { CalendarGrid } from "./calendar-grid";
import { WeekTimeGrid } from "./week-time-grid";
import { DraftsSidePanel } from "./drafts-side-panel";
import { CalendarPostCard } from "./calendar-post-card";
import { useCalendarPosts, type CalendarPost } from "./use-calendar-posts";
import { useTimezone } from "@/hooks/use-timezone";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";

interface CalendarViewProps {
  statusFilter: string;
  filterQuery: Record<string, string | undefined>;
  onOpenNewPost: (date?: string) => void;
  onEdit?: (postId: string) => void;
  onDelete?: (postId: string) => void;
  initialPeriod?: CalendarPeriod;
}

export function CalendarView({ statusFilter, filterQuery, onOpenNewPost, onEdit, onDelete, initialPeriod = "month" }: CalendarViewProps) {
  const timezone = useTimezone();
  const [period, setPeriod] = useState<CalendarPeriod>(initialPeriod);
  const [currentDate, setCurrentDate] = useState(() =>
    period === "week" ? startOfWeek(new Date(), { weekStartsOn: 1 }) : startOfMonth(new Date())
  );
  const [draftsPanelOpen, setDraftsPanelOpen] = useState(false);
  const [activePost, setActivePost] = useState<CalendarPost | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const { postsByDate, postsByHour, drafts, loading, error, refetch, silentRefetch, optimisticMove, truncated } = useCalendarPosts(
    currentDate,
    filterQuery,
    statusFilter,
    period,
    timezone,
  );

  // Refetch calendar data when post events arrive via WebSocket (silent — no loading spinner)
  useRealtimeUpdates(useCallback((event) => {
    if (event.type.startsWith("post.")) silentRefetch();
  }, [silentRefetch]));

  const handlePrev = useCallback(() => {
    setCurrentDate((d) => period === "week" ? subWeeks(d, 1) : subMonths(d, 1));
  }, [period]);

  const handleNext = useCallback(() => {
    setCurrentDate((d) => period === "week" ? addWeeks(d, 1) : addMonths(d, 1));
  }, [period]);

  const handleToday = useCallback(() => {
    setCurrentDate(period === "week" ? startOfWeek(new Date(), { weekStartsOn: 1 }) : startOfMonth(new Date()));
  }, [period]);

  const handlePeriodChange = useCallback((newPeriod: CalendarPeriod) => {
    setPeriod(newPeriod);
    setCurrentDate(newPeriod === "week" ? startOfWeek(new Date(), { weekStartsOn: 1 }) : startOfMonth(new Date()));
    localStorage.setItem("posts:calendarPeriod", newPeriod);
    const url = new URL(window.location.href);
    url.searchParams.set("period", newPeriod);
    window.history.replaceState({}, "", url.toString());
  }, []);

  const handleClickDate = useCallback(
    (date: Date) => {
      onOpenNewPost(format(date, "yyyy-MM-dd"));
    },
    [onOpenNewPost],
  );

  const handleClickDateTime = useCallback(
    (date: Date) => {
      onOpenNewPost(format(date, "yyyy-MM-dd'T'HH:mm"));
    },
    [onOpenNewPost],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const post = event.active.data.current?.post as CalendarPost | undefined;
    if (post) setActivePost(post);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActivePost(null);
      const { active, over } = event;
      if (!over) return;

      const post = active.data.current?.post as CalendarPost | undefined;
      if (!post) return;

      const targetId = over.id as string;

      // Prevent moving posts to past dates or more than 30 days out
      if (new Date(targetId) < new Date()) return;
      const maxDate = new Date();
      maxDate.setDate(maxDate.getDate() + 30);
      if (new Date(targetId) > maxDate) return;

      // Check if same position
      if (targetId.includes("T")) {
        // Week view: target is "yyyy-MM-ddTHH:mm"
        const currentDateStr = post.scheduled_at
          ? format(new Date(post.scheduled_at), "yyyy-MM-dd'T'HH:00")
          : null;
        if (currentDateStr === targetId) return;
      } else {
        // Month view: target is "yyyy-MM-dd"
        const currentDateStr = post.scheduled_at
          ? format(new Date(post.scheduled_at), "yyyy-MM-dd")
          : null;
        if (currentDateStr === targetId) return;
      }

      await optimisticMove(post.id, targetId);
    },
    [optimisticMove],
  );

  return (
    <div className="space-y-3">
      <CalendarHeader
        currentDate={currentDate}
        period={period}
        onPrev={handlePrev}
        onNext={handleNext}
        onToday={handleToday}
        onPeriodChange={handlePeriodChange}
        draftCount={drafts.length}
        onToggleDrafts={() => setDraftsPanelOpen((o) => !o)}
        draftsOpen={draftsPanelOpen}
      />

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {truncated && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
          Too many posts to display. Select a workspace to narrow results.
        </div>
      )}

      <div className="relative">
        <DndContext
          sensors={sensors}
          collisionDetection={period === "week" ? closestCenter : undefined}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : period === "week" ? (
            <WeekTimeGrid
              currentDate={currentDate}
              postsByHour={postsByHour}
              onClickDateTime={handleClickDateTime}
              onEdit={onEdit}
              onDelete={onDelete}
              timezone={timezone}
            />
          ) : (
            <CalendarGrid
              month={currentDate}
              postsByDate={postsByDate}
              onClickDate={handleClickDate}
              onEdit={onEdit}
              onDelete={onDelete}
              timezone={timezone}
            />
          )}

          <DraftsSidePanel
            open={draftsPanelOpen}
            onOpenChange={setDraftsPanelOpen}
            drafts={drafts}
          />

          <DragOverlay>
            {activePost ? <CalendarPostCard post={activePost} overlay /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}
