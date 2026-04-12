import { useState, useEffect, useCallback, useRef } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { useSilentRefresh } from "@/hooks/use-silent-refresh";
import { motion, AnimatePresence } from "motion/react";
import { Loader2, ExternalLink, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import type { InboxComment, PostWithComments } from "./shared";
import { newItemEnter, groupCommentsByThread, formatTimeAgo, platformLabels } from "./shared";
import { AuthorAvatar, PlatformBadge } from "./shared-components";
import { LikeButton, CommentActions } from "./comment-actions";
import { InlineReplyBox } from "./inline-reply-box";

export function PostDetailPanel({
  post,
  onCommentsLoaded,
}: {
  post: PostWithComments;
  onCommentsLoaded?: (postKey: string, total: number, replied: number) => void;
}) {
  const postKey = `${post.id}-${post.account_id}`;
  const normalizedPlatform = post.platform?.toLowerCase() || "";

  const {
    data: comments,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    setData: setComments,
  } = usePaginatedApi<InboxComment>(
    `inbox/comments/${encodeURIComponent(post.id)}`,
    { query: { platform: post.platform, account_id: post.account_id } },
  );

  const getCommentId = useCallback((c: InboxComment) => c.id, []);
  const { silentRefresh } = useSilentRefresh<InboxComment>({
    path: `inbox/comments/${encodeURIComponent(post.id)}`,
    query: { platform: post.platform, account_id: post.account_id },
    setData: setComments,
    getId: getCommentId,
  });

  useRealtimeUpdates(useCallback((event) => {
    if (event.type.startsWith("inbox.comment") && (!event.post_id || event.post_id === post.id)) {
      silentRefresh();
    }
  }, [post.id, silentRefresh]));

  const { topLevel, repliesByParent } = groupCommentsByThread(comments);
  const repliedCount = topLevel.filter((c) => (repliesByParent.get(c.id)?.length ?? 0) > 0 || (c.replies_count != null && c.replies_count > 0)).length;
  const [expandedCommentId, setExpandedCommentId] = useState<string | null>(null);
  const [draftReplies, setDraftReplies] = useState<Record<string, string>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expandedCommentId) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpandedCommentId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [expandedCommentId]);

  useEffect(() => {
    if (!loading && onCommentsLoaded) {
      onCommentsLoaded(postKey, topLevel.length, repliedCount);
    }
  }, [topLevel.length, loading, repliedCount, postKey, onCommentsLoaded]);

  const handleDelete = useCallback((commentId: string) => {
    setComments((prev) => prev.filter((c) => c.id !== commentId));
  }, [setComments]);

  const handleHideToggle = useCallback((commentId: string, hidden: boolean) => {
    setComments((prev) => prev.map((c) => c.id === commentId ? { ...c, hidden } : c));
  }, [setComments]);

  const handleReplyAdded = useCallback((newComment: InboxComment) => {
    setComments((prev) => [...prev, newComment]);
  }, [setComments]);

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

  const toggleExpanded = (commentId: string) => {
    setExpandedCommentId((prev) => (prev === commentId ? null : commentId));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isVideo = normalizedPlatform === "youtube" || normalizedPlatform === "tiktok";
  const platformLabel = platformLabels[normalizedPlatform] || post.platform;

  return (
    <div ref={panelRef} className="p-4 space-y-4">
      <div className="rounded-lg border border-border overflow-hidden bg-card">
        {/* Post header */}
        <div className="flex items-center gap-2.5 px-3.5 py-2.5">
          {post.account_avatar_url ? (
            <img src={post.account_avatar_url} alt="" className="size-8 rounded-full border border-border object-cover shrink-0" />
          ) : (
            <PlatformBadge platform={normalizedPlatform} />
          )}
          <div className="flex-1 min-w-0">
            <span className="text-xs font-semibold capitalize">{normalizedPlatform}</span>
            <span className="text-[10px] text-muted-foreground ml-2">{formatTimeAgo(post.created_at)}</span>
          </div>
          {post.platform_url && (
            <a
              href={post.platform_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              View on platform <ExternalLink className="size-3" />
            </a>
          )}
        </div>

        {/* Media + Caption */}
        {isVideo ? (
          <>
            {post.thumbnail_url && (
              <div className="relative bg-black/5 dark:bg-white/5 aspect-video">
                <img src={post.thumbnail_url} alt="" className="w-full h-full object-contain" />
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="size-12 rounded-full bg-black/60 flex items-center justify-center">
                    <Play className="size-5 text-white fill-white ml-0.5" />
                  </div>
                </div>
              </div>
            )}
            {post.text && (
              <div className="px-3.5 py-2.5">
                <p className="text-sm leading-relaxed">{post.text}</p>
              </div>
            )}
          </>
        ) : post.thumbnail_url ? (
          <div className="flex items-start gap-3 px-3.5 py-2.5">
            <div className="flex-1 min-w-0">
              {post.text && <p className="text-sm leading-relaxed">{post.text}</p>}
            </div>
            <img src={post.thumbnail_url} alt="" className="max-h-56 rounded-md shrink-0 object-contain" />
          </div>
        ) : post.text ? (
          <div className="px-3.5 py-2.5">
            <p className="text-sm leading-relaxed">{post.text}</p>
          </div>
        ) : null}

        {/* Stats bar */}
        <div className="flex items-center justify-between px-3.5 py-2 border-t border-border text-xs text-muted-foreground">
          <span>{repliedCount} replied / {topLevel.length} total comments</span>
          <span>Includes Replies Via {platformLabel}</span>
        </div>
      </div>

      {topLevel.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">No comments on this post</p>
      ) : (
        <div className="space-y-3">
          <AnimatePresence initial={false}>
          {topLevel.map((c) => {
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
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <LikeButton comment={c} />
                    <CommentActions
                      comment={c}
                      platform={normalizedPlatform}
                      accountId={post.account_id}
                      postId={post.id}
                      onDelete={handleDelete}
                      onHideToggle={handleHideToggle}
                      onRequestReply={() => setExpandedCommentId(c.id)}
                    />
                  </div>
                </div>

                {replies.length > 0 && (
                  <div className="ml-11 space-y-2.5 border-l-2 border-border pl-3">
                    {replies.map((r) => (
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
                            platform={normalizedPlatform}
                            accountId={post.account_id}
                            postId={post.id}
                            onDelete={handleDelete}
                            onHideToggle={handleHideToggle}
                            onRequestReply={() => setExpandedCommentId(r.id)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {isExpanded && (() => {
                  const target = replyTarget || c;
                  const targetId = expandedCommentId!;
                  return (
                    <InlineReplyBox
                      comment={target}
                      platform={normalizedPlatform}
                      accountId={post.account_id}
                      postId={post.id}
                      onReplyAdded={(newComment) => { handleReplyAdded(newComment); clearDraft(targetId); }}
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
      )}

      {hasMore && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full text-xs text-muted-foreground hover:text-foreground py-1.5 transition-colors"
        >
          {loadingMore ? <Loader2 className="size-3 animate-spin mx-auto" /> : "Load more comments"}
        </button>
      )}
    </div>
  );
}
