import { useState, useCallback } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { motion } from "motion/react";
import {
  Loader2,
  MessageCircle,
  Send,
  FileText,
  Settings,
  BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { useFilterQuery } from "@/components/dashboard/filter-context";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface WaBroadcast {
  id: string;
  name: string;
  status: string;
  recipients: number;
  sent: number;
  delivered: number;
  created_at: string;
}

interface WaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  created_at: string;
}

interface WaGroup {
  id: string;
  name: string;
  member_count: number;
  created_at: string;
}

const tabs = ["Broadcasts", "Templates", "Groups", "Settings"] as const;

const statusColors: Record<string, string> = {
  sent: "text-emerald-400 bg-emerald-400/10",
  pending: "text-blue-400 bg-blue-400/10",
  draft: "text-amber-400 bg-amber-400/10",
  failed: "text-red-400 bg-red-400/10",
  approved: "text-emerald-400 bg-emerald-400/10",
  rejected: "text-red-400 bg-red-400/10",
  submitted: "text-blue-400 bg-blue-400/10",
};

export function WhatsAppPage({
  initialTab = "broadcasts",
}: {
  initialTab?: "broadcasts" | "templates" | "groups" | "settings";
} = {}) {
  const filterQuery = useFilterQuery();
  const [activeTab, setActiveTab] = useState(initialTab);

  const switchTab = (tab: string) => {
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
  } = usePaginatedApi<WaBroadcast>(
    activeTab === "broadcasts" ? "whatsapp/broadcasts" : null,
    { query: filterQuery },
  );

  // Real-time: broadcast status transitions
  useRealtimeUpdates(useCallback((event) => {
    if (event.type === "broadcast.updated") broadcastsRefetch();
  }, [broadcastsRefetch]));

  const {
    data: templates,
    loading: templatesLoading,
    error: templatesError,
    hasMore: templatesHasMore,
    loadMore: templatesLoadMore,
    loadingMore: templatesLoadingMore,
  } = usePaginatedApi<WaTemplate>(
    activeTab === "templates" ? "whatsapp/templates" : null,
    { query: filterQuery },
  );

  const {
    data: groups,
    loading: groupsLoading,
    error: groupsError,
    hasMore: groupsHasMore,
    loadMore: groupsLoadMore,
    loadingMore: groupsLoadingMore,
  } = usePaginatedApi<WaGroup>(
    activeTab === "groups" ? "whatsapp/groups" : null,
    { query: filterQuery },
  );

  const activeError = broadcastsError || templatesError || groupsError;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">WhatsApp</h1>
          <a href="https://docs.relayapi.dev/api-reference/whatsapp" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
        </div>
        {activeTab === "broadcasts" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs">
            <Send className="size-3.5" />
            New Broadcast
          </Button>
        )}
      </div>

      <div className="flex items-end justify-between gap-x-4 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        <div className="flex gap-4 shrink-0">
          {tabs.map((tab) => {
            const tabKey = tab.toLowerCase();
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
        <div className="pb-2 shrink-0">
          <FilterBar />
        </div>
      </div>

      {activeError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {activeError}
        </div>
      )}

      {/* Broadcasts tab */}
      {activeTab === "broadcasts" && (
        broadcastsLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : broadcasts.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-12 text-center">
            <Send className="size-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No broadcasts</p>
            <p className="text-xs text-muted-foreground mt-1">
              Send bulk messages to your WhatsApp contacts
            </p>
          </div>
        ) : (
          <>
            <motion.div
              className="space-y-3"
              variants={stagger}
              initial="hidden"
              animate="visible"
            >
              {broadcasts.map((bc) => (
                <motion.div
                  key={bc.id}
                  variants={fadeUp}
                  className="rounded-md border border-border p-4 hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">{bc.name}</h3>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                        statusColors[bc.status] || "text-blue-400 bg-blue-400/10"
                      )}
                    >
                      {bc.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                    <span>{bc.recipients} recipients</span>
                    <span>{bc.sent} sent</span>
                    <span>{bc.delivered} delivered</span>
                    <span>
                      {new Date(bc.created_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                </motion.div>
              ))}
            </motion.div>
            <LoadMore
              hasMore={broadcastsHasMore}
              loading={broadcastsLoadingMore}
              onLoadMore={broadcastsLoadMore}
              count={broadcasts.length}
            />
          </>
        )
      )}

      {/* Templates tab */}
      {activeTab === "templates" && (
        templatesLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : templates.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-12 text-center">
            <FileText className="size-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No templates</p>
            <p className="text-xs text-muted-foreground mt-1">
              Create message templates approved by WhatsApp for broadcast messaging
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
              <div className="hidden md:grid grid-cols-[1.5fr_1fr_0.8fr_1fr_1fr] gap-4 px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border bg-accent/10">
                <span>Name</span>
                <span>Category</span>
                <span>Language</span>
                <span>Status</span>
                <span>Created</span>
              </div>
              {templates.map((tpl, i) => (
                <motion.div
                  key={tpl.id}
                  variants={fadeUp}
                  className={cn(
                    "grid md:grid-cols-[1.5fr_1fr_0.8fr_1fr_1fr] gap-3 md:gap-4 p-4 md:py-3 items-center hover:bg-accent/30 transition-colors",
                    i !== templates.length - 1 && "border-b border-border"
                  )}
                >
                  <span className="text-sm font-medium">{tpl.name}</span>
                  <span className="text-xs text-muted-foreground capitalize">{tpl.category}</span>
                  <span className="text-xs text-muted-foreground">{tpl.language}</span>
                  <span
                    className={cn(
                      "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                      statusColors[tpl.status] || "text-blue-400 bg-blue-400/10"
                    )}
                  >
                    {tpl.status}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(tpl.created_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </motion.div>
              ))}
            </motion.div>
            <LoadMore
              hasMore={templatesHasMore}
              loading={templatesLoadingMore}
              onLoadMore={templatesLoadMore}
              count={templates.length}
            />
          </>
        )
      )}

      {/* Groups tab */}
      {activeTab === "groups" && (
        groupsLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-12 text-center">
            <MessageCircle className="size-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No groups</p>
            <p className="text-xs text-muted-foreground mt-1">
              WhatsApp groups linked to your account will appear here
            </p>
          </div>
        ) : (
          <>
            <motion.div
              className="space-y-3"
              variants={stagger}
              initial="hidden"
              animate="visible"
            >
              {groups.map((group) => (
                <motion.div
                  key={group.id}
                  variants={fadeUp}
                  className="rounded-md border border-border p-4 hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="rounded-md bg-green-600/10 p-1.5">
                        <MessageCircle className="size-4 text-green-500" />
                      </div>
                      <div>
                        <h3 className="text-sm font-medium">{group.name}</h3>
                        <p className="text-xs text-muted-foreground">
                          {group.member_count} member{group.member_count !== 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(group.created_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                </motion.div>
              ))}
            </motion.div>
            <LoadMore
              hasMore={groupsHasMore}
              loading={groupsLoadingMore}
              onLoadMore={groupsLoadMore}
              count={groups.length}
            />
          </>
        )
      )}

      {/* Settings tab */}
      {activeTab === "settings" && (
        <div className="rounded-md border border-dashed border-border p-12 text-center">
          <Settings className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-medium">WhatsApp Settings</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Configure your WhatsApp Business API credentials, webhook URLs, and message templates via the API.
          </p>
        </div>
      )}
    </div>
  );
}
