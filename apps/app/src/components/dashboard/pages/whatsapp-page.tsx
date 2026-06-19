import { useState, useCallback } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { motion } from "motion/react";
import {
  Loader2,
  MessageCircle,
  Send,
  FileText,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";
import { PageHeader } from "@/components/dashboard/page-header";
import { PageToolbar } from "@/components/dashboard/page-toolbar";
import { Segmented } from "@/components/dashboard/segmented";
import { WorkspaceFilterButton } from "@/components/dashboard/workspace-filter-button";
import { AccountFilterButton } from "@/components/dashboard/account-filter-button";
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
  sent: "text-success bg-success/10",
  pending: "text-muted-foreground bg-muted",
  draft: "text-muted-foreground bg-muted",
  failed: "text-destructive bg-destructive/10",
  approved: "text-success bg-success/10",
  rejected: "text-destructive bg-destructive/10",
  submitted: "text-muted-foreground bg-muted",
};

export function WhatsAppPage({
  initialTab = "broadcasts",
}: {
  initialTab?: "broadcasts" | "templates" | "groups" | "settings";
} = {}) {
  const filterQuery = useFilterQuery();
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
    <div className="space-y-6 pb-16">
      <PageHeader
        title="WhatsApp"
        docsHref="https://docs.relayapi.dev/api-reference/whatsapp"
        action={
          activeTab === "broadcasts" ? (
            <Button>
              <Send className="size-4" />
              New Broadcast
            </Button>
          ) : undefined
        }
      />

      <PageToolbar
        left={
          <Segmented
            value={activeTab}
            onChange={(v) => switchTab(v)}
            options={tabs.map((tab) => ({
              value: tab.toLowerCase() as typeof initialTab,
              label: tab,
            }))}
          />
        }
        right={
          <>
            <WorkspaceFilterButton />
            <AccountFilterButton />
          </>
        }
      />

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
          <div className="rounded-[12px] border border-dashed border-border p-12 text-center">
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
                  className="rounded-[12px] border border-border bg-card p-5 hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">{bc.name}</h3>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                        statusColors[bc.status] || "text-muted-foreground bg-muted"
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
          <div className="rounded-[12px] border border-dashed border-border p-12 text-center">
            <FileText className="size-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No templates</p>
            <p className="text-xs text-muted-foreground mt-1">
              Create message templates approved by WhatsApp for broadcast messaging
            </p>
          </div>
        ) : (
          <>
            <motion.div
              className="rounded-[12px] border border-border bg-card overflow-hidden"
              variants={stagger}
              initial="hidden"
              animate="visible"
            >
              <div className="hidden md:grid grid-cols-[1.5fr_1fr_0.8fr_1fr_1fr] gap-4 px-4 py-2.5 text-xs text-muted-foreground border-b border-border bg-muted">
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
                    "grid md:grid-cols-[1.5fr_1fr_0.8fr_1fr_1fr] gap-3 md:gap-4 p-4 md:py-3 items-center text-[13px] hover:bg-accent/30 transition-colors",
                    i !== templates.length - 1 && "border-b border-border"
                  )}
                >
                  <span className="font-medium">{tpl.name}</span>
                  <span className="text-xs text-muted-foreground capitalize">{tpl.category}</span>
                  <span className="text-xs text-muted-foreground">{tpl.language}</span>
                  <span
                    className={cn(
                      "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                      statusColors[tpl.status] || "text-muted-foreground bg-muted"
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
          <div className="rounded-[12px] border border-dashed border-border p-12 text-center">
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
                  className="rounded-[12px] border border-border bg-card p-5 hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="rounded-md bg-success/10 p-1.5">
                        <MessageCircle className="size-4 text-success" />
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
        <div className="rounded-[12px] border border-dashed border-border p-12 text-center">
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
