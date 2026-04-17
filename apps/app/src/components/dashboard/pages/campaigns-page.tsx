import { useState, useCallback } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { motion } from "motion/react";
import { Plus, Megaphone, Rss, Loader2, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";
import { BroadcastsCreateDialog } from "@/components/dashboard/campaigns/broadcasts-create-dialog";
import { BroadcastsEditDialog } from "@/components/dashboard/campaigns/broadcasts-edit-dialog";
import { AutoPostCreateDialog } from "@/components/dashboard/campaigns/auto-post-create-dialog";
import { AutoPostEditDialog } from "@/components/dashboard/campaigns/auto-post-edit-dialog";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface BroadcastResponse {
  id: string;
  name: string | null;
  account_id: string;
  message_text: string | null;
  status: "draft" | "scheduled" | "sending" | "sent" | "partially_failed" | "failed" | "cancelled";
  sent_count: number;
  failed_count: number;
  created_at: string;
}

interface AutoPostRuleResponse {
  id: string;
  name: string;
  feed_url: string;
  polling_interval_minutes: number;
  content_template: string | null;
  append_feed_url: boolean;
  account_ids: string[];
  status: "active" | "paused" | "error";
  consecutive_errors: number;
  last_processed_url: string | null;
  last_processed_at: string | null;
  last_error: string | null;
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

function broadcastStatusBadge(status: BroadcastResponse["status"]) {
  const map: Record<string, { label: string; classes: string }> = {
    draft: { label: "Draft", classes: "text-neutral-400 bg-neutral-400/10" },
    scheduled: { label: "Scheduled", classes: "text-blue-400 bg-blue-400/10" },
    sending: { label: "Sending", classes: "text-amber-400 bg-amber-400/10" },
    sent: { label: "Sent", classes: "text-emerald-400 bg-emerald-400/10" },
    partially_failed: { label: "Partial", classes: "text-amber-400 bg-amber-400/10" },
    failed: { label: "Failed", classes: "text-red-400 bg-red-400/10" },
    cancelled: { label: "Cancelled", classes: "text-neutral-400 bg-neutral-400/10" },
  };
  const cfg = map[status] ?? map.draft!;
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cfg.classes)}>
      {cfg.label}
    </span>
  );
}

function autoPostStatusBadge(status: "active" | "paused" | "error") {
  const cfg = {
    active: { label: "Active", classes: "text-emerald-400 bg-emerald-400/10" },
    paused: { label: "Paused", classes: "text-amber-400 bg-amber-400/10" },
    error: { label: "Error", classes: "text-red-400 bg-red-400/10" },
  }[status] ?? { label: status, classes: "text-neutral-400 bg-neutral-400/10" };
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cfg.classes)}>
      {cfg.label}
    </span>
  );
}

const tabs = [
  { key: "broadcasts", label: "Broadcasts" },
  { key: "auto-post", label: "Auto-Post" },
] as const;

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function truncate(str: string, maxLen: number) {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}...`;
}

function formatInterval(minutes: number) {
  if (minutes < 60) return `Every ${minutes}min`;
  const hours = minutes / 60;
  return hours === 1 ? "Every 1h" : `Every ${hours}h`;
}

export function CampaignsPage({
  initialTab = "broadcasts",
}: {
  initialTab?: "broadcasts" | "auto-post";
} = {}) {
  const [activeTab, setActiveTab] = useState(initialTab);

  const switchTab = (tab: typeof initialTab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  const {
    data: broadcasts,
    loading: broadcastsLoading,
    error: broadcastsError,
    hasMore: broadcastsHasMore,
    loadMore: broadcastsLoadMore,
    loadingMore: broadcastsLoadingMore,
    refetch: broadcastsRefetch,
  } = usePaginatedApi<BroadcastResponse>(activeTab === "broadcasts" ? "broadcasts" : null);

  const {
    data: autoPostRules,
    loading: autoPostLoading,
    error: autoPostError,
    hasMore: autoPostHasMore,
    loadMore: autoPostLoadMore,
    loadingMore: autoPostLoadingMore,
    refetch: autoPostRefetch,
  } = usePaginatedApi<AutoPostRuleResponse>(activeTab === "auto-post" ? "auto-post-rules" : null);

  useRealtimeUpdates(useCallback((event) => {
    if (event.type === "broadcast.updated") broadcastsRefetch();
  }, [broadcastsRefetch]));

  const [broadcastDialogOpen, setBroadcastDialogOpen] = useState(false);
  const [editingBroadcast, setEditingBroadcast] = useState<BroadcastResponse | null>(null);
  const [autoPostDialogOpen, setAutoPostDialogOpen] = useState(false);
  const [editingAutoPost, setEditingAutoPost] = useState<AutoPostRuleResponse | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Campaigns</h1>
          <a href="https://docs.relayapi.dev/api-reference/campaigns" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
        </div>
        {activeTab === "broadcasts" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setBroadcastDialogOpen(true)}>
            <Plus className="size-3.5" />
            Create Broadcast
          </Button>
        )}
        {activeTab === "auto-post" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setAutoPostDialogOpen(true)}>
            <Plus className="size-3.5" />
            Create Rule
          </Button>
        )}
      </div>

      <div className="flex gap-4 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => switchTab(tab.key)}
            className={cn(
              "pb-2 text-[13px] font-medium transition-colors whitespace-nowrap border-b-2 -mb-px",
              activeTab === tab.key
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "broadcasts" && (
        <>
          {broadcastsError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {broadcastsError}
            </div>
          )}
          {broadcastsLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : broadcasts.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <Megaphone className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No broadcasts yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Send a message to multiple recipients at once
              </p>
            </div>
          ) : (
            <>
              <motion.div
                className="rounded-md border border-border overflow-hidden"
                variants={stagger}
                initial="hidden"
                animate="visible"
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-accent/10 text-xs font-medium text-muted-foreground">
                      <th className="px-4 py-2.5 text-left">Name</th>
                      <th className="px-4 py-2.5 text-left hidden md:table-cell">Account</th>
                      <th className="px-4 py-2.5 text-left hidden lg:table-cell">Message</th>
                      <th className="px-4 py-2.5 text-left">Status</th>
                      <th className="px-4 py-2.5 text-right hidden md:table-cell">Sent/Failed</th>
                      <th className="px-4 py-2.5 text-right hidden sm:table-cell">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {broadcasts.map((b, i) => (
                      <motion.tr
                        key={b.id}
                        variants={fadeUp}
                        className={cn(
                          "hover:bg-accent/30 transition-colors cursor-pointer",
                          i !== broadcasts.length - 1 && "border-b border-border"
                        )}
                        onClick={() => setEditingBroadcast(b)}
                      >
                        <td className="px-4 py-3 text-[13px] font-medium">{b.name || b.id}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell font-mono">{b.account_id}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">{b.message_text ? truncate(b.message_text, 50) : <span className="text-muted-foreground/50">—</span>}</td>
                        <td className="px-4 py-3">{broadcastStatusBadge(b.status)}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden md:table-cell">
                          <span className="text-emerald-400">{b.sent_count}</span>
                          {" / "}
                          <span className="text-red-400">{b.failed_count}</span>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">{formatDate(b.created_at)}</td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
              <LoadMore
                hasMore={broadcastsHasMore}
                loading={broadcastsLoadingMore}
                onLoadMore={broadcastsLoadMore}
                count={broadcasts.length}
              />
            </>
          )}
        </>
      )}

      {activeTab === "auto-post" && (
        <>
          {autoPostError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {autoPostError}
            </div>
          )}
          {autoPostLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : autoPostRules.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <Rss className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No auto-post rules yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Set up auto-posting from RSS feeds
              </p>
            </div>
          ) : (
            <>
              <motion.div
                className="rounded-md border border-border overflow-hidden"
                variants={stagger}
                initial="hidden"
                animate="visible"
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-accent/10 text-xs font-medium text-muted-foreground">
                      <th className="px-4 py-2.5 text-left">Name</th>
                      <th className="px-4 py-2.5 text-left hidden md:table-cell">Feed URL</th>
                      <th className="px-4 py-2.5 text-left">Status</th>
                      <th className="px-4 py-2.5 text-left hidden lg:table-cell">Interval</th>
                      <th className="px-4 py-2.5 text-right hidden sm:table-cell">Last Checked</th>
                      <th className="px-4 py-2.5 text-right hidden sm:table-cell">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {autoPostRules.map((r, i) => (
                      <motion.tr
                        key={r.id}
                        variants={fadeUp}
                        className={cn(
                          "hover:bg-accent/30 transition-colors cursor-pointer",
                          i !== autoPostRules.length - 1 && "border-b border-border"
                        )}
                        onClick={() => setEditingAutoPost(r)}
                      >
                        <td className="px-4 py-3 text-[13px] font-medium">{r.name}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell">
                          <span className="font-mono">{truncate(r.feed_url, 40)}</span>
                        </td>
                        <td className="px-4 py-3">{autoPostStatusBadge(r.status)}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">
                          {formatInterval(r.polling_interval_minutes)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">
                          {r.last_processed_at ? formatDate(r.last_processed_at) : <span className="text-muted-foreground/50">Never</span>}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">{formatDate(r.created_at)}</td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
              <LoadMore
                hasMore={autoPostHasMore}
                loading={autoPostLoadingMore}
                onLoadMore={autoPostLoadMore}
                count={autoPostRules.length}
              />
            </>
          )}
        </>
      )}

      <BroadcastsCreateDialog
        open={broadcastDialogOpen}
        onOpenChange={setBroadcastDialogOpen}
        onCreated={broadcastsRefetch}
      />
      <BroadcastsEditDialog
        open={!!editingBroadcast}
        onOpenChange={(v) => { if (!v) setEditingBroadcast(null); }}
        broadcast={editingBroadcast}
        onUpdated={broadcastsRefetch}
      />
      <AutoPostCreateDialog
        open={autoPostDialogOpen}
        onOpenChange={setAutoPostDialogOpen}
        onCreated={autoPostRefetch}
      />
      <AutoPostEditDialog
        open={!!editingAutoPost}
        onOpenChange={(v) => { if (!v) setEditingAutoPost(null); }}
        rule={editingAutoPost}
        onUpdated={autoPostRefetch}
      />
    </div>
  );
}
