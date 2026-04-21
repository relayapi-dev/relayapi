import { useState } from "react";
import { motion } from "motion/react";
import { Plus, Loader2, MoreHorizontal, Link2Off, Link2, Activity, FileText, FolderOpen, Trash2, ArrowRightLeft, Search, BookOpen, CheckCircle2, XCircle, Clock, Shield, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { usePaginatedApi, useMutation } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";
import { platformColors, platformLabels, platformAvatars, platformConnectionType } from "@/lib/platform-maps";
import { PlatformGrid } from "@/components/dashboard/connect/platform-grid";
import { WorkspaceSearchCombobox } from "@/components/dashboard/workspace-search-combobox";
import { useFilter } from "@/components/dashboard/filter-context";
import { AccountHealthDialog } from "@/components/dashboard/account-health-dialog";
import { hasPostingCapability, hasAnalyticsCapability, getExpectedScopes } from "@/lib/platform-scopes";
import type { InitialPaginatedData } from "@/lib/dashboard-page";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface Workspace {
  id: string;
  name: string;
}

interface Account {
  id: string;
  platform: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  workspace: Workspace | null;
  connected_at: string;
  updated_at: string;
}

interface WorkspaceItem {
  id: string;
  name: string;
  description: string | null;
  account_count: number;
  created_at: string;
}

interface HealthItem {
  id: string;
  platform: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  healthy: boolean;
  token_expires_at: string | null;
  scopes: string[];
  workspace: { id: string; name: string } | null;
  error?: { code: string; message: string };
}

interface LogEntry {
  id: string;
  account_id: string | null;
  platform: string;
  event: "connected" | "disconnected" | "token_refreshed" | "error";
  message: string | null;
  created_at: string;
}

const tabs = ["Accounts", "Connect", "Workspaces", "Health", "Logs"] as const;

const eventStyles: Record<string, string> = {
  connected: "text-emerald-400",
  disconnected: "text-amber-400",
  token_refreshed: "text-blue-400",
  error: "text-red-400",
};
const eventBg: Record<string, string> = {
  connected: "bg-emerald-400/10",
  disconnected: "bg-amber-400/10",
  token_refreshed: "bg-blue-400/10",
  error: "bg-red-400/10",
};

export interface ConnectionsPageProps {
  initialAccountsData?: InitialPaginatedData<Account>;
  initialHealthData?: InitialPaginatedData<HealthItem>;
  initialLogsData?: InitialPaginatedData<LogEntry>;
  initialTab?: "accounts" | "connect" | "workspaces" | "health" | "logs";
  initialWorkspacesData?: InitialPaginatedData<WorkspaceItem>;
}

export function ConnectionsPage({
  initialAccountsData,
  initialHealthData,
  initialLogsData,
  initialTab = "accounts",
  initialWorkspacesData,
}: ConnectionsPageProps = {}) {
  const [activeTab, setActiveTab] = useState(initialTab);

  // Use shared filter context for workspace/account filtering
  const { workspaceId: workspaceFilterId, setWorkspaceId: setWorkspaceFilterId } = useFilter();

  // Health check state
  const [healthTarget, setHealthTarget] = useState<Account | null>(null);

  // Disconnect state
  const [disconnectTarget, setDisconnectTarget] = useState<Account | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  // Move to workspace state
  const [moveTarget, setMoveTarget] = useState<Account | null>(null);
  const [moveWorkspaceId, setMoveWorkspaceId] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Workspaces tab state
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceDescription, setNewWorkspaceDescription] = useState("");
  const [workspacesSearch, setWorkspacesSearch] = useState("");
  const [workspacesSearchKey, setWorkspacesSearchKey] = useState(0);

  const switchTab = (tab: typeof initialTab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  // Build query params for accounts based on workspace filter
  const accountsQuery: Record<string, string | undefined> = {};
  if (workspaceFilterId === "__ungrouped") {
    accountsQuery.ungrouped = "true";
  } else if (workspaceFilterId) {
    accountsQuery.workspace_id = workspaceFilterId;
  }

  const {
    data: accounts,
    loading: accountsLoading,
    error: accountsError,
    hasMore: accountsHasMore,
    loadMore: accountsLoadMore,
    loadingMore: accountsLoadingMore,
    refetch: accountsRefetch,
    setData: setAccounts,
  } = usePaginatedApi<Account>(
    activeTab === "accounts" ? "accounts" : null,
    {
      initialCursor: initialAccountsData?.nextCursor,
      initialData: initialAccountsData?.data,
      initialHasMore: initialAccountsData?.hasMore,
      initialRequestKey: initialAccountsData?.requestKey,
      query: accountsQuery,
    },
  );

  const {
    data: healthItems,
    loading: healthLoading,
    hasMore: healthHasMore,
    loadMore: healthLoadMore,
    loadingMore: healthLoadingMore,
  } = usePaginatedApi<HealthItem>(
    activeTab === "health" ? "accounts/health" : null,
    {
      initialCursor: initialHealthData?.nextCursor,
      initialData: initialHealthData?.data,
      initialHasMore: initialHealthData?.hasMore,
      initialRequestKey: initialHealthData?.requestKey,
    },
  );

  // Health dialog state
  const [healthDialogAccount, setHealthDialogAccount] = useState<{ id: string; platform: string; username: string | null; display_name: string | null; avatar_url: string | null } | null>(null);

  const {
    data: logs,
    loading: logsLoading,
    hasMore: logsHasMore,
    loadMore: logsLoadMore,
    loadingMore: logsLoadingMore,
  } = usePaginatedApi<LogEntry>(
    activeTab === "logs" ? "connections/logs" : null,
    {
      initialCursor: initialLogsData?.nextCursor,
      initialData: initialLogsData?.data,
      initialHasMore: initialLogsData?.hasMore,
      initialRequestKey: initialLogsData?.requestKey,
    },
  );

  const workspacesQuery: Record<string, string | undefined> = {};
  if (workspacesSearch) workspacesQuery.search = workspacesSearch;

  const {
    data: groups,
    loading: groupsLoading,
    error: groupsError,
    hasMore: groupsHasMore,
    loadMore: groupsLoadMore,
    loadingMore: groupsLoadingMore,
    refetch: groupsRefetch,
    setData: setGroups,
  } = usePaginatedApi<WorkspaceItem>(
    activeTab === "workspaces" ? "workspaces" : null,
    {
      initialCursor: initialWorkspacesData?.nextCursor,
      initialData: initialWorkspacesData?.data,
      initialHasMore: initialWorkspacesData?.hasMore,
      initialRequestKey: initialWorkspacesData?.requestKey,
      query: workspacesQuery,
    },
  );

  const createWorkspaceMutation = useMutation<WorkspaceItem>("workspaces", "POST");

  const handleWorkspaceFilterChange = (id: string | null) => {
    setWorkspaceFilterId(id);
  };

  const handleDisconnect = async () => {
    if (!disconnectTarget) return;
    setDisconnecting(true);
    const res = await fetch(`/api/accounts/${disconnectTarget.id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) {
      setAccounts((prev) => prev.filter((a) => a.id !== disconnectTarget.id));
    }
    setDisconnecting(false);
    setDisconnectTarget(null);
  };

  const handleMoveToWorkspace = async () => {
    if (!moveTarget) return;
    setMoving(true);
    setMoveError(null);
    const workspaceId = moveWorkspaceId === "__ungrouped" ? null : moveWorkspaceId;
    try {
      const res = await fetch(`/api/accounts/${moveTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setMoveError(err?.error?.message || err?.message || `Error ${res.status}`);
        return;
      }

      accountsRefetch();
      groupsRefetch();
      setMoveTarget(null);
      setMoveWorkspaceId(null);
    } catch {
      setMoveError("Network connection lost.");
    } finally {
      setMoving(false);
    }
  };

  const handleCreateWorkspace = async () => {
    if (!newWorkspaceName.trim()) return;
    const result = await createWorkspaceMutation.mutate({
      name: newWorkspaceName.trim(),
      description: newWorkspaceDescription.trim() || undefined,
    });
    if (result) {
      setShowCreateWorkspace(false);
      setNewWorkspaceName("");
      setNewWorkspaceDescription("");
      groupsRefetch();
    }
  };

  const handleDeleteWorkspace = async (id: string) => {
    const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) {
      setGroups((prev) => prev.filter((g) => g.id !== id));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Connections</h1>
          <a href="https://docs.relayapi.dev/guides/connecting-accounts" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
        </div>
        {activeTab === "workspaces" ? (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setShowCreateWorkspace(true)}>
            <Plus className="size-3.5" />
            Create Workspace
          </Button>
        ) : activeTab !== "connect" ? (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => switchTab("connect")}>
            <Plus className="size-3.5" />
            Connect Account
          </Button>
        ) : null}
      </div>

      <div className="flex items-end justify-between gap-x-4 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        <div className="flex gap-4">
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
        <div className="pb-2 shrink-0">
          <WorkspaceSearchCombobox
            value={workspaceFilterId}
            onSelect={setWorkspaceFilterId}
            showAllOption
            showUnassignedOption
            placeholder="All workspaces"
            align="right"
          />
        </div>
      </div>

      {accountsError && activeTab === "accounts" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {accountsError}
        </div>
      )}

      {/* Accounts tab */}
      {activeTab === "accounts" && (
        accountsLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {accounts.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-12 text-center">
                <FolderOpen className="size-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">
                  {workspaceFilterId ? "No accounts in this workspace" : "No connected accounts"}
                </p>
                {!workspaceFilterId && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Connect your first social media account to get started
                  </p>
                )}
              </div>
            ) : (
              <motion.div
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                variants={stagger}
                initial="hidden"
                animate="visible"
                key={workspaceFilterId || "all"}
              >
                {accounts.map((acc) => {
                  const platform = acc.platform?.toLowerCase() || "";
                  const title = acc.display_name || acc.username || platformLabels[platform] || acc.platform;
                  const showUsername = acc.display_name && acc.username && acc.display_name !== acc.username;
                  return (
                    <motion.div
                      key={acc.id}
                      variants={fadeUp}
                      className="group rounded-md border border-border p-4 hover:bg-accent/20 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="relative">
                          {acc.avatar_url ? (
                            <img
                              src={acc.avatar_url}
                              alt=""
                              className="size-9 rounded-md object-cover"
                              onError={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = "none";
                                const fallback = (e.currentTarget as HTMLImageElement).nextElementSibling;
                                if (fallback) fallback.classList.remove("hidden");
                              }}
                            />
                          ) : null}
                          <div
                            className={cn(
                              "flex size-9 items-center justify-center rounded-md text-xs font-bold text-white",
                              platformColors[platform] || "bg-neutral-700",
                              acc.avatar_url ? "hidden" : ""
                            )}
                          >
                            {platformAvatars[platform] || platform.slice(0, 2).toUpperCase()}
                          </div>
                          {acc.avatar_url && (
                            <div
                              className={cn(
                                "absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full border-2 border-background text-[7px] font-bold text-white",
                                platformColors[platform] || "bg-neutral-700"
                              )}
                            >
                              {platformAvatars[platform]?.slice(0, 1) || platform.slice(0, 1).toUpperCase()}
                            </div>
                          )}
                        </div>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button className="rounded-lg p-1.5 opacity-0 group-hover:opacity-100 hover:bg-accent/50 transition-all">
                              <MoreHorizontal className="size-4 text-muted-foreground" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            {(["instagram", "facebook", "whatsapp", "telegram", "tiktok"].includes(platform)) && (
                              <DropdownMenuItem onClick={() => { window.location.href = `/app/connections/${acc.id}?tab=default-reply`; }}>
                                <Link2 className="size-3.5 mr-2" />
                                Manage bindings
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => setHealthTarget(acc)}>
                              <Activity className="size-3.5 mr-2" />
                              Check health
                            </DropdownMenuItem>
                            {(() => {
                              const connType = platformConnectionType[platform];
                              if (connType === "oauth" || connType === "dialog") {
                                const reconnectUrl = platform === "instagram"
                                  ? "/app/connect/start/instagram?method=direct"
                                  : `/app/connect/start/${platform}`;
                                return (
                                  <DropdownMenuItem onClick={() => { window.location.href = reconnectUrl; }}>
                                    <RefreshCw className="size-3.5 mr-2" />
                                    Reconnect
                                  </DropdownMenuItem>
                                );
                              }
                              return null;
                            })()}
                            <DropdownMenuItem
                              onClick={() => {
                                setMoveError(null);
                                setMoveTarget(acc);
                                setMoveWorkspaceId(acc.workspace?.id || null);
                              }}
                            >
                              <ArrowRightLeft className="size-3.5 mr-2" />
                              Move to workspace
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => setDisconnectTarget(acc)}
                            >
                              <Link2Off className="size-3.5 mr-2" />
                              Disconnect
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      <div className="mt-3">
                        <h3 className="text-sm font-medium truncate">{title}</h3>
                        {showUsername && (
                          <p className="text-xs text-muted-foreground truncate">
                            {acc.username!.startsWith("@") ? acc.username : `@${acc.username}`}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {platformLabels[platform] || acc.platform}
                        </p>
                      </div>

                      <div className="mt-3 flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <div className="size-1.5 rounded-full bg-emerald-500" />
                          <span className="text-xs text-muted-foreground">Active</span>
                        </div>
                        {acc.workspace && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary truncate max-w-[100px]">
                            {acc.workspace.name}
                          </span>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </motion.div>
            )}
            <LoadMore
              hasMore={accountsHasMore}
              loading={accountsLoadingMore}
              onLoadMore={accountsLoadMore}
              count={accounts.length}
            />
          </>
        )
      )}

      {/* Connect tab */}
      {activeTab === "connect" && (
        <PlatformGrid onConnected={accountsRefetch} />
      )}

      {/* Workspaces tab */}
      {activeTab === "workspaces" && (
        <div className="space-y-4">
          {groupsError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {groupsError}
            </div>
          )}

          {showCreateWorkspace && (
            <motion.div
              className="rounded-md border border-border p-4 space-y-3"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Workspace name</label>
                <input
                  type="text"
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  placeholder="e.g. Client A"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && handleCreateWorkspace()}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
                <input
                  type="text"
                  value={newWorkspaceDescription}
                  onChange={(e) => setNewWorkspaceDescription(e.target.value)}
                  placeholder="Describe this workspace..."
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!newWorkspaceName.trim() || createWorkspaceMutation.loading}
                  onClick={handleCreateWorkspace}
                >
                  {createWorkspaceMutation.loading ? <Loader2 className="size-3 animate-spin" /> : "Create"}
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowCreateWorkspace(false)}>
                  Cancel
                </Button>
              </div>
              {createWorkspaceMutation.error && (
                <p className="text-xs text-destructive">{createWorkspaceMutation.error}</p>
              )}
            </motion.div>
          )}

          {/* Workspaces search */}
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 w-52">
            <Search className="size-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              value={workspacesSearch}
              onChange={(e) => setWorkspacesSearch(e.target.value)}
              placeholder="Search workspaces..."
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>

          {groupsLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : groups.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <FolderOpen className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {workspacesSearch ? "No workspaces found" : "No workspaces"}
              </p>
              {!workspacesSearch && (
                <p className="text-xs text-muted-foreground mt-1">
                  Organize your connected accounts by client or campaign
                </p>
              )}
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
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="rounded-md bg-primary/10 p-1.5 mt-0.5">
                          <FolderOpen className="size-4 text-primary" />
                        </div>
                        <div>
                          <h3 className="text-sm font-medium">{group.name}</h3>
                          {group.description && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {group.description}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            {group.account_count} account{group.account_count !== 1 ? "s" : ""}
                            {" "}&middot; Created{" "}
                            {new Date(group.created_at).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })}
                          </p>
                        </div>
                      </div>
                      <button
                        className="rounded-lg p-1.5 hover:bg-red-500/10 transition-colors"
                        onClick={() => handleDeleteWorkspace(group.id)}
                        title="Delete workspace"
                      >
                        <Trash2 className="size-4 text-muted-foreground hover:text-red-400" />
                      </button>
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
          )}
        </div>
      )}

      {/* Health tab */}
      {activeTab === "health" && (
        healthLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : healthItems.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-12 text-center">
            <Activity className="size-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No accounts to monitor</p>
          </div>
        ) : (
          <>
            <motion.div
              className="rounded-md border border-border overflow-hidden"
              variants={stagger}
              initial="hidden"
              animate="visible"
            >
              <div className="hidden md:grid grid-cols-[1.5fr_0.8fr_0.8fr_0.7fr_1fr_0.8fr] gap-4 px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border bg-accent/10">
                <span>Account</span>
                <span>Platform</span>
                <span>Status</span>
                <span>Token</span>
                <span>Permissions</span>
                <span>Workspace</span>
              </div>
              {healthItems.map((item, i) => {
                const platform = item.platform?.toLowerCase() || "";
                const expiresAt = item.token_expires_at ? new Date(item.token_expires_at) : null;
                const now = new Date();
                const daysUntilExpiry = expiresAt
                  ? Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
                  : null;
                const isExpired = daysUntilExpiry !== null && daysUntilExpiry <= 0;
                const isExpiringSoon = daysUntilExpiry !== null && daysUntilExpiry > 0 && daysUntilExpiry <= 7;
                const canPost = hasPostingCapability(platform, item.scopes);
                const canAnalytics = hasAnalyticsCapability(platform, item.scopes);
                const expectedScopes = getExpectedScopes(platform);
                const hasAnalyticsScopes = expectedScopes.analytics.length > 0;

                return (
                  <motion.div
                    key={item.id}
                    variants={fadeUp}
                    onClick={() => setHealthDialogAccount({
                      id: item.id,
                      platform: item.platform,
                      username: item.username,
                      display_name: item.display_name,
                      avatar_url: item.avatar_url,
                    })}
                    className={cn(
                      "grid md:grid-cols-[1.5fr_0.8fr_0.8fr_0.7fr_1fr_0.8fr] gap-3 md:gap-4 p-4 md:py-3 items-center cursor-pointer hover:bg-accent/30 transition-colors",
                      i !== healthItems.length - 1 && "border-b border-border",
                      !item.healthy && "bg-destructive/[0.03]"
                    )}
                  >
                    {/* Account */}
                    <div className="flex items-center gap-2.5">
                      {item.avatar_url ? (
                        <img src={item.avatar_url} alt="" className="size-6 rounded-full object-cover shrink-0" />
                      ) : (
                        <div
                          className={cn(
                            "flex size-6 items-center justify-center rounded-full text-[9px] font-bold text-white shrink-0",
                            platformColors[platform] || "bg-neutral-700"
                          )}
                        >
                          {platformAvatars[platform]?.slice(0, 1) || platform.slice(0, 1).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0">
                        <span className="text-sm font-medium truncate block">
                          {item.display_name || item.username || "Unknown"}
                        </span>
                        {item.username && item.username !== (item.display_name || "") && (
                          <span className="text-[11px] text-muted-foreground truncate block">
                            @{item.username.replace(/^@/, "")}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Platform */}
                    <span className="text-xs text-muted-foreground">
                      {platformLabels[platform] || item.platform}
                    </span>

                    {/* Status */}
                    <div>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                          item.healthy
                            ? "bg-emerald-500/10 text-emerald-600"
                            : "bg-destructive/10 text-destructive"
                        )}
                      >
                        {item.healthy ? (
                          <CheckCircle2 className="size-3" />
                        ) : (
                          <XCircle className="size-3" />
                        )}
                        {item.healthy ? "Healthy" : "Unhealthy"}
                      </span>
                    </div>

                    {/* Token expiry */}
                    <div className="text-xs">
                      {expiresAt === null ? (
                        <span className="text-muted-foreground">Never expires</span>
                      ) : isExpired ? (
                        <span className="text-destructive font-medium">Expired</span>
                      ) : isExpiringSoon ? (
                        <span className="text-amber-600 font-medium">{daysUntilExpiry}d left</span>
                      ) : (
                        <span className="text-muted-foreground">{daysUntilExpiry}d left</span>
                      )}
                    </div>

                    {/* Permissions */}
                    <div className="flex gap-1.5 flex-wrap">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                          canPost ? "bg-emerald-500/10 text-emerald-600" : "bg-destructive/10 text-destructive"
                        )}
                      >
                        {canPost ? <CheckCircle2 className="size-2.5" /> : <XCircle className="size-2.5" />}
                        Post
                      </span>
                      {hasAnalyticsScopes && (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                            canAnalytics ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"
                          )}
                        >
                          {canAnalytics ? <CheckCircle2 className="size-2.5" /> : <XCircle className="size-2.5" />}
                          Analytics
                        </span>
                      )}
                    </div>

                    {/* Workspace */}
                    <span className="text-xs text-muted-foreground truncate">
                      {item.workspace?.name || "—"}
                    </span>
                  </motion.div>
                );
              })}
            </motion.div>
            <LoadMore
              hasMore={healthHasMore}
              loading={healthLoadingMore}
              onLoadMore={healthLoadMore}
              count={healthItems.length}
            />
            <AccountHealthDialog
              account={healthDialogAccount}
              onOpenChange={(open) => { if (!open) setHealthDialogAccount(null); }}
            />
          </>
        )
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
            <p className="text-sm text-muted-foreground">No connection logs</p>
            <p className="text-xs text-muted-foreground mt-1">
              Logs will appear here as accounts connect and sync
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-md border border-border overflow-hidden font-mono text-xs">
              <motion.div
                className="divide-y divide-border"
                variants={stagger}
                initial="hidden"
                animate="visible"
              >
                {logs.map((log) => {
                  const time = log.created_at
                    ? new Date(log.created_at).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                      })
                    : "";
                  const event = log.event || "connected";
                  const platform = log.platform as keyof typeof platformLabels;
                  return (
                    <motion.div
                      key={log.id}
                      variants={fadeUp}
                      className="flex items-start gap-3 px-4 py-2.5 hover:bg-accent/30 transition-colors"
                    >
                      <span className="text-muted-foreground shrink-0 w-32 tabular-nums">{time}</span>
                      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase whitespace-nowrap", eventStyles[event] || "text-blue-400", eventBg[event] || "bg-blue-400/10")}>
                        {event.replace("_", " ")}
                      </span>
                      <span className="shrink-0 text-muted-foreground text-[10px] uppercase w-20 truncate">
                        {platformLabels[platform] || log.platform}
                      </span>
                      <span className="text-foreground/80 break-all">{log.message}</span>
                    </motion.div>
                  );
                })}
              </motion.div>
            </div>
            <LoadMore
              hasMore={logsHasMore}
              loading={logsLoadingMore}
              onLoadMore={logsLoadMore}
              count={logs.length}
            />
          </>
        )
      )}

      {/* Disconnect confirmation dialog */}
      <Dialog open={!!disconnectTarget} onOpenChange={(open) => !open && setDisconnectTarget(null)}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Disconnect account</DialogTitle>
            <DialogDescription>
              Are you sure you want to disconnect{" "}
              <span className="font-medium text-foreground">
                {disconnectTarget?.display_name || disconnectTarget?.username || "this account"}
              </span>
              ? This will remove the connection and any stored credentials.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={disconnecting}
              onClick={handleDisconnect}
            >
              {disconnecting ? <Loader2 className="size-3.5 animate-spin" /> : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move to workspace dialog */}
      <Dialog
        open={!!moveTarget}
        onOpenChange={(open) => {
          if (!open) {
            setMoveTarget(null);
            setMoveWorkspaceId(null);
            setMoveError(null);
          }
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Move to workspace</DialogTitle>
            <DialogDescription>
              Choose a workspace for{" "}
              <span className="font-medium text-foreground">
                {moveTarget?.display_name || moveTarget?.username || "this account"}
              </span>
            </DialogDescription>
          </DialogHeader>
          <WorkspaceSearchCombobox
            value={moveWorkspaceId}
            onSelect={(id) => setMoveWorkspaceId(id)}
            allowCreate
            showUnassignedOption
            placeholder="Search workspaces..."
          />
          {moveError && (
            <p className="text-sm text-destructive">{moveError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              size="sm"
              disabled={moving}
              onClick={handleMoveToWorkspace}
            >
              {moving ? <Loader2 className="size-3.5 animate-spin" /> : "Move"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Health check dialog */}
      <AccountHealthDialog
        account={healthTarget}
        onOpenChange={(open) => !open && setHealthTarget(null)}
      />
    </div>
  );
}
