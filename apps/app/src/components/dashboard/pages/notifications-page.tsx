import { useState, useCallback } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { motion } from "motion/react";
import {
  Bell,
  AlertTriangle,
  CheckCircle,
  Unplug,
  CreditCard,
  BarChart3,
  CalendarDays,
  Megaphone,
  Mail,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePaginatedApi, useMutation } from "@/hooks/use-api";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

const NOTIF_TYPE_ICON: Record<string, typeof AlertTriangle> = {
  post_failed: AlertTriangle,
  post_published: CheckCircle,
  account_disconnected: Unplug,
  payment_failed: CreditCard,
  usage_warning: BarChart3,
  weekly_digest: CalendarDays,
  marketing: Megaphone,
};

const NOTIF_TYPE_COLOR: Record<string, string> = {
  post_failed: "text-rose-500",
  post_published: "text-emerald-500",
  account_disconnected: "text-amber-500",
  payment_failed: "text-rose-500",
  usage_warning: "text-amber-500",
  weekly_digest: "text-indigo-500",
  marketing: "text-indigo-500",
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const },
  },
};

export function NotificationsPage() {
  const [filter, setFilter] = useState<"all" | "unread">("all");

  const query = filter === "unread" ? { unread: "true" } : undefined;
  const {
    data: notifs,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    refetch,
  } = usePaginatedApi<NotificationItem>("notifications", { query, limit: 20 });

  // Real-time: new notifications appear instantly
  useRealtimeUpdates(useCallback((event) => {
    if (event.type === "notification.created") refetch();
  }, [refetch]));

  const { mutate: markAllRead } = useMutation("notifications", "POST");

  const handleMarkAllRead = async () => {
    await markAllRead();
    refetch();
  };

  const handleMarkRead = async (notif: NotificationItem) => {
    if (!notif.read) {
      await fetch(`/api/notifications/${notif.id}/read`, { method: "PATCH" });
      refetch();
    }
  };

  return (
    <motion.div
      className="space-y-6"
      variants={stagger}
      initial="hidden"
      animate="visible"
    >
      <motion.div variants={fadeUp} className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Notifications</h1>
        <button
          onClick={handleMarkAllRead}
          className="text-[12px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Mark all as read
        </button>
      </motion.div>

      <motion.div variants={fadeUp} className="flex gap-1">
        <button
          onClick={() => setFilter("all")}
          className={cn(
            "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
            filter === "all"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent/40",
          )}
        >
          All
        </button>
        <button
          onClick={() => setFilter("unread")}
          className={cn(
            "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
            filter === "unread"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent/40",
          )}
        >
          Unread
        </button>
      </motion.div>

      <motion.div variants={fadeUp}>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : notifs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Bell className="size-8 mb-3 opacity-30" />
            <p className="text-sm">
              {filter === "unread" ? "No unread notifications" : "No notifications yet"}
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-border overflow-hidden divide-y divide-border">
            {notifs.map((notif) => {
              const Icon = NOTIF_TYPE_ICON[notif.type] || Mail;
              const iconColor = NOTIF_TYPE_COLOR[notif.type] || "text-muted-foreground";
              return (
                <button
                  key={notif.id}
                  onClick={() => handleMarkRead(notif)}
                  className={cn(
                    "flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent/30 transition-colors",
                    !notif.read && "bg-accent/10",
                  )}
                >
                  <div className={cn("mt-0.5 flex size-8 items-center justify-center rounded-full shrink-0", !notif.read ? "bg-accent/30" : "bg-accent/10")}>
                    <Icon className={cn("size-4", iconColor)} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={cn("text-[13px]", !notif.read && "font-medium")}>
                      {notif.title}
                    </p>
                    <p className="text-[12px] text-muted-foreground mt-0.5">
                      {notif.body}
                    </p>
                    <p className="text-[11px] text-muted-foreground/60 mt-1">
                      {timeAgo(notif.createdAt)}
                    </p>
                  </div>
                  {!notif.read && (
                    <span className="mt-2 size-2 rounded-full bg-indigo-500 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        )}

        {hasMore && (
          <div className="flex justify-center pt-4">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="text-[12px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {loadingMore ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Load more"
              )}
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
