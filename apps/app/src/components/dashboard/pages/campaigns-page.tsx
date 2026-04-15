import { useState, useCallback } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { motion } from "motion/react";
import { Plus, Megaphone, ListOrdered, MessageSquare, Rss, Loader2, BookOpen, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";
import { BroadcastsCreateDialog } from "@/components/dashboard/campaigns/broadcasts-create-dialog";
import { SequencesCreateDialog } from "@/components/dashboard/campaigns/sequences-create-dialog";
import { CommentAutomationCreateDialog } from "@/components/dashboard/campaigns/comment-automation-create-dialog";
import { CommentAutomationEditDialog } from "@/components/dashboard/campaigns/comment-automation-edit-dialog";
import { SequencesEditDialog } from "@/components/dashboard/campaigns/sequences-edit-dialog";
import { BroadcastsEditDialog } from "@/components/dashboard/campaigns/broadcasts-edit-dialog";
import { AutoPostCreateDialog } from "@/components/dashboard/campaigns/auto-post-create-dialog";
import { AutoPostEditDialog } from "@/components/dashboard/campaigns/auto-post-edit-dialog";
import { EngagementRuleCreateDialog } from "@/components/dashboard/campaigns/engagement-rule-create-dialog";
import { EngagementRuleEditDialog } from "@/components/dashboard/campaigns/engagement-rule-edit-dialog";
import type { EngagementRuleResponse } from "@/components/dashboard/campaigns/engagement-rule-edit-dialog";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

// --- Types ---

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

interface SequenceResponse {
  id: string;
  name: string;
  account_id: string;
  status: "draft" | "active" | "paused";
  steps_count: number;
  total_enrolled: number;
  total_completed: number;
  total_exited: number;
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

interface CommentAutomationResponse {
  id: string;
  name: string;
  platform: "instagram" | "facebook";
  account_id: string;
  post_id: string | null;
  enabled: boolean;
  keywords: string[];
  match_mode: "contains" | "exact";
  dm_message: string;
  public_reply: string | null;
  once_per_user: boolean;
  stats: { total_triggered: number; last_triggered_at: string | null };
  created_at: string;
}

// --- Status badge helpers ---

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
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cfg!.classes)}>
      {cfg!.label}
    </span>
  );
}

function sequenceStatusBadge(status: SequenceResponse["status"]) {
  const map: Record<string, { label: string; classes: string }> = {
    draft: { label: "Draft", classes: "text-neutral-400 bg-neutral-400/10" },
    active: { label: "Active", classes: "text-emerald-400 bg-emerald-400/10" },
    paused: { label: "Paused", classes: "text-amber-400 bg-amber-400/10" },
  };
  const cfg = map[status] ?? map.draft!;
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cfg!.classes)}>
      {cfg!.label}
    </span>
  );
}

function platformBadge(platform: "instagram" | "facebook") {
  const cfg = platform === "instagram"
    ? { label: "Instagram", classes: "text-purple-400 bg-purple-400/10" }
    : { label: "Facebook", classes: "text-blue-400 bg-blue-400/10" };
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cfg.classes)}>
      {cfg.label}
    </span>
  );
}

// --- Tabs ---

const tabs = [
  { key: "broadcasts", label: "Broadcasts" },
  { key: "sequences", label: "Sequences" },
  { key: "comment-to-dm", label: "Comment-to-DM" },
  { key: "auto-post", label: "Auto-Post" },
  { key: "engagement-rules", label: "Engagement Rules" },
] as const;

// --- Helpers ---

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

function engagementRuleStatusBadge(status: "active" | "paused") {
  const cfg = status === "active"
    ? { label: "Active", classes: "text-emerald-400 bg-emerald-400/10" }
    : { label: "Paused", classes: "text-amber-400 bg-amber-400/10" };
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cfg.classes)}>
      {cfg.label}
    </span>
  );
}

function formatMetric(metric: string, threshold: number) {
  return `≥ ${threshold} ${metric}`;
}

function formatActionType(type: string) {
  switch (type) {
    case "repost": return "Retweet/Reshare";
    case "reply": return "Reply";
    case "repost_from_account": return "Repost from account";
    default: return type;
  }
}

function formatCheckSchedule(intervalMin: number, maxChecks: number) {
  const hours = intervalMin / 60;
  const interval = hours >= 1 ? `${hours}h` : `${intervalMin}min`;
  return `Every ${interval}, ${maxChecks} check${maxChecks > 1 ? "s" : ""}`;
}

function formatInterval(minutes: number) {
  if (minutes < 60) return `Every ${minutes}min`;
  const hours = minutes / 60;
  return hours === 1 ? "Every 1h" : `Every ${hours}h`;
}

// --- Main Component ---

export function CampaignsPage({
  initialTab = "broadcasts",
}: {
  initialTab?:
    | "broadcasts"
    | "sequences"
    | "comment-to-dm"
    | "auto-post"
    | "engagement-rules";
} = {}) {
  const [activeTab, setActiveTab] = useState(initialTab);

  const switchTab = (tab: string) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  // Data
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
    data: sequences,
    loading: sequencesLoading,
    error: sequencesError,
    hasMore: sequencesHasMore,
    loadMore: sequencesLoadMore,
    loadingMore: sequencesLoadingMore,
    refetch: sequencesRefetch,
  } = usePaginatedApi<SequenceResponse>(activeTab === "sequences" ? "sequences" : null);

  const {
    data: automations,
    loading: automationsLoading,
    error: automationsError,
    hasMore: automationsHasMore,
    loadMore: automationsLoadMore,
    loadingMore: automationsLoadingMore,
    refetch: automationsRefetch,
  } = usePaginatedApi<CommentAutomationResponse>(activeTab === "comment-to-dm" ? "comment-automations" : null);

  const {
    data: autoPostRules,
    loading: autoPostLoading,
    error: autoPostError,
    hasMore: autoPostHasMore,
    loadMore: autoPostLoadMore,
    loadingMore: autoPostLoadingMore,
    refetch: autoPostRefetch,
  } = usePaginatedApi<AutoPostRuleResponse>(activeTab === "auto-post" ? "auto-post-rules" : null);

  const {
    data: engagementRules,
    loading: engagementRulesLoading,
    error: engagementRulesError,
    hasMore: engagementRulesHasMore,
    loadMore: engagementRulesLoadMore,
    loadingMore: engagementRulesLoadingMore,
    refetch: engagementRulesRefetch,
  } = usePaginatedApi<EngagementRuleResponse>(activeTab === "engagement-rules" ? "engagement-rules" : null);

  // Real-time: broadcast status transitions (scheduled → sending → sent/failed)
  useRealtimeUpdates(useCallback((event) => {
    if (event.type === "broadcast.updated") broadcastsRefetch();
  }, [broadcastsRefetch]));

  // Dialogs
  const [broadcastDialogOpen, setBroadcastDialogOpen] = useState(false);
  const [sequenceDialogOpen, setSequenceDialogOpen] = useState(false);
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<CommentAutomationResponse | null>(null);
  const [editingSequence, setEditingSequence] = useState<SequenceResponse | null>(null);
  const [editingBroadcast, setEditingBroadcast] = useState<BroadcastResponse | null>(null);
  const [autoPostDialogOpen, setAutoPostDialogOpen] = useState(false);
  const [editingAutoPost, setEditingAutoPost] = useState<AutoPostRuleResponse | null>(null);
  const [engagementRuleDialogOpen, setEngagementRuleDialogOpen] = useState(false);
  const [editingEngagementRule, setEditingEngagementRule] = useState<EngagementRuleResponse | null>(null);

  return (
    <div className="space-y-6">
      {/* Header */}
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
        {activeTab === "sequences" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setSequenceDialogOpen(true)}>
            <Plus className="size-3.5" />
            Create Sequence
          </Button>
        )}
        {activeTab === "comment-to-dm" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setAutomationDialogOpen(true)}>
            <Plus className="size-3.5" />
            Create Automation
          </Button>
        )}
        {activeTab === "auto-post" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setAutoPostDialogOpen(true)}>
            <Plus className="size-3.5" />
            Create Rule
          </Button>
        )}
        {activeTab === "engagement-rules" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setEngagementRuleDialogOpen(true)}>
            <Plus className="size-3.5" />
            Create Rule
          </Button>
        )}
      </div>

      {/* Tabs */}
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

      {/* Broadcasts Tab */}
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

      {/* Sequences Tab */}
      {activeTab === "sequences" && (
        <>
          {sequencesError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {sequencesError}
            </div>
          )}
          {sequencesLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : sequences.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <ListOrdered className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No sequences yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Create automated multi-step message sequences
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
                      <th className="px-4 py-2.5 text-left">Status</th>
                      <th className="px-4 py-2.5 text-right hidden sm:table-cell">Steps</th>
                      <th className="px-4 py-2.5 text-right hidden md:table-cell">Enrolled</th>
                      <th className="px-4 py-2.5 text-right hidden lg:table-cell">Completed</th>
                      <th className="px-4 py-2.5 text-right hidden lg:table-cell">Exited</th>
                      <th className="px-4 py-2.5 text-right hidden sm:table-cell">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sequences.map((s, i) => (
                      <motion.tr
                        key={s.id}
                        variants={fadeUp}
                        className={cn(
                          "hover:bg-accent/30 transition-colors cursor-pointer",
                          i !== sequences.length - 1 && "border-b border-border"
                        )}
                        onClick={() => setEditingSequence(s)}
                      >
                        <td className="px-4 py-3 text-[13px] font-medium">{s.name}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell font-mono">{s.account_id}</td>
                        <td className="px-4 py-3">{sequenceStatusBadge(s.status)}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">{s.steps_count}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden md:table-cell">{s.total_enrolled}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden lg:table-cell">{s.total_completed}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden lg:table-cell">{s.total_exited}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">{formatDate(s.created_at)}</td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
              <LoadMore
                hasMore={sequencesHasMore}
                loading={sequencesLoadingMore}
                onLoadMore={sequencesLoadMore}
                count={sequences.length}
              />
            </>
          )}
        </>
      )}

      {/* Comment-to-DM Tab */}
      {activeTab === "comment-to-dm" && (
        <>
          {automationsError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {automationsError}
            </div>
          )}
          {automationsLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : automations.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <MessageSquare className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No automations yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Auto-reply with a DM when someone comments with a keyword
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
                      <th className="px-4 py-2.5 text-left hidden sm:table-cell">Platform</th>
                      <th className="px-4 py-2.5 text-left hidden md:table-cell">Scope</th>
                      <th className="px-4 py-2.5 text-left hidden lg:table-cell">Keywords</th>
                      <th className="px-4 py-2.5 text-right hidden sm:table-cell">Triggered</th>
                      <th className="px-4 py-2.5 text-left">Enabled</th>
                      <th className="px-4 py-2.5 text-right hidden sm:table-cell">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {automations.map((a, i) => (
                      <motion.tr
                        key={a.id}
                        variants={fadeUp}
                        className={cn(
                          "hover:bg-accent/30 transition-colors cursor-pointer",
                          i !== automations.length - 1 && "border-b border-border"
                        )}
                        onClick={() => setEditingAutomation(a)}
                      >
                        <td className="px-4 py-3 text-[13px] font-medium">{a.name}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">{platformBadge(a.platform)}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell">
                          {a.post_id ? (
                            <span className="font-mono text-[11px]" title={a.post_id}>{truncate(a.post_id, 20)}</span>
                          ) : (
                            <span className="text-muted-foreground">All posts</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">
                          {truncate(a.keywords.join(", "), 50)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">{a.stats.total_triggered}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium">
                            <span className={cn("size-1.5 rounded-full", a.enabled ? "bg-emerald-400" : "bg-neutral-400")} />
                            {a.enabled ? "On" : "Off"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">{formatDate(a.created_at)}</td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
              <LoadMore
                hasMore={automationsHasMore}
                loading={automationsLoadingMore}
                onLoadMore={automationsLoadMore}
                count={automations.length}
              />
            </>
          )}
        </>
      )}

      {/* Auto-Post Tab */}
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

      {/* Engagement Rules Tab */}
      {activeTab === "engagement-rules" && (
        <>
          {engagementRulesError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {engagementRulesError}
            </div>
          )}
          {engagementRulesLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : engagementRules.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <TrendingUp className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No engagement rules yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Automatically amplify posts that perform well
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
                      <th className="px-4 py-2.5 text-left hidden sm:table-cell">Trigger</th>
                      <th className="px-4 py-2.5 text-left hidden sm:table-cell">Action</th>
                      <th className="px-4 py-2.5 text-left hidden md:table-cell">Schedule</th>
                      <th className="px-4 py-2.5 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {engagementRules.map((r, i) => (
                      <motion.tr
                        key={r.id}
                        variants={fadeUp}
                        className={cn(
                          "hover:bg-accent/30 transition-colors cursor-pointer",
                          i < engagementRules.length - 1 && "border-b border-border"
                        )}
                        onClick={() => setEditingEngagementRule(r)}
                      >
                        <td className="px-4 py-3 font-medium">{truncate(r.name, 40)}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden sm:table-cell">
                          {formatMetric(r.trigger_metric, r.trigger_threshold)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden sm:table-cell">
                          {formatActionType(r.action_type)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell">
                          {formatCheckSchedule(r.check_interval_minutes, r.max_checks)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {engagementRuleStatusBadge(r.status)}
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
              <LoadMore
                hasMore={engagementRulesHasMore}
                loading={engagementRulesLoadingMore}
                onLoadMore={engagementRulesLoadMore}
                count={engagementRules.length}
              />
            </>
          )}
        </>
      )}

      {/* Dialogs */}
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
      <SequencesCreateDialog
        open={sequenceDialogOpen}
        onOpenChange={setSequenceDialogOpen}
        onCreated={sequencesRefetch}
      />
      <CommentAutomationCreateDialog
        open={automationDialogOpen}
        onOpenChange={setAutomationDialogOpen}
        onCreated={automationsRefetch}
      />
      <SequencesEditDialog
        open={!!editingSequence}
        onOpenChange={(v) => { if (!v) setEditingSequence(null); }}
        sequence={editingSequence}
        onUpdated={sequencesRefetch}
      />
      <CommentAutomationEditDialog
        open={!!editingAutomation}
        onOpenChange={(v) => { if (!v) setEditingAutomation(null); }}
        automation={editingAutomation}
        onUpdated={automationsRefetch}
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
      <EngagementRuleCreateDialog
        open={engagementRuleDialogOpen}
        onOpenChange={setEngagementRuleDialogOpen}
        onCreated={engagementRulesRefetch}
      />
      <EngagementRuleEditDialog
        open={!!editingEngagementRule}
        onOpenChange={(v) => { if (!v) setEditingEngagementRule(null); }}
        rule={editingEngagementRule}
        onUpdated={engagementRulesRefetch}
      />
    </div>
  );
}
