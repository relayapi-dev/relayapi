import { useState, useEffect, useMemo, useCallback } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import {
  Plus,
  Check,
  Loader2,
  BookOpen,
  List,
  CalendarDays,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { NewPostDialog } from "@/components/dashboard/new-post-dialog";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { platformIcons } from "@/lib/platform-icons";
import { platformColors, platformLabels } from "@/lib/platform-maps";
import { useFilterQuery, useFilter } from "@/components/dashboard/filter-context";
import { CalendarView } from "@/components/dashboard/calendar/calendar-view";
import type { CalendarPeriod } from "@/components/dashboard/calendar/calendar-header";
import { SentPostList } from "@/components/dashboard/pages/posts/sent-post-list";
import { QueuePostList } from "@/components/dashboard/pages/posts/queue-post-list";
import { WorkspaceGuard } from "@/components/dashboard/workspace-guard";
import { flattenPost, type QueuePost } from "@/components/dashboard/pages/posts/queue-post-card";
import type { InitialPaginatedData } from "@/lib/dashboard-page";

interface PostTarget {
  status: string;
  platform: string;
  accounts?: Array<{
    id: string;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    url: string | null;
    platform_post_id: string | null;
  }>;
  error?: { code: string; message: string };
}

interface Post {
  id: string;
  content: string;
  platforms: string[];
  status: "scheduled" | "published" | "draft" | "failed" | "publishing" | "partial";
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  targets?: Record<string, PostTarget>;
  media?: Array<{ url: string; type?: string }> | null;
}

const topTabs = ["All", "Queue", "Drafts", "Published"] as const;

export interface PostsPageProps {
  initialAllData?: InitialPaginatedData<any>;
  initialCalendarPeriod?: CalendarPeriod;
  initialDraftsData?: InitialPaginatedData<Post>;
  initialFailedData?: InitialPaginatedData<Post>;
  initialPublishedData?: InitialPaginatedData<any>;
  initialQueueData?: InitialPaginatedData<Post>;
  initialTab?: "all" | "queue" | "drafts" | "published";
  initialViewMode?: "list" | "calendar";
}

export function PostsPage({
  initialAllData,
  initialCalendarPeriod = "week",
  initialDraftsData,
  initialFailedData,
  initialPublishedData,
  initialQueueData,
  initialTab = "all",
  initialViewMode = "calendar",
}: PostsPageProps = {}) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const [newPostOpen, setNewPostOpen] = useState(false);
  const [newPostInitialDate, setNewPostInitialDate] = useState<string | undefined>();
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editPostData, setEditPostData] = useState<any>(null);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [viewMode, setViewMode] = useState<"list" | "calendar">(initialViewMode);
  const [calendarPeriod, setCalendarPeriod] = useState<CalendarPeriod>(initialCalendarPeriod);

  const switchTab = (tab: string) => {
    setActiveTab(tab);
    localStorage.setItem("posts:activeTab", tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  const filterQuery = useFilterQuery();
  const { accountId } = useFilter();

  // Queue tab: scheduled + failed + publishing posts
  const queueQuery: Record<string, string | undefined> = { ...filterQuery, status: "scheduled", include: "targets,media" };
  const {
    data: queuePosts,
    loading: queueLoading,
    error: queueError,
    hasMore: queueHasMore,
    loadMore: queueLoadMore,
    loadingMore: queueLoadingMore,
    setData: setQueuePosts,
    refetch: refetchQueue,
  } = usePaginatedApi<Post>(
    activeTab === "queue" ? "posts" : null,
    {
      initialCursor: initialQueueData?.nextCursor,
      initialData: initialQueueData?.data,
      initialHasMore: initialQueueData?.hasMore,
      initialRequestKey: initialQueueData?.requestKey,
      query: queueQuery,
    },
  );

  // Also fetch failed posts count for badge
  const { data: failedPosts, refetch: refetchFailed } = usePaginatedApi<Post>(
    activeTab === "queue" ? "posts" : null,
    {
      initialCursor: initialFailedData?.nextCursor,
      initialData: initialFailedData?.data,
      initialHasMore: initialFailedData?.hasMore,
      initialRequestKey: initialFailedData?.requestKey,
      query: { ...filterQuery, status: "failed", include: "targets,media" },
    },
  );

  // Drafts tab: draft posts
  const draftsQuery: Record<string, string | undefined> = { ...filterQuery, status: "draft", include: "targets,media" };
  const {
    data: draftPosts,
    loading: draftsLoading,
    error: draftsError,
    hasMore: draftsHasMore,
    loadMore: draftsLoadMore,
    loadingMore: draftsLoadingMore,
    setData: setDraftPosts,
    refetch: refetchDrafts,
  } = usePaginatedApi<Post>(
    activeTab === "drafts" ? "posts" : null,
    {
      initialCursor: initialDraftsData?.nextCursor,
      initialData: initialDraftsData?.data,
      initialHasMore: initialDraftsData?.hasMore,
      initialRequestKey: initialDraftsData?.requestKey,
      query: draftsQuery,
    },
  );

  // Published tab: all published posts (internal + external) with full targets, media, and metrics
  const publishedQuery: Record<string, string | undefined> = {
    ...filterQuery,
    status: "published",
    include: "targets,media",
    include_external: "true",
  };
  const {
    data: publishedPosts,
    loading: publishedLoading,
    error: publishedError,
    hasMore: publishedHasMore,
    loadMore: publishedLoadMore,
    loadingMore: publishedLoadingMore,
    setData: setPublishedPosts,
    refetch: refetchPublished,
  } = usePaginatedApi<any>(
    activeTab === "published" ? "posts" : null,
    {
      initialCursor: initialPublishedData?.nextCursor,
      initialData: initialPublishedData?.data,
      initialHasMore: initialPublishedData?.hasMore,
      initialRequestKey: initialPublishedData?.requestKey,
      query: publishedQuery,
    },
  );

  // All tab: everything except drafts
  const allQuery: Record<string, string | undefined> = {
    ...filterQuery,
    include: "targets,media",
    include_external: "true",
  };
  const {
    data: allPosts,
    loading: allLoading,
    error: allError,
    hasMore: allHasMore,
    loadMore: allLoadMore,
    loadingMore: allLoadingMore,
    setData: setAllPosts,
    refetch: refetchAll,
  } = usePaginatedApi<any>(
    activeTab === "all" ? "posts" : null,
    {
      initialCursor: initialAllData?.nextCursor,
      initialData: initialAllData?.data,
      initialHasMore: initialAllData?.hasMore,
      initialRequestKey: initialAllData?.requestKey,
      query: allQuery,
    },
  );

  const [syncing, setSyncing] = useState(false);
  const [errorDetailPost, setErrorDetailPost] = useState<{ id: string; errors: Array<{ platform: string; message: string }> } | null>(null);
  const [unpublishPost, setUnpublishPost] = useState<{ id: string; platforms: string[] } | null>(null);
  const [unpublishSelected, setUnpublishSelected] = useState<Set<string>>(new Set());
  const [unpublishing, setUnpublishing] = useState(false);

  // Combine queue + failed for the Queue tab display
  const allQueuePosts = useMemo(() => {
    const combined = [...queuePosts];
    for (const fp of failedPosts) {
      if (!combined.some((p) => p.id === fp.id)) {
        combined.push(fp);
      }
    }
    return combined.sort((a, b) => {
      const aTime = new Date(a.scheduled_at || a.created_at).getTime();
      const bTime = new Date(b.scheduled_at || b.created_at).getTime();
      return aTime - bTime; // Soonest first
    });
  }, [queuePosts, failedPosts]);

  // Real-time updates via WebSocket — refetch the active tab when a post event arrives
  const refetchActiveTab = useCallback(() => {
    switch (activeTab) {
      case "queue": refetchQueue(); refetchFailed(); break;
      case "drafts": refetchDrafts(); break;
      case "published": refetchPublished(); break;
      case "all": refetchAll(); break;
    }
  }, [activeTab, refetchQueue, refetchFailed, refetchDrafts, refetchPublished, refetchAll]);

  useRealtimeUpdates(useCallback((event) => {
    if (event.type.startsWith("post.")) refetchActiveTab();
  }, [refetchActiveTab]));

  const handleRetry = async (id: string) => {
    try {
      const res = await fetch(`/api/posts/${id}/retry`, { method: "POST" });
      if (res.ok) {
        const updated = await res.json();
        const platforms = Object.values(updated.targets || {}).map((t: any) => (t as any).platform);
        const patch = { status: updated.status, platforms };
        setQueuePosts((prev) =>
          prev.map((p) => p.id === id ? { ...p, ...patch } : p)
        );
        setAllPosts((prev) =>
          prev.map((p: any) => p.id === id ? { ...p, ...patch } : p)
        );
      }
    } catch { /* ignore */ }
  };

  const handleForceResync = async () => {
    setSyncing(true);
    try {
      const params = new URLSearchParams();
      const wsId = filterQuery.workspace_id;
      if (wsId) params.set("workspace_id", wsId);
      const res = await fetch(`/api/accounts/sync${params.toString() ? `?${params}` : ""}`, {
        method: "POST",
      });
      if (res.ok) {
        const result = await res.json();
        console.log(`[Sync] Enqueued ${result.enqueued_count} accounts`);
      }
    } catch (err) {
      console.error("[Sync] Force resync failed:", err);
    } finally {
      setSyncing(false);
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/posts/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) {
      setQueuePosts((prev) => prev.filter((p) => p.id !== id));
      setDraftPosts((prev) => prev.filter((p) => p.id !== id));
      setPublishedPosts((prev) => prev.filter((p: any) => p.id !== id));
      setAllPosts((prev) => prev.filter((p: any) => p.id !== id));
    }
  };

  const handleShowErrors = async (postId: string) => {
    try {
      const res = await fetch(`/api/posts/${postId}`);
      if (!res.ok) return;
      const data = await res.json();
      const errors: Array<{ platform: string; message: string }> = [];
      for (const target of Object.values(data.targets || {})) {
        const t = target as any;
        if (t.status === "failed" && t.error?.message) {
          errors.push({ platform: t.platform, message: t.error.message });
        }
      }
      setErrorDetailPost({ id: postId, errors });
    } catch { /* ignore */ }
  };

  const handleShowUnpublish = async (postId: string) => {
    try {
      const res = await fetch(`/api/posts/${postId}`);
      if (!res.ok) return;
      const data = await res.json();
      const publishedPlatforms: string[] = [];
      for (const target of Object.values(data.targets || {})) {
        const t = target as any;
        if (t.status === "published" && t.platform) {
          publishedPlatforms.push(t.platform);
        }
      }
      setUnpublishPost({ id: postId, platforms: publishedPlatforms });
      setUnpublishSelected(new Set(publishedPlatforms));
    } catch { /* ignore */ }
  };

  const handleUnpublish = async () => {
    if (!unpublishPost || unpublishSelected.size === 0) return;
    setUnpublishing(true);
    try {
      const res = await fetch(`/api/posts/${unpublishPost.id}/unpublish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platforms: [...unpublishSelected] }),
      });
      if (res.ok) {
        const updated = await res.json();
        const patch = { status: updated.status };
        setPublishedPosts((prev) =>
          prev.map((p: any) => p.id === unpublishPost.id ? { ...p, ...patch } : p)
        );
        setAllPosts((prev) =>
          prev.map((p: any) => p.id === unpublishPost.id ? { ...p, ...patch } : p)
        );
      }
    } finally {
      setUnpublishing(false);
      setUnpublishPost(null);
    }
  };

  const toggleUnpublishPlatform = (platform: string) => {
    setUnpublishSelected((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  };

  const handleEdit = async (post: QueuePost) => {
    try {
      const res = await fetch(`/api/posts/${post.id}`);
      if (!res.ok) return;
      const data = await res.json();
      setEditPostData(data);
      setEditingPostId(post.id);
      setNewPostOpen(true);
    } catch { /* ignore */ }
  };

  const handleDuplicate = (post: QueuePost) => {
    setNewPostInitialDate(undefined);
    setNewPostOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Posts</h1>
          <a href="https://docs.relayapi.dev/api-reference/posts" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
        </div>
        <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => { setNewPostInitialDate(undefined); setNewPostOpen(true); }}>
          <Plus className="size-3.5" />
          {activeTab === "drafts" ? "New Draft" : "New Post"}
        </Button>
        <NewPostDialog
          open={newPostOpen}
          onOpenChange={(open) => {
            setNewPostOpen(open);
            if (!open) {
              setNewPostInitialDate(undefined);
              setEditingPostId(null);
              setEditPostData(null);
            }
          }}
          initialDate={editingPostId ? undefined : newPostInitialDate}
          initialPublishMode={editingPostId ? undefined : (activeTab === "drafts" ? "draft" : "now")}
          editPostId={editingPostId}
          editPostData={editPostData}
          onCreated={(created) => {
            if (!created) return;
            const platforms = Object.values(created.targets || {}).map((t: any) => (t as any).platform).filter(Boolean);
            const postData = {
              id: created.id,
              content: created.content || "",
              platforms,
              status: (created.status || "publishing") as Post["status"],
              scheduled_at: (created.scheduled_at && created.scheduled_at !== "now" && created.scheduled_at !== "draft") ? created.scheduled_at : null,
              published_at: created.published_at || null,
              created_at: created.created_at || new Date().toISOString(),
              targets: created.targets,
              media: created.media || null,
            };

            if (editingPostId) {
              // Edit: update in-place or move between lists
              setQueuePosts((prev) => prev.filter((p) => p.id !== editingPostId));
              setDraftPosts((prev) => prev.filter((p) => p.id !== editingPostId));
              setAllPosts((prev) => prev.filter((p: any) => p.id !== editingPostId));
              if (postData.status === "draft") {
                setDraftPosts((prev) => [postData, ...prev]);
              } else {
                setQueuePosts((prev) => [postData, ...prev]);
              }
              setAllPosts((prev) => [postData, ...prev]);
              setEditingPostId(null);
              setEditPostData(null);
            } else {
              // Create: prepend to correct list
              if (postData.status === "draft") {
                setDraftPosts((prev) => [postData, ...prev]);
              } else {
                setQueuePosts((prev) => [postData, ...prev]);
              }
              setAllPosts((prev) => [postData, ...prev]);
            }
          }}
        />
      </div>

      {/* Top-level tabs + controls */}
      <div className="flex items-end justify-between gap-x-4 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        <div className="flex gap-4 shrink-0">
          {topTabs.map((tab) => {
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
        <div className="pb-2 flex items-center gap-2 shrink-0">
          {/* Sync button (All/Published tabs) */}
          {(activeTab === "all" || activeTab === "published") && (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleForceResync}
              disabled={syncing}
              className="gap-1.5 text-xs text-muted-foreground h-7"
            >
              {syncing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              {syncing ? "Syncing..." : "Sync"}
            </Button>
          )}
          {/* View switcher (Queue and All tabs) — hidden on mobile (calendar not supported) */}
          {(activeTab === "queue" || activeTab === "all") && (
            <div className="hidden md:flex items-center gap-0">
              <button
                onClick={() => {
                  setViewMode("calendar");
                  localStorage.setItem("posts:viewMode", "calendar");
                  const url = new URL(window.location.href);
                  url.searchParams.set("view", "calendar");
                  window.history.replaceState({}, "", url.toString());
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 text-xs font-medium h-7 rounded-md transition-colors",
                  viewMode === "calendar" ? "text-foreground px-2" : "text-muted-foreground/50 hover:text-muted-foreground px-1"
                )}
                title="Calendar view"
              >
                <CalendarDays className="size-3.5" />
                {viewMode === "calendar" && "Calendar"}
              </button>
              <button
                onClick={() => {
                  setViewMode("list");
                  localStorage.setItem("posts:viewMode", "list");
                  const url = new URL(window.location.href);
                  url.searchParams.set("view", "list");
                  window.history.replaceState({}, "", url.toString());
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 text-xs font-medium h-7 rounded-md transition-colors",
                  viewMode === "list" ? "text-foreground px-2" : "text-muted-foreground/50 hover:text-muted-foreground px-1"
                )}
                title="List view"
              >
                <List className="size-3.5" />
                {viewMode === "list" && "List"}
              </button>
            </div>
          )}
          <FilterBar />
        </div>
      </div>

      {allError && activeTab === "all" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {allError}
        </div>
      )}

      {queueError && activeTab === "queue" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {queueError}
        </div>
      )}

      {draftsError && activeTab === "drafts" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {draftsError}
        </div>
      )}

      {publishedError && activeTab === "published" && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {publishedError}
        </div>
      )}

      {/* All tab — list view (always on mobile, or when list mode selected) */}
      {activeTab === "all" && (viewMode === "list" || isMobile) && (
        <>
          {/* Non-published posts (publishing/scheduled/failed/partial) use QueuePostList for status badges */}
          {allPosts
            .filter((p: any) => ["publishing", "scheduled", "failed", "partial"].includes(p.status))
            .some((p: any) => flattenPost(p).length > 0) && (
            <QueuePostList
              posts={allPosts.filter((p: any) => ["publishing", "scheduled", "failed", "partial"].includes(p.status))}
              loading={false}
              hasMore={false}
              loadingMore={false}
              onLoadMore={() => {}}
              onRetry={handleRetry}
              onDelete={handleDelete}
              onShowErrors={handleShowErrors}
              onEdit={handleEdit}
              onDuplicate={handleDuplicate}
            />
          )}
          <SentPostList
            posts={allPosts.filter((p: any) => p.status === "published")}
            loading={allLoading}
            hasMore={allHasMore}
            loadingMore={allLoadingMore}
            onLoadMore={allLoadMore}
            onDelete={handleDelete}
            onUnpublish={(id) => handleShowUnpublish(id)}
          />
        </>
      )}

      {/* Calendar view (All tab) — desktop only */}
      {viewMode === "calendar" && !isMobile && activeTab === "all" && (
        <CalendarView
          statusFilter="All"
          filterQuery={{ ...filterQuery, include_external: "true" }}
          initialPeriod={calendarPeriod}
          onOpenNewPost={(date) => {
            setNewPostInitialDate(date);
            setNewPostOpen(true);
          }}
          onEdit={(postId) => handleEdit({ id: postId } as QueuePost)}
          onDelete={handleDelete}
        />
      )}

      {/* Calendar view (Queue tab) — desktop only */}
      {viewMode === "calendar" && !isMobile && activeTab === "queue" && (
        <WorkspaceGuard>
          <CalendarView
            statusFilter="Scheduled"
            filterQuery={filterQuery}
            initialPeriod={calendarPeriod}
            onOpenNewPost={(date) => {
              setNewPostInitialDate(date);
              setNewPostOpen(true);
            }}
            onEdit={(postId) => handleEdit({ id: postId } as QueuePost)}
            onDelete={handleDelete}
          />
        </WorkspaceGuard>
      )}

      {/* Queue tab — list view (always on mobile, or when list mode selected) */}
      {(viewMode === "list" || isMobile) && activeTab === "queue" && (
        <QueuePostList
          posts={allQueuePosts}
          loading={queueLoading}
          hasMore={queueHasMore}
          loadingMore={queueLoadingMore}
          onLoadMore={queueLoadMore}
          onEdit={handleEdit}
          onDuplicate={handleDuplicate}
          onRetry={handleRetry}
          onDelete={handleDelete}
          onShowErrors={handleShowErrors}
        />
      )}

      {/* Drafts tab */}
      {activeTab === "drafts" && (
        <QueuePostList
          posts={draftPosts}
          isDrafts
          loading={draftsLoading}
          hasMore={draftsHasMore}
          loadingMore={draftsLoadingMore}
          onLoadMore={draftsLoadMore}
          onEdit={handleEdit}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
        />
      )}

      {/* Published tab */}
      {activeTab === "published" && (
        <SentPostList
          posts={publishedPosts}
          loading={publishedLoading}
          hasMore={publishedHasMore}
          loadingMore={publishedLoadingMore}
          onLoadMore={publishedLoadMore}
          onDelete={handleDelete}
          onUnpublish={(id) => handleShowUnpublish(id)}
        />
      )}

      {/* Unpublish dialog */}
      <Dialog open={!!unpublishPost} onOpenChange={() => setUnpublishPost(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">Unpublish Post</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Select which platforms to unpublish from:
          </p>
          <div className="flex flex-wrap gap-2 py-1">
            {unpublishPost?.platforms.map((p) => (
              <button
                key={p}
                onClick={() => toggleUnpublishPlatform(p)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all",
                  unpublishSelected.has(p)
                    ? "text-white ring-2 ring-offset-1 ring-offset-background ring-foreground/20 " + (platformColors[p] || "bg-neutral-600")
                    : "text-muted-foreground bg-accent/30 opacity-50"
                )}
              >
                <span className="[&_svg]:size-3">{platformIcons[p]}</span>
                {platformLabels[p] || p}
                {unpublishSelected.has(p) && <Check className="size-3" />}
              </button>
            ))}
            {unpublishPost?.platforms.length === 0 && (
              <p className="text-xs text-muted-foreground">No published platforms found.</p>
            )}
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" size="sm" onClick={() => setUnpublishPost(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={unpublishing || unpublishSelected.size === 0}
              onClick={handleUnpublish}
            >
              {unpublishing ? <Loader2 className="size-3.5 animate-spin" /> : `Unpublish (${unpublishSelected.size})`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Error detail dialog */}
      <Dialog open={!!errorDetailPost} onOpenChange={() => setErrorDetailPost(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium">Error Details</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-xs">
            {errorDetailPost?.errors.map((err, i) => (
              <div key={i} className="rounded-md border border-red-400/20 bg-red-400/5 px-3 py-2">
                <span className="font-medium text-red-400 capitalize">{platformLabels[err.platform] || err.platform}</span>
                <p className="text-muted-foreground mt-0.5">{err.message}</p>
              </div>
            ))}
            {errorDetailPost?.errors.length === 0 && (
              <p className="text-muted-foreground">No error details available.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
