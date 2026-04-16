import { useState } from "react";
import { motion } from "motion/react";
import { Plus, Zap, Loader2, Trash2, FileText, BookOpen, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { usePaginatedApi, useMutation } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";

const WEBHOOK_EVENT_GROUPS = [
  {
    label: "Posts",
    events: [
      { value: "post.published", description: "Post successfully published" },
      { value: "post.failed", description: "Post failed to publish" },
      { value: "post.partial", description: "Partially published on some platforms" },
      { value: "post.scheduled", description: "Post scheduled for later" },
      { value: "post.recycled", description: "Post recycled (evergreen content)" },
    ],
  },
  {
    label: "Accounts",
    events: [
      { value: "account.connected", description: "Social account connected" },
      { value: "account.disconnected", description: "Social account disconnected" },
    ],
  },
  {
    label: "Engagement",
    events: [
      { value: "comment.received", description: "New comment on a post" },
      { value: "message.received", description: "Direct message received" },
    ],
  },
];
const ALL_EVENTS = WEBHOOK_EVENT_GROUPS.flatMap((g) => g.events.map((e) => e.value));

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface Webhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
}

interface WebhookLog {
  id: string;
  created_at: string;
  webhook_id: string;
  event: string;
  status_code: number;
  success: boolean;
  response_time_ms: number;
  payload: unknown | null;
  error: string | null;
}

const tabs = ["Endpoints", "Logs"] as const;

export function WebhooksPage({
  initialTab = "endpoints",
}: {
  initialTab?: "endpoints" | "logs";
} = {}) {
  const [activeTab, setActiveTab] = useState(initialTab);

  const switchTab = (tab: typeof initialTab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  const {
    data: webhooks,
    loading: webhooksLoading,
    error: webhooksError,
    hasMore: webhooksHasMore,
    loadMore: webhooksLoadMore,
    loadingMore: webhooksLoadingMore,
    refetch: webhooksRefetch,
  } = usePaginatedApi<Webhook>(
    activeTab === "endpoints" ? "webhooks" : null,
  );

  const {
    data: logs,
    loading: logsLoading,
    hasMore: logsHasMore,
    loadMore: logsLoadMore,
    loadingMore: logsLoadingMore,
  } = usePaginatedApi<WebhookLog>(
    activeTab === "logs" ? "webhooks/logs" : null,
  );

  const createMutation = useMutation<Webhook>("webhooks", "POST");
  const [showCreate, setShowCreate] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(
    new Set(["post.published", "post.failed"])
  );

  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  const isValidUrl = (s: string) => {
    try { return Boolean(new URL(s)); } catch { return false; }
  };

  const handleCreate = async () => {
    if (!newUrl.trim() || !isValidUrl(newUrl.trim())) return;
    const result = await createMutation.mutate({
      url: newUrl.trim(),
      events: Array.from(selectedEvents),
    });
    if (result) {
      setShowCreate(false);
      setNewUrl("");
      webhooksRefetch();
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/webhooks/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) webhooksRefetch();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Webhooks</h1>
          <a href="https://docs.relayapi.dev/api-reference/webhooks" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
        </div>
        {activeTab === "endpoints" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setShowCreate(true)}>
            <Plus className="size-3.5" />
            Add Webhook
          </Button>
        )}
      </div>

      <div className="flex gap-4 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {tabs.map((tab) => {
          const tabKey = tab.toLowerCase() as typeof initialTab;
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

      {webhooksError && activeTab === "endpoints" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {webhooksError}
        </div>
      )}

      {/* Endpoints tab */}
      {activeTab === "endpoints" && (
        <>
          {showCreate && (
            <motion.div
              className="rounded-md border border-border p-4 space-y-3"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Webhook URL</label>
                <input
                  type="url"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="https://example.com/webhook"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring font-mono"
                  autoFocus
                />
              </div>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Events</label>
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() =>
                      setSelectedEvents((prev) =>
                        prev.size === ALL_EVENTS.length ? new Set() : new Set(ALL_EVENTS)
                      )
                    }
                  >
                    {selectedEvents.size === ALL_EVENTS.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="rounded-md border border-border bg-background p-3 space-y-3">
                  {WEBHOOK_EVENT_GROUPS.map((group) => (
                    <div key={group.label} className="space-y-1.5">
                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                        {group.label}
                      </p>
                      <div className="space-y-1">
                        {group.events.map((event) => (
                          <label
                            key={event.value}
                            className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/30 transition-colors cursor-pointer"
                          >
                            <Checkbox
                              checked={selectedEvents.has(event.value)}
                              onCheckedChange={(checked) =>
                                setSelectedEvents((prev) => {
                                  const next = new Set(prev);
                                  checked ? next.add(event.value) : next.delete(event.value);
                                  return next;
                                })
                              }
                            />
                            <code className="text-xs font-mono">{event.value}</code>
                            <span className="text-[11px] text-muted-foreground">{event.description}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!newUrl.trim() || !isValidUrl(newUrl.trim()) || selectedEvents.size === 0 || createMutation.loading}
                  onClick={handleCreate}
                >
                  {createMutation.loading ? <Loader2 className="size-3 animate-spin" /> : "Create"}
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
              </div>
              {createMutation.error && (
                <p className="text-xs text-destructive">{createMutation.error}</p>
              )}
            </motion.div>
          )}

          {webhooksLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : webhooks.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <Zap className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No webhooks configured</p>
              <p className="text-xs text-muted-foreground mt-1">
                Add a webhook to receive event notifications
              </p>
            </div>
          ) : (
            <>
              <motion.div
                className="space-y-3"
                variants={stagger}
                initial={false}
                animate="visible"
              >
                {webhooks.map((webhook) => (
                  <motion.div
                    key={webhook.id}
                    variants={fadeUp}
                    className="rounded-md border border-border p-4 hover:bg-accent/20 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            "rounded-md p-1.5 mt-0.5",
                            webhook.enabled
                              ? "bg-emerald-400/10 text-emerald-400"
                              : "bg-neutral-400/10 text-neutral-400"
                          )}
                        >
                          <Zap className="size-4" />
                        </div>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <code className="text-sm font-mono font-medium">
                              {webhook.url}
                            </code>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {webhook.id} &middot; Created{" "}
                            {new Date(webhook.created_at).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })}
                          </p>
                        </div>
                      </div>
                      <button
                        className="rounded-lg p-1.5 hover:bg-red-500/10 transition-colors shrink-0"
                        onClick={() => handleDelete(webhook.id)}
                        title="Delete webhook"
                      >
                        <Trash2 className="size-4 text-muted-foreground hover:text-red-400" />
                      </button>
                    </div>
                    <div className="flex items-center justify-between mt-4 pl-11">
                      <div className="flex flex-wrap gap-1.5">
                        {(webhook.events || []).map((event) => (
                          <span
                            key={event}
                            className="inline-flex rounded-md bg-accent/50 px-2 py-0.5 text-[11px] font-mono text-muted-foreground"
                          >
                            {event}
                          </span>
                        ))}
                      </div>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium shrink-0",
                          webhook.enabled
                            ? "text-emerald-400 bg-emerald-400/10"
                            : "text-neutral-400 bg-neutral-400/10"
                        )}
                      >
                        <span
                          className={cn(
                            "size-1.5 rounded-full",
                            webhook.enabled ? "bg-emerald-400" : "bg-neutral-400"
                          )}
                        />
                        {webhook.enabled ? "active" : "inactive"}
                      </span>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
              <LoadMore
                hasMore={webhooksHasMore}
                loading={webhooksLoadingMore}
                onLoadMore={webhooksLoadMore}
                count={webhooks.length}
              />
            </>
          )}
        </>
      )}

      {/* Logs tab */}
      {activeTab === "logs" && (
        logsLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : logs.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-12 text-center">
            <FileText className="size-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No webhook delivery logs</p>
            <p className="text-xs text-muted-foreground mt-1">
              Delivery attempts will appear here when events are sent
            </p>
          </div>
        ) : (
          <>
            <motion.div
              className="rounded-md border border-border overflow-hidden"
              variants={stagger}
              initial={false}
              animate="visible"
            >
              <div className="hidden md:grid grid-cols-[1.5fr_1fr_0.8fr_0.8fr_1fr] gap-4 px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border bg-accent/10">
                <span>Webhook</span>
                <span>Event</span>
                <span>Status</span>
                <span>Response</span>
                <span>Time</span>
              </div>
              {logs.map((log, i) => (
                <motion.div
                  key={log.id}
                  variants={fadeUp}
                  className={cn(
                    i !== logs.length - 1 && "border-b border-border"
                  )}
                >
                  <div
                    className="grid md:grid-cols-[1.5fr_1fr_0.8fr_0.8fr_1fr] gap-3 md:gap-4 p-4 md:py-3 items-center hover:bg-accent/30 transition-colors cursor-pointer"
                    onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                  >
                    <code className="text-xs font-mono text-muted-foreground truncate">
                      {log.webhook_id}
                    </code>
                    <span className="inline-flex rounded-md bg-accent/50 px-2 py-0.5 text-[11px] font-mono text-muted-foreground w-fit">
                      {log.event}
                    </span>
                    <span
                      className={cn(
                        "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                        log.success
                          ? "text-emerald-400 bg-emerald-400/10"
                          : "text-red-400 bg-red-400/10"
                      )}
                    >
                      {log.status_code}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {log.response_time_ms}ms
                    </span>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        {new Date(log.created_at).toLocaleString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <ChevronDown className={cn(
                        "size-3.5 text-muted-foreground transition-transform",
                        expandedLog === log.id && "rotate-180"
                      )} />
                    </div>
                  </div>
                  {expandedLog === log.id && (
                    <div className="px-4 pb-4 space-y-2">
                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Request Body</p>
                      <pre className="text-xs font-mono bg-accent/30 rounded-md p-3 overflow-x-auto max-h-64 text-foreground/80">
                        {log.payload ? JSON.stringify(log.payload, null, 2) : "No payload recorded"}
                      </pre>
                      {log.error && (
                        <>
                          <p className="text-[11px] font-medium text-red-400 uppercase tracking-wider mt-2">Error</p>
                          <pre className="text-xs font-mono bg-red-400/10 text-red-400 rounded-md p-3 overflow-x-auto">{log.error}</pre>
                        </>
                      )}
                    </div>
                  )}
                </motion.div>
              ))}
            </motion.div>
            <LoadMore
              hasMore={logsHasMore}
              loading={logsLoadingMore}
              onLoadMore={logsLoadMore}
              count={logs.length}
            />
          </>
        )
      )}
    </div>
  );
}
