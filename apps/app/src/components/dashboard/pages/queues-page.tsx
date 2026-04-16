import { useCallback } from "react";
import { motion } from "motion/react";
import { Clock, CheckCircle, Loader2, AlertTriangle, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApi } from "@/hooks/use-api";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface QueueSlot {
  id: string;
  type: string;
  platform: string;
  status: string;
  duration: string | null;
  created_at: string;
}

interface QueueSlotsResponse {
  data: QueueSlot[];
  stats?: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
}

const statConfig = [
  { key: "pending", label: "Pending", icon: Clock, color: "text-blue-400 bg-blue-400/10" },
  { key: "processing", label: "Processing", icon: Loader2, color: "text-amber-400 bg-amber-400/10" },
  { key: "completed", label: "Completed", icon: CheckCircle, color: "text-emerald-400 bg-emerald-400/10" },
  { key: "failed", label: "Failed", icon: AlertTriangle, color: "text-red-400 bg-red-400/10" },
];

const statusStyles: Record<string, string> = {
  completed: "text-emerald-400 bg-emerald-400/10",
  processing: "text-amber-400 bg-amber-400/10",
  pending: "text-blue-400 bg-blue-400/10",
  failed: "text-red-400 bg-red-400/10",
};

export function QueuesPage() {
  const { data, loading, refetch } = useApi<QueueSlotsResponse>("queue/slots");
  const slots = data?.data || [];
  const stats = data?.stats || { pending: 0, processing: 0, completed: 0, failed: 0 };

  // Real-time: queue stats update when posts are published/failed
  useRealtimeUpdates(useCallback((event) => {
    if (event.type.startsWith("post.")) refetch();
  }, [refetch]));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Queues</h1>
        <button
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent/50 transition-colors"
          onClick={() => refetch()}
        >
          <RotateCw className="size-3" />
          Refresh
        </button>
      </div>

      <motion.div
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        variants={stagger}
        initial={false}
        animate="visible"
      >
        {statConfig.map((stat) => {
          const Icon = stat.icon;
          const value = stats[stat.key as keyof typeof stats] || 0;
          return (
            <motion.div
              key={stat.label}
              variants={fadeUp}
              className="rounded-md border border-border p-4"
            >
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">
                  {stat.label}
                </p>
                <div className={cn("rounded-lg p-1.5", stat.color)}>
                  <Icon className="size-3.5" />
                </div>
              </div>
              <p className="text-2xl font-semibold mt-2">
                {value.toLocaleString()}
              </p>
            </motion.div>
          );
        })}
      </motion.div>

      {slots.length > 0 && (
        <motion.div
          className="rounded-md border border-border overflow-hidden"
          variants={stagger}
          initial={false}
          animate="visible"
        >
          <div className="px-4 py-3 border-b border-border">
            <h3 className="text-[13px] font-medium">Recent Jobs</h3>
          </div>
          <div className="hidden md:grid grid-cols-[1fr_1fr_1fr_0.7fr_0.7fr_0.8fr] gap-4 px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border bg-accent/10">
            <span>Job ID</span>
            <span>Type</span>
            <span>Platform</span>
            <span>Status</span>
            <span>Duration</span>
            <span>Time</span>
          </div>
          {slots.map((job, i) => (
            <motion.div
              key={job.id}
              variants={fadeUp}
              className={cn(
                "grid md:grid-cols-[1fr_1fr_1fr_0.7fr_0.7fr_0.8fr] gap-3 md:gap-4 p-4 md:py-3 items-center text-sm hover:bg-accent/30 transition-colors",
                i !== slots.length - 1 && "border-b border-border"
              )}
            >
              <code className="text-xs font-mono text-muted-foreground">
                {job.id}
              </code>
              <span className="text-xs">{job.type}</span>
              <span className="text-xs text-muted-foreground">{job.platform || "—"}</span>
              <span
                className={cn(
                  "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                  statusStyles[job.status] || "text-blue-400 bg-blue-400/10"
                )}
              >
                {job.status}
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                {job.duration || "—"}
              </span>
              <span className="text-xs text-muted-foreground">
                {new Date(job.created_at).toLocaleTimeString("en-US", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </motion.div>
          ))}
        </motion.div>
      )}

      {slots.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-12 text-center">
          <Clock className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No queue jobs</p>
          <p className="text-xs text-muted-foreground mt-1">
            Jobs will appear here when posts are being published
          </p>
        </div>
      )}
    </div>
  );
}
