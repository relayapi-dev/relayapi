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
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { PageToolbar } from "@/components/dashboard/page-toolbar";
import { Segmented } from "@/components/dashboard/segmented";

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
  post_failed: "text-destructive",
  post_published: "text-success",
  account_disconnected: "text-foreground",
  payment_failed: "text-destructive",
  usage_warning: "text-foreground",
  weekly_digest: "text-muted-foreground",
  marketing: "text-muted-foreground",
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
      className="space-y-6 pb-16"
      variants={stagger}
      initial="hidden"
      animate="visible"
    >
      <PageHeader
        title="Notifications"
        action={
          <Button variant="outline" onClick={handleMarkAllRead}>
            Mark all as read
          </Button>
        }
      />

      <PageToolbar
        left={
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "unread", label: "Unread" },
            ]}
          />
        }
      />

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
          <div className="rounded-[12px] border border-border bg-card overflow-hidden divide-y divide-border">
            {notifs.map((notif) => {
              const Icon = NOTIF_TYPE_ICON[notif.type] || Mail;
              const iconColor = NOTIF_TYPE_COLOR[notif.type] || "text-muted-foreground";
              return (
                <button
                  type="button"
                  key={notif.id}
                  onClick={() => handleMarkRead(notif)}
                  className={cn(
                    "flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent transition-colors",
                    !notif.read && "bg-muted",
                  )}
                >
                  <div className={cn("mt-0.5 flex size-8 items-center justify-center rounded-full shrink-0", !notif.read ? "bg-accent" : "bg-muted")}>
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
                    <span className="mt-2 size-2 rounded-full bg-primary shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        )}

        {hasMore && (
          <div className="flex justify-center pt-4">
            <button
              type="button"
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
