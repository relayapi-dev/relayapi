import { Suspense, lazy, useState, useEffect, useMemo, useCallback } from "react";
import { startOfMonth, startOfWeek } from "date-fns";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import {
  Plus,
  Check,
  Loader2,
  List,
  CalendarDays,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { PageHeader } from "@/components/dashboard/page-header";
import { PageToolbar, ToolbarDivider } from "@/components/dashboard/page-toolbar";
import { Segmented } from "@/components/dashboard/segmented";
import { IconButton } from "@/components/dashboard/icon-button";
import { WorkspaceFilterButton } from "@/components/dashboard/workspace-filter-button";
import { AccountFilterButton } from "@/components/dashboard/account-filter-button";
import { platformIcons } from "@/lib/platform-icons";
import { platformColors, platformLabels } from "@/lib/platform-maps";
import { PostErrorDialog } from "../calendar/post-error-details";
import { useFilterQuery, useFilter } from "@/components/dashboard/filter-context";
import type { CalendarPeriod } from "@/components/dashboard/calendar/calendar-header";
import { SentPostList } from "@/components/dashboard/pages/posts/sent-post-list";
import { QueuePostList } from "@/components/dashboard/pages/posts/queue-post-list";
import { WorkspaceGuard } from "@/components/dashboard/workspace-guard";
import { flattenPost, type QueuePost } from "@/components/dashboard/pages/posts/queue-post-card";
import type { InitialPaginatedData } from "@/lib/dashboard-page";
import type { EditPostData } from "@/components/dashboard/new-post-dialog";

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

const NewPostDialog = lazy(() =>
  import("@/components/dashboard/new-post-dialog").then((module) => ({
    default: module.NewPostDialog,
  })),
);

const CalendarView = lazy(() =>
  import("@/components/dashboard/calendar/calendar-view").then((module) => ({
    default: module.CalendarView,
  })),
);

function PostsSectionFallback() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}

export interface PostsPageProps {
  initialAllData?: InitialPaginatedData<Post>;
  initialCalendarPeriod?: CalendarPeriod;
  initialDraftsData?: InitialPaginatedData<Post>;
  initialFailedData?: InitialPaginatedData<Post>;
  initialPublishedData?: InitialPaginatedData<Post>;
  initialQueueData?: InitialPaginatedData<Post>;
  initialTab?: "all" | "queue" | "drafts" | "published";
  initialViewMode?: "list" | "calendar";
}

export function PostsPage({
  initialAllData,
  initialCalendarPeriod = "month",
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
  const [editPostData, setEditPostData] = useState<EditPostData | null>(null);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [viewMode, setViewMode] = useState<"list" | "calendar">(initialViewMode);
  const [calendarPeriod, setCalendarPeriod] = useState<CalendarPeriod>(initialCalendarPeriod);
  const [calendarDate, setCalendarDate] = useState<Date>(() =>
    initialCalendarPeriod === "week"
      ? startOfWeek(new Date(), { weekStartsOn: 1 })
      : startOfMonth(new Date()),
  );

  const handleCalendarPeriodChange = useCallback((newPeriod: CalendarPeriod) => {
    setCalendarPeriod(newPeriod);
    setCalendarDate(
      newPeriod === "week"
        ? startOfWeek(new Date(), { weekStartsOn: 1 })
        : startOfMonth(new Date()),
    );
    try {
      localStorage.setItem("posts:calendarPeriod", newPeriod);
    } catch { /* ignore */ }
    const url = new URL(window.location.href);
    url.searchParams.set("period", newPeriod);
    window.history.replaceState({}, "", url.toString());
  }, []);

  const switchTab = (tab: NonNullable<PostsPageProps["initialTab"]>) => {
    setActiveTab(tab);
    localStorage.setItem("posts:activeTab", tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  const filterQuery = useFilterQuery();
  const { accountId: _accountId } = useFilter();

  // List-view data (queue/failed/all hooks) only renders when the list is
  // actually shown. In calendar view CalendarView fetches its own data via
  // useCalendarPosts, so gating these hooks on the rendered view avoids a
  // wasted full proxy round trip on the default (calendar) load.
  const listRendered = viewMode === "list" || isMobile;

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
    activeTab === "queue" && listRendered ? "posts" : null,
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
    activeTab === "queue" && listRendered ? "posts" : null,
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
  } = usePaginatedApi<Post>(
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
  } = usePaginatedApi<Post>(
    activeTab === "all" && listRendered ? "posts" : null,
    {
      initialCursor: initialAllData?.nextCursor,
      initialData: initialAllData?.data,
      initialHasMore: initialAllData?.hasMore,
      initialRequestKey: initialAllData?.requestKey,
      query: allQuery,
    },
  );

  const [syncing, setSyncing] = useState(false);
  const [errorDetailPost, setErrorDetailPost] = useState<{ id: string; errors: Array<{ platform: string; message: string; detail?: string }> } | null>(null);
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
  }, [refetchActiveTab]), { defer: true });

  const handleRetry = async (id: string) => {
    try {
      const res = await fetch(`/api/posts/${id}/retry`, { method: "POST" });
      if (res.ok) {
        const updated = await res.json();
        const platforms = (Object.values(updated.targets || {}) as PostTarget[]).map((t) => t.platform);
        const patch = { status: updated.status, platforms };
        setQueuePosts((prev) =>
          prev.map((p) => p.id === id ? { ...p, ...patch } : p)
        );
        setAllPosts((prev) =>
          prev.map((p) => p.id === id ? { ...p, ...patch } : p)
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
      setPublishedPosts((prev) => prev.filter((p) => p.id !== id));
      setAllPosts((prev) => prev.filter((p) => p.id !== id));
    }
  };

  const handleShowErrors = async (postId: string) => {
    try {
      const res = await fetch(`/api/posts/${postId}`);
      if (!res.ok) return;
      const data = await res.json();
      const errors: Array<{ platform: string; message: string; detail?: string }> = [];
      for (const target of Object.values(data.targets || {})) {
        const t = target as {
          platform: string;
          error?: { message?: string; detail?: string };
        };
        if (t.error?.message) {
          errors.push({ platform: t.platform, message: t.error.message, detail: t.error.detail });
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
        const t = target as { platform?: string; status?: string };
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
          prev.map((p) => p.id === unpublishPost.id ? { ...p, ...patch } : p)
        );
        setAllPosts((prev) =>
          prev.map((p) => p.id === unpublishPost.id ? { ...p, ...patch } : p)
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

  const handleDuplicate = (_post: QueuePost) => {
    setNewPostInitialDate(undefined);
    setNewPostOpen(true);
  };

  const isWeekCalendar = viewMode === "calendar" && calendarPeriod === "week" && !isMobile;

  return (
    <div className={cn("space-y-6", isWeekCalendar ? "pb-4" : "pb-16")}>
      <PageHeader
        title="Posts"
        docsHref="https://docs.relayapi.dev/api-reference/posts"
        action={
          <Button onClick={() => { setNewPostInitialDate(undefined); setNewPostOpen(true); }}>
            <Plus className="size-4" />
            {activeTab === "drafts" ? "New Draft" : "New Post"}
          </Button>
        }
      />
      <Suspense fallback={null}>
          {newPostOpen ? (
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
                const platforms = (Object.values(created.targets || {}) as PostTarget[]).map((t) => t.platform).filter(Boolean);
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
                  setAllPosts((prev) => prev.filter((p) => p.id !== editingPostId));
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
          ) : null}
        </Suspense>

      {/* Tabs + filters/controls */}
      <PageToolbar
        left={
          <Segmented
            value={activeTab}
            onChange={(v) => switchTab(v)}
            options={topTabs.map((tab) => ({
              value: tab.toLowerCase() as typeof activeTab,
              label: tab,
            }))}
          />
        }
        right={
          <>
            {(activeTab === "all" || activeTab === "published") && (
              <IconButton
                title={syncing ? "Syncing..." : "Sync"}
                onClick={handleForceResync}
                disabled={syncing}
              >
                {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              </IconButton>
            )}
            <WorkspaceFilterButton />
            <AccountFilterButton />
            {(activeTab === "queue" || activeTab === "all") && (
              <>
                <ToolbarDivider className="hidden md:block" />
                <div className="hidden md:block">
                  <Segmented
                    size="icon"
                    value={viewMode}
                    onChange={(v) => {
                      setViewMode(v);
                      localStorage.setItem("posts:viewMode", v);
                      const url = new URL(window.location.href);
                      url.searchParams.set("view", v);
                      window.history.replaceState({}, "", url.toString());
                    }}
                    options={[
                      { value: "calendar", icon: <CalendarDays />, title: "Calendar view" },
                      { value: "list", icon: <List />, title: "List view" },
                    ]}
                  />
                </div>
              </>
            )}
          </>
        }
      />

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
            .filter((p) => ["publishing", "scheduled", "failed", "partial"].includes(p.status))
            .some((p) => flattenPost(p).length > 0) && (
            <QueuePostList
              posts={allPosts.filter((p) => ["publishing", "scheduled", "failed", "partial"].includes(p.status))}
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
            posts={allPosts.filter((p) => p.status === "published")}
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
        <Suspense fallback={<PostsSectionFallback />}>
          <CalendarView
            statusFilter="All"
            filterQuery={{ ...filterQuery, include_external: "true" }}
            period={calendarPeriod}
            onPeriodChange={handleCalendarPeriodChange}
            currentDate={calendarDate}
            onDateChange={setCalendarDate}
            onOpenNewPost={(date) => {
              setNewPostInitialDate(date);
              setNewPostOpen(true);
            }}
            onEdit={(postId) => handleEdit({ id: postId } as QueuePost)}
            onDelete={handleDelete}
          />
        </Suspense>
      )}

      {/* Calendar view (Queue tab) — desktop only */}
      {viewMode === "calendar" && !isMobile && activeTab === "queue" && (
        <WorkspaceGuard>
          <Suspense fallback={<PostsSectionFallback />}>
            <CalendarView
              statusFilter="Scheduled"
              filterQuery={filterQuery}
              period={calendarPeriod}
              onPeriodChange={handleCalendarPeriodChange}
              currentDate={calendarDate}
              onDateChange={setCalendarDate}
              onOpenNewPost={(date) => {
                setNewPostInitialDate(date);
                setNewPostOpen(true);
              }}
              onEdit={(postId) => handleEdit({ id: postId } as QueuePost)}
              onDelete={handleDelete}
            />
          </Suspense>
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
                type="button"
                key={p}
                onClick={() => toggleUnpublishPlatform(p)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all",
                  unpublishSelected.has(p)
                    ? `text-white ring-2 ring-offset-1 ring-offset-background ring-foreground/20 ${platformColors[p] || "bg-neutral-600"}`
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
      <PostErrorDialog
        open={!!errorDetailPost}
        onOpenChange={() => setErrorDetailPost(null)}
        errors={errorDetailPost?.errors ?? []}
      />
    </div>
  );
}
