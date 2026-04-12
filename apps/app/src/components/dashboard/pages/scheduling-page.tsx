import { useState } from "react";
import { motion } from "motion/react";
import { Clock, Loader2, RotateCw, CalendarDays, BookOpen, Calendar, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApi } from "@/hooks/use-api";
import { ScheduleCreateDialog } from "@/components/dashboard/scheduling/schedule-create-dialog";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface QueueSlotTime {
  day_of_week: number;
  time: string;
  timezone: string;
}

interface QueueSchedule {
  id: string;
  name: string | null;
  slots: QueueSlotTime[];
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

interface QueueSlotsResponse {
  data: QueueSchedule[];
}

interface PreviewResponse {
  slots: string[];
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const tabs = ["Queue Slots", "Preview"] as const;

export function SchedulingPage() {
  const [activeTab, setActiveTab] = useState(() => {
    const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
    return params.get("tab") || "queue-slots";
  });

  const [createOpen, setCreateOpen] = useState(false);

  const switchTab = (tab: string) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  const { data: slotsData, loading: slotsLoading, error: slotsError, refetch: refetchSlots } =
    useApi<QueueSlotsResponse>(activeTab === "queue-slots" ? "queue/slots" : null);

  const { data: previewData, loading: previewLoading, error: previewError, refetch: refetchPreview } =
    useApi<PreviewResponse>(activeTab === "preview" ? "queue/preview?count=20" : null);

  const schedules = slotsData?.data || [];
  const totalSlots = schedules.reduce((sum, s) => sum + s.slots.length, 0);
  const upcomingSlots = previewData?.slots || [];

  const loading = activeTab === "queue-slots" ? slotsLoading : previewLoading;
  const error = activeTab === "queue-slots" ? slotsError : previewError;
  const refetch = activeTab === "queue-slots" ? refetchSlots : refetchPreview;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Scheduling</h1>
          <a href="https://docs.relayapi.dev/api-reference/queue" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent/50 transition-colors"
            onClick={() => refetch()}
          >
            <RotateCw className="size-3" />
            Refresh
          </button>
          <button
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent/50 transition-colors"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3" />
            Create Schedule
          </button>
        </div>
      </div>

      <div className="flex items-end justify-between gap-x-4 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        <div className="flex gap-4">
          {tabs.map((tab) => {
            const tabKey = tab.toLowerCase().replace(" ", "-");
            return (
              <button
                key={tab}
                onClick={() => switchTab(tabKey)}
                className={cn(
                  "pb-2 text-[13px] font-medium transition-colors whitespace-nowrap border-b-2 -mb-px",
                  activeTab === tabKey
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {tab}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {activeTab === "queue-slots" && (
        <>
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : schedules.length > 0 ? (
            <motion.div
              className="space-y-4"
              variants={stagger}
              initial="hidden"
              animate="visible"
            >
              <motion.div variants={fadeUp} className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-border p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground">Schedules</p>
                    <div className="rounded-lg p-1.5 text-blue-400 bg-blue-400/10">
                      <Calendar className="size-3.5" />
                    </div>
                  </div>
                  <p className="text-2xl font-semibold mt-2">{schedules.length}</p>
                </div>
                <div className="rounded-md border border-border p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground">Time Slots</p>
                    <div className="rounded-lg p-1.5 text-emerald-400 bg-emerald-400/10">
                      <Clock className="size-3.5" />
                    </div>
                  </div>
                  <p className="text-2xl font-semibold mt-2">{totalSlots}</p>
                </div>
              </motion.div>

              {schedules.map((schedule) => (
                <motion.div
                  key={schedule.id}
                  variants={fadeUp}
                  className="rounded-md border border-border overflow-hidden"
                >
                  <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[13px] font-medium">{schedule.name || "Unnamed Schedule"}</h3>
                      {schedule.is_default && (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-blue-400 bg-blue-400/10">
                          Default
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {schedule.slots.length} slot{schedule.slots.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  {schedule.slots.length > 0 ? (
                    <>
                      <div className="hidden md:grid grid-cols-3 gap-4 px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border bg-accent/10">
                        <span>Day</span>
                        <span>Time</span>
                        <span>Timezone</span>
                      </div>
                      {schedule.slots
                        .slice()
                        .sort((a, b) => a.day_of_week - b.day_of_week || a.time.localeCompare(b.time))
                        .map((slot, i) => (
                        <div
                          key={`${slot.day_of_week}-${slot.time}`}
                          className={cn(
                            "grid md:grid-cols-3 gap-3 md:gap-4 p-4 md:py-3 items-center text-sm hover:bg-accent/30 transition-colors",
                            i !== schedule.slots.length - 1 && "border-b border-border"
                          )}
                        >
                          <span className="text-xs font-medium">
                            <span className="md:hidden">{DAY_SHORT[slot.day_of_week]}</span>
                            <span className="hidden md:inline">{DAY_NAMES[slot.day_of_week]}</span>
                          </span>
                          <span className="text-xs text-muted-foreground font-mono">{slot.time}</span>
                          <span className="text-xs text-muted-foreground">{slot.timezone}</span>
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="p-4 text-center">
                      <p className="text-xs text-muted-foreground">No time slots configured</p>
                    </div>
                  )}
                </motion.div>
              ))}
            </motion.div>
          ) : (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <Clock className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No queue schedules</p>
              <p className="text-xs text-muted-foreground mt-1">
                Create a queue schedule to auto-schedule posts at recurring times
              </p>
            </div>
          )}
        </>
      )}

      {activeTab === "preview" && (
        <>
          {previewLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : upcomingSlots.length > 0 ? (
            <motion.div
              className="rounded-md border border-border overflow-hidden"
              variants={stagger}
              initial="hidden"
              animate="visible"
            >
              <div className="px-4 py-3 border-b border-border">
                <h3 className="text-[13px] font-medium">Upcoming Slots</h3>
              </div>
              <div className="hidden md:grid grid-cols-3 gap-4 px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border bg-accent/10">
                <span>Date</span>
                <span>Day</span>
                <span>Time</span>
              </div>
              {upcomingSlots.map((slot, i) => {
                const d = new Date(slot);
                return (
                  <motion.div
                    key={slot}
                    variants={fadeUp}
                    className={cn(
                      "grid md:grid-cols-3 gap-3 md:gap-4 p-4 md:py-3 items-center text-sm hover:bg-accent/30 transition-colors",
                      i !== upcomingSlots.length - 1 && "border-b border-border"
                    )}
                  >
                    <span className="text-xs font-medium">
                      {d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </span>
                    <span className="text-xs text-muted-foreground">{DAY_NAMES[d.getDay()]}</span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </motion.div>
                );
              })}
            </motion.div>
          ) : (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <CalendarDays className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No upcoming slots</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                Configure queue schedules to see upcoming publishing times
              </p>
            </div>
          )}
        </>
      )}

      <ScheduleCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => refetchSlots()}
      />
    </div>
  );
}
