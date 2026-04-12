import { useState, useRef, useEffect, useMemo } from "react";
import { startOfWeek, endOfWeek, eachDayOfInterval } from "date-fns";
import { ChevronDown, ChevronUp } from "lucide-react";
import { WeekHeader } from "./week-header";
import { WeekHourCell } from "./week-hour-cell";
import { NowIndicator } from "./now-indicator";
import type { CalendarPost } from "./use-calendar-posts";

function isTodayInTz(date: Date, tz: string): boolean {
  const dayStr = date.toLocaleDateString("en-CA", { timeZone: tz });
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  return dayStr === todayStr;
}

interface WeekTimeGridProps {
  currentDate: Date;
  postsByHour: Map<string, CalendarPost[]>;
  onClickDateTime: (date: Date) => void;
  onEdit?: (postId: string) => void;
  onDelete?: (postId: string) => void;
  timezone?: string;
}

const STANDARD_HOURS = Array.from({ length: 12 }, (_, i) => i + 8); // 8–19
const EARLY_HOURS = Array.from({ length: 8 }, (_, i) => i); // 0–7
const EVENING_HOURS = Array.from({ length: 4 }, (_, i) => i + 20); // 20–23

function formatHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

export function WeekTimeGrid({ currentDate, postsByHour, onClickDateTime, onEdit, onDelete, timezone }: WeekTimeGridProps) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showEarlyHours, setShowEarlyHours] = useState(false);
  const [showEveningHours, setShowEveningHours] = useState(false);
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: weekStart, end: weekEnd });

  // Count off-hours posts across the week
  const { earlyPostCount, eveningPostCount } = useMemo(() => {
    let early = 0;
    let evening = 0;
    for (const day of days) {
      const dayStr = day.toLocaleDateString("en-CA", { timeZone: tz });
      for (let h = 0; h < 8; h++) {
        early += (postsByHour.get(`${dayStr}T${String(h).padStart(2, "0")}`) ?? []).length;
      }
      for (let h = 20; h < 24; h++) {
        evening += (postsByHour.get(`${dayStr}T${String(h).padStart(2, "0")}`) ?? []).length;
      }
    }
    return { earlyPostCount: early, eveningPostCount: evening };
  }, [days, postsByHour, tz]);

  // Auto-scroll to current hour within the standard range
  useEffect(() => {
    if (!scrollRef.current) return;
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).formatToParts(now);
    const currentHour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0");
    if (currentHour >= 8 && currentHour <= 19) {
      const rowIndex = currentHour - 8;
      scrollRef.current.scrollTop = Math.max(rowIndex - 1, 0) * 144;
    }
  }, [currentDate, tz]);

  // Check if today is in this week (for the now indicator)
  const todayInWeek = days.some((d) => isTodayInTz(d, tz));
  const todayIndex = days.findIndex((d) => isTodayInTz(d, tz));

  const renderHourRow = (hour: number) => (
    <div key={hour} data-hour-row className="grid grid-cols-[48px_repeat(7,1fr)] min-h-36">
      <div className="border-r border-b border-border flex items-start justify-end pr-2 pt-0.5">
        <span className="text-[10px] text-muted-foreground">
          {formatHourLabel(hour)}
        </span>
      </div>
      {days.map((day) => {
        const dayStr = day.toLocaleDateString("en-CA", { timeZone: tz });
        const hourKey = `${dayStr}T${String(hour).padStart(2, "0")}`;
        const posts = postsByHour.get(hourKey) ?? [];
        return (
          <WeekHourCell
            key={hourKey}
            date={day}
            hour={hour}
            posts={posts}
            onClickDateTime={onClickDateTime}
            onEdit={onEdit}
            onDelete={onDelete}
            timezone={tz}
          />
        );
      })}
    </div>
  );

  const todayColumnStyle = {
    left: `calc(48px + ${todayIndex} * ((100% - 48px) / 7))`,
    width: `calc((100% - 48px) / 7)`,
  };

  return (
    <div className="rounded-md border border-border overflow-hidden overflow-x-auto">
      <div
        ref={scrollRef}
        className="overflow-y-auto min-w-[700px]"
        style={{ maxHeight: "calc(-13rem + 100vh)" }}
      >
        {/* Header inside scroll container so columns align with the grid */}
        <div className="sticky top-0 z-20 bg-background">
          <WeekHeader currentDate={currentDate} timezone={tz} />
        </div>

        {/* Before 8 AM banner */}
        {earlyPostCount > 0 && (
          <>
            <button
              onClick={() => setShowEarlyHours((v) => !v)}
              className="grid grid-cols-[48px_1fr] w-full border-b border-border bg-muted/30 hover:bg-muted/50 transition-colors"
            >
              <div className="border-r border-border" />
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
                {showEarlyHours ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                {earlyPostCount} {earlyPostCount === 1 ? "post" : "posts"} before 8 AM
              </div>
            </button>
            {showEarlyHours && (
              <div className="relative">
                {EARLY_HOURS.map(renderHourRow)}
              </div>
            )}
          </>
        )}

        {/* Standard hours: 8 AM – 7 PM (covers up to 8 PM) */}
        <div className="relative">
          {todayInWeek && (
            <div
              className="absolute top-0 bottom-0 z-10 pointer-events-none"
              style={todayColumnStyle}
            >
              <NowIndicator timezone={tz} startHour={8} totalHours={12} />
            </div>
          )}
          {STANDARD_HOURS.map(renderHourRow)}
        </div>

        {/* After 8 PM banner */}
        {eveningPostCount > 0 && (
          <>
            <button
              onClick={() => setShowEveningHours((v) => !v)}
              className="grid grid-cols-[48px_1fr] w-full border-b border-border bg-muted/30 hover:bg-muted/50 transition-colors"
            >
              <div className="border-r border-border" />
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
                {showEveningHours ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                {eveningPostCount} {eveningPostCount === 1 ? "post" : "posts"} after 8 PM
              </div>
            </button>
            {showEveningHours && (
              <div className="relative">
                {EVENING_HOURS.map(renderHourRow)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
