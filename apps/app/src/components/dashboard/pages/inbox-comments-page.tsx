import { useState, useEffect, useCallback, useRef } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { useSilentRefresh } from "@/hooks/use-silent-refresh";
import { motion, AnimatePresence } from "motion/react";
import { Loader2, Lock, Inbox as InboxIcon, BookOpen, ExternalLink, MessageCircle, LayoutList, Rows3, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { useUsage } from "@/hooks/use-usage";
import { LoadMore } from "@/components/ui/load-more";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { useFilterQuery } from "@/components/dashboard/filter-context";
import { WorkspaceGuard } from "@/components/dashboard/workspace-guard";

import type { InboxComment, PostWithComments } from "@/components/dashboard/inbox/shared";
import { stagger, fadeUp, newItemEnter, groupCommentsByThread, formatTimeAgo, platformColors } from "@/components/dashboard/inbox/shared";
import { AuthorAvatar, PlatformBadge, ReplyProgressBar } from "@/components/dashboard/inbox/shared-components";
import { LikeButton, CommentActions } from "@/components/dashboard/inbox/comment-actions";
import { InlineReplyBox } from "@/components/dashboard/inbox/inline-reply-box";
import { PostDetailPanel } from "@/components/dashboard/inbox/post-detail-panel";
import { platformIcons } from "@/lib/platform-icons";

export function InboxCommentsPage({
  initialViewMode = "by-post",
}: {
  initialViewMode?: "list" | "by-post";
} = {}) {
  const filterQuery = useFilterQuery();
  const [viewMode, setViewMode] = useState<"list" | "by-post">(initialViewMode);

  const switchView = (view: "list" | "by-post") => {
    setViewMode(view);
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    window.history.replaceState({}, "", url.toString());
  };

  const { usage } = useUsage();
  const isPro = usage?.plan === "pro";

  const endpoint = viewMode === "by-post" ? "inbox/comments/by-post" : "inbox/comments";

  const {
    data: items,
    loading,
    error,
    hasMore,
    loadMore,
    loadingMore,
    setData: setItems,
    refetch: refetchInbox,
  } = usePaginatedApi<any>(
    isPro ? endpoint : null,
    { query: filterQuery },
  );

  const getItemId = useCallback((item: any) =>
    viewMode === "by-post" ? `${item.id}-${item.account_id}` : item.id,
  [viewMode]);

  const { silentRefresh } = useSilentRefresh({
    path: isPro ? endpoint : null,
    query: filterQuery,
    setData: setItems,
    getId: getItemId,
  });

  useRealtimeUpdates(useCallback((event) => {
    if (event.type.startsWith("inbox.comment")) silentRefresh();
  }, [silentRefresh]));

  // Polling fallback — refresh every 45s while the tab is visible,
  // ensures comments appear even if WebSocket events are missed
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) silentRefresh();
    }, 45_000);
    return () => clearInterval(id);
  }, [silentRefresh]);

  const handleListDelete = useCallback((commentId: string) => {
    setItems((prev: any[]) => prev.filter((c) => c.id !== commentId));
  }, [setItems]);

  const handleListHideToggle = useCallback((commentId: string, hidden: boolean) => {
    setItems((prev: any[]) => prev.map((c) => c.id === commentId ? { ...c, hidden } : c));
  }, [setItems]);

  const handleListReplyAdded = useCallback((newComment: InboxComment) => {
    setItems((prev: any[]) => [newComment, ...prev]);
  }, [setItems]);

  if (!isPro && usage !== null) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Comments</h1>
          <a href="https://docs.relayapi.dev/api-reference/inbox" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
        </div>
        <div className="rounded-md border border-border p-12 text-center">
          <Lock className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-medium">Pro Feature</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Upgrade to the Pro plan to access your unified social media inbox with comments, messages, and reviews.
          </p>
          <button className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
            Upgrade to Pro
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Comments</h1>
          <a href="https://docs.relayapi.dev/api-reference/inbox" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => switchView("list")}
            className={cn(
              "inline-flex items-center gap-1.5 text-xs font-medium h-7 rounded-md transition-colors",
              viewMode === "list" ? "text-foreground px-2" : "text-muted-foreground/50 hover:text-muted-foreground px-1"
            )}
            title="List view"
          >
            <LayoutList className="size-3.5" />
            {viewMode === "list" && "List"}
          </button>
          <button
            onClick={() => switchView("by-post")}
            className={cn(
              "inline-flex items-center gap-1.5 text-xs font-medium h-7 rounded-md transition-colors",
              viewMode === "by-post" ? "text-foreground px-2" : "text-muted-foreground/50 hover:text-muted-foreground px-1"
            )}
            title="By Post view"
          >
            <Rows3 className="size-3.5" />
            {viewMode === "by-post" && "By Post"}
          </button>
          <FilterBar />
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 && !error ? (
        <div className="rounded-md border border-dashed border-border p-12 text-center">
          <InboxIcon className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No comments</p>
          <p className="text-xs text-muted-foreground mt-1">
            Comments from your connected accounts will appear here
          </p>
        </div>
      ) : viewMode === "by-post" ? (
        <WorkspaceGuard>
          <ByPostView posts={items as PostWithComments[]} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} />
        </WorkspaceGuard>
      ) : (
        <CommentsListView comments={items as InboxComment[]} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={loadMore} onDelete={handleListDelete} onHideToggle={handleListHideToggle} onReplyAdded={handleListReplyAdded} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comments list view
// ---------------------------------------------------------------------------

function CommentsListView({
  comments,
  hasMore,
  loadingMore,
  onLoadMore,
  onDelete,
  onHideToggle,
  onReplyAdded,
}: {
  comments: InboxComment[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onDelete: (commentId: string) => void;
  onHideToggle: (commentId: string, hidden: boolean) => void;
  onReplyAdded: (comment: InboxComment) => void;
}) {
  const { topLevel, repliesByParent } = groupCommentsByThread(comments);
  const [expandedCommentId, setExpandedCommentId] = useState<string | null>(null);
  const [draftReplies, setDraftReplies] = useState<Record<string, string>>({});
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expandedCommentId) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpandedCommentId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [expandedCommentId]);

  const toggleExpanded = (commentId: string) => {
    setExpandedCommentId((prev) => (prev === commentId ? null : commentId));
  };

  const updateDraft = useCallback((commentId: string, text: string) => {
    setDraftReplies((prev) => ({ ...prev, [commentId]: text }));
  }, []);

  const clearDraft = useCallback((commentId: string) => {
    setDraftReplies((prev) => {
      const next = { ...prev };
      delete next[commentId];
      return next;
    });
  }, []);

  return (
    <div className="pb-16">
      <div
        ref={containerRef}
        className="space-y-3"
      >
        <AnimatePresence initial={false}>
        {topLevel.map((c) => {
          const platform = c.platform?.toLowerCase() || "";
          const replies = repliesByParent.get(c.id) || [];
          const hasReplies = replies.length > 0 || (c.replies_count != null && c.replies_count > 0);
          const replyTarget = replies.find(r => r.id === expandedCommentId);
          const isExpanded = expandedCommentId === c.id || !!replyTarget;
          return (
            <motion.div
              key={c.id}
              layout
              transition={{ layout: { duration: 0.1 } }}
              initial={newItemEnter.initial}
              animate={newItemEnter.animate}
              className={cn(
                "rounded-lg border p-4 space-y-3 cursor-pointer transition-colors",
                isExpanded ? "border-primary/50 bg-primary/[0.02]" : "border-border hover:bg-accent/20"
              )}
              onClick={() => toggleExpanded(c.id)}
            >
              <div className="group flex items-start gap-3">
                <div className="relative shrink-0">
                  {c.account_avatar_url ? (
                    <img src={c.account_avatar_url} alt={platform} className="size-8 rounded-full border border-border object-cover" />
                  ) : (
                    <PlatformBadge platform={platform} />
                  )}
                  {platformIcons[platform] && (
                    <div className={cn(
                      "absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full text-white [&_svg]:size-2.5",
                      platformColors[platform] || "bg-neutral-700"
                    )}>
                      {platformIcons[platform]}
                    </div>
                  )}
                </div>
                <AuthorAvatar avatar={c.author_avatar} name={c.author_name} />
                <div className={cn("flex-1 min-w-0", c.hidden && "opacity-50")}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">{c.author_name}</span>
                    <span className="text-xs text-muted-foreground">{formatTimeAgo(c.created_at)}</span>
                    {hasReplies && (
                      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600">Replied</span>
                    )}
                    {c.hidden && (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600">Hidden</span>
                    )}
                  </div>
                  <p className="text-sm mt-1 text-foreground/80">{c.text}</p>
                  {c.post_text && (
                    <div className="mt-2 flex items-start gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
                      {c.post_thumbnail_url && (
                        <img src={c.post_thumbnail_url} alt="" className="size-8 rounded object-cover shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted-foreground line-clamp-1">{c.post_text}</p>
                        {c.post_platform_url && (
                          <a
                            href={c.post_platform_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground mt-0.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            View post <ExternalLink className="size-2.5" />
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <LikeButton comment={c} />
                  <CommentActions
                    comment={c}
                    platform={platform}
                    accountId={c.account_id || ""}
                    postId={c.post_id || ""}
                    onDelete={onDelete}
                    onHideToggle={onHideToggle}
                    onRequestReply={() => setExpandedCommentId(c.id)}
                  />
                </div>
              </div>

              {replies.length > 0 && (
                <div className="ml-11 space-y-2.5 border-l-2 border-border pl-3">
                  {replies.map((r) => {
                    const rPlatform = r.platform?.toLowerCase() || platform;
                    return (
                      <div key={r.id} className={cn("group flex items-start gap-2.5", r.hidden && "opacity-50")}>
                        <AuthorAvatar avatar={r.author_avatar} name={r.author_name} size="sm" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold">{r.author_name}</span>
                            <span className="text-[10px] text-muted-foreground">{formatTimeAgo(r.created_at)}</span>
                            {r.hidden && (
                              <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">Hidden</span>
                            )}
                          </div>
                          <p className="text-xs mt-0.5 text-foreground/80">{r.text}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <LikeButton comment={r} />
                          <CommentActions
                            comment={r}
                            platform={rPlatform}
                            accountId={r.account_id || c.account_id || ""}
                            postId={r.post_id || c.post_id || ""}
                            onDelete={onDelete}
                            onHideToggle={onHideToggle}
                            onRequestReply={() => setExpandedCommentId(r.id)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {isExpanded && (() => {
                const target = replyTarget || c;
                const targetId = expandedCommentId!;
                return (
                  <InlineReplyBox
                    comment={target}
                    platform={platform}
                    accountId={c.account_id || ""}
                    postId={c.post_id || ""}
                    onReplyAdded={(newComment) => { onReplyAdded(newComment); clearDraft(targetId); }}
                    onClose={() => setExpandedCommentId(null)}
                    draft={draftReplies[targetId] ?? ""}
                    onDraftChange={(text) => updateDraft(targetId, text)}
                  />
                );
              })()}
            </motion.div>
          );
        })}
        </AnimatePresence>
      </div>
      <LoadMore hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} count={comments.length} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// By-post view
// ---------------------------------------------------------------------------

function ByPostView({
  posts,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  posts: PostWithComments[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const [selectedPostKey, setSelectedPostKey] = useState<string | null>(null);
  const [liveCounts, setLiveCounts] = useState<Record<string, number>>({});
  const [liveRepliedCounts, setLiveRepliedCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    const first = posts[0];
    if (first && !selectedPostKey) {
      setSelectedPostKey(`${first.id}-${first.account_id}`);
    }
  }, [posts, selectedPostKey]);

  const prefetchedRef = useRef<Set<string>>(new Set());
  const prevPostIdsRef = useRef<string>("");
  useEffect(() => {
    const postIds = posts.map((p) => p.id).join(",");
    if (prevPostIdsRef.current && prevPostIdsRef.current !== postIds) {
      prefetchedRef.current.clear();
    }
    prevPostIdsRef.current = postIds;
  }, [posts]);
  useEffect(() => {
    const BATCH_SIZE = 5;
    const MAX_PREFETCH = 20;

    const toPrefetch = posts
      .filter((p) => !prefetchedRef.current.has(`${p.id}-${p.account_id}`))
      .slice(0, MAX_PREFETCH);

    if (toPrefetch.length === 0) return;

    for (const post of toPrefetch) {
      prefetchedRef.current.add(`${post.id}-${post.account_id}`);
    }

    (async () => {
      for (let i = 0; i < toPrefetch.length; i += BATCH_SIZE) {
        const batch = toPrefetch.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(
          batch.map(async (post) => {
            const postKey = `${post.id}-${post.account_id}`;
            const url = new URL(`/api/inbox/comments/${encodeURIComponent(post.id)}`, window.location.origin);
            url.searchParams.set("platform", post.platform);
            url.searchParams.set("account_id", post.account_id);
            url.searchParams.set("limit", "100");

            const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
            if (!res.ok) return;
            const json = await res.json();
            if (!json?.data) return;
            const comments = json.data as InboxComment[];
            const { topLevel, repliesByParent } = groupCommentsByThread(comments);
            const replied = topLevel.filter(
              (c) => (repliesByParent.get(c.id)?.length ?? 0) > 0 || (c.replies_count != null && c.replies_count > 0),
            ).length;
            setLiveCounts((prev) => ({ ...prev, [postKey]: topLevel.length }));
            setLiveRepliedCounts((prev) => ({ ...prev, [postKey]: replied }));
          }),
        );
      }
    })();
  }, [posts]);

  const handleCommentsLoaded = useCallback((postKey: string, total: number, replied: number) => {
    setLiveCounts((prev) => prev[postKey] === total ? prev : { ...prev, [postKey]: total });
    setLiveRepliedCounts((prev) => prev[postKey] === replied ? prev : { ...prev, [postKey]: replied });
  }, []);

  const selectedPost = posts.find((p) => `${p.id}-${p.account_id}` === selectedPostKey) || null;

  const postList = (
    <div className="space-y-2 p-3">
      <AnimatePresence initial={false}>
      {posts.map((post) => {
        const platform = post.platform?.toLowerCase() || "";
        const postKey = `${post.id}-${post.account_id}`;
        const isSelected = selectedPostKey === postKey;
        const displayCount = postKey in liveCounts ? (liveCounts[postKey] ?? 0) : post.comments_count;
        const repliedCount = liveRepliedCounts[postKey] ?? 0;
        return (
          <motion.button
            key={postKey}
            layout
            transition={{ layout: { duration: 0.1 } }}
            initial={newItemEnter.initial}
            animate={newItemEnter.animate}
            onClick={() => setSelectedPostKey(postKey)}
            className={cn(
              "w-full text-left rounded-lg border p-3 transition-all hover:bg-accent/30",
              isSelected ? "border-primary bg-primary/5" : "border-border"
            )}
          >
            <div className="flex items-start gap-2.5">
              <div className="relative shrink-0">
                {post.account_avatar_url ? (
                  <img src={post.account_avatar_url} alt={platform} className="size-8 rounded-full border border-border object-cover" />
                ) : (
                  <PlatformBadge platform={platform} />
                )}
                {platformIcons[platform] && (
                  <div className={cn(
                    "absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full text-white [&_svg]:size-2.5",
                    platformColors[platform] || "bg-neutral-700"
                  )}>
                    {platformIcons[platform]}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm line-clamp-2">{post.text || "Post"}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <MessageCircle className="size-3" />
                    {displayCount}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatTimeAgo(post.created_at)}</span>
                </div>
                {displayCount > 0 && (
                  <ReplyProgressBar replied={repliedCount} total={displayCount} />
                )}
              </div>
              {post.thumbnail_url && (
                <img src={post.thumbnail_url} alt="" className="size-12 rounded-md object-cover shrink-0" />
              )}
            </div>
          </motion.button>
        );
      })}
      </AnimatePresence>
      <LoadMore hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} count={posts.length} />
    </div>
  );

  const detailPanel = selectedPost ? (
    <PostDetailPanel
      key={selectedPostKey}
      post={selectedPost}
      onCommentsLoaded={handleCommentsLoaded}
    />
  ) : (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <MessageCircle className="size-8 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">Select a post to view comments</p>
      </div>
    </div>
  );

  return (
    <>
      <div
        className="hidden md:flex rounded-lg border border-border overflow-hidden"
        style={{ height: "calc(-7rem + 100vh)" }}
      >
        <ScrollArea className="w-[340px] shrink-0 border-r border-border">
          {postList}
        </ScrollArea>
        <ScrollArea className="flex-1 min-w-0">
          {detailPanel}
        </ScrollArea>
      </div>

      <div className="md:hidden">
        {selectedPostKey && selectedPost ? (
          <div className="space-y-3">
            <button
              onClick={() => setSelectedPostKey(null)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="size-3" />
              Back to posts
            </button>
            {detailPanel}
          </div>
        ) : (
          postList
        )}
      </div>
    </>
  );
}
