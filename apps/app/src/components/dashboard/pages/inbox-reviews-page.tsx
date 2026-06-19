import { useState, useCallback, useRef, useEffect } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { motion } from "motion/react";
import { Loader2, Lock, Star, Send, Trash2, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { useUsage } from "@/hooks/use-usage";
import { LoadMore } from "@/components/ui/load-more";
import { PageHeader } from "@/components/dashboard/page-header";
import { PageToolbar } from "@/components/dashboard/page-toolbar";
import { WorkspaceFilterButton } from "@/components/dashboard/workspace-filter-button";
import { AccountFilterButton } from "@/components/dashboard/account-filter-button";
import { useFilterQuery } from "@/components/dashboard/filter-context";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";

import type { ReviewItem } from "@/components/dashboard/inbox/shared";
import { stagger, fadeUp, formatTimeAgo } from "@/components/dashboard/inbox/shared";
import { PlatformBadge } from "@/components/dashboard/inbox/shared-components";

export function InboxReviewsPage() {
  const filterQuery = useFilterQuery();
  const [minRating, setMinRating] = useState<number | null>(null);

  const { usage } = useUsage();
  const isPro = usage?.plan === "pro";

  const query: Record<string, string | number | undefined> = { ...filterQuery };
  if (minRating) query.min_rating = minRating;

  const {
    data: reviews,
    loading,
    error,
    hasMore,
    loadMore,
    loadingMore,
    setData: setReviews,
    refetch,
  } = usePaginatedApi<ReviewItem>(
    isPro ? "inbox/reviews" : null,
    { query },
  );

  useRealtimeUpdates(useCallback((event) => {
    if (event.type.startsWith("inbox.")) refetch();
  }, [refetch]));

  if (!isPro && usage !== null) {
    return (
      <div className="space-y-5 pb-16">
        <PageHeader title="Reviews" docsHref="https://docs.relayapi.dev/api-reference/inbox" />
        <div className="rounded-[12px] border border-border bg-card p-12 text-center">
          <Lock className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-medium">Pro Feature</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Upgrade to the Pro plan to access your unified social media inbox with comments, messages, and reviews.
          </p>
          <button
            type="button"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Upgrade to Pro
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-16">
      <div className="space-y-3">
        <PageHeader title="Reviews" docsHref="https://docs.relayapi.dev/api-reference/inbox" />

        <PageToolbar
          left={
            <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
              {[1, 2, 3, 4, 5].map((rating) => (
                <button
                  type="button"
                  key={rating}
                  onClick={() => setMinRating(minRating === rating ? null : rating)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-[6px] px-2.5 py-1 text-[13px] font-medium transition-colors whitespace-nowrap",
                    minRating === rating
                      ? "bg-card text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  title={`${rating}+ stars`}
                >
                  {rating}<Star className={cn("size-3", minRating === rating && "fill-amber-500 text-amber-500")} />+
                </button>
              ))}
            </div>
          }
          right={
            <>
              <WorkspaceFilterButton />
              <AccountFilterButton />
            </>
          }
        />
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
      ) : reviews.length === 0 && !error ? (
        <div className="rounded-[12px] border border-dashed border-border p-12 text-center">
          <Star className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No reviews</p>
          <p className="text-xs text-muted-foreground mt-1">
            Reviews from your connected accounts will appear here
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
            {reviews.map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                onReplyUpdated={(id, reply) => {
                  setReviews((prev) => prev.map((r) => r.id === id ? { ...r, reply } : r));
                }}
                onReplyDeleted={(id) => {
                  setReviews((prev) => prev.map((r) => r.id === id ? { ...r, reply: null } : r));
                }}
              />
            ))}
          </motion.div>
          <LoadMore hasMore={hasMore} loading={loadingMore} onLoadMore={loadMore} count={reviews.length} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review card
// ---------------------------------------------------------------------------

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={cn(
            "size-3.5",
            i <= rating ? "text-amber-500 fill-amber-500" : "text-muted-foreground/20"
          )}
        />
      ))}
    </div>
  );
}

function ReviewCard({
  review,
  onReplyUpdated,
  onReplyDeleted,
}: {
  review: ReviewItem;
  onReplyUpdated: (id: string, reply: string) => void;
  onReplyDeleted: (id: string) => void;
}) {
  const platform = review.platform?.toLowerCase() || "";
  const [showReplyBox, setShowReplyBox] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (showReplyBox) textareaRef.current?.focus();
  }, [showReplyBox]);

  const handleSendReply = async () => {
    if (!replyText.trim() || sending) return;
    setSending(true);
    setReplyError(null);
    try {
      const res = await fetch(`/api/inbox/reviews/${encodeURIComponent(review.id)}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: replyText.trim(), account_id: review.account_id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setReplyError(err?.error?.message || "Failed to reply");
        return;
      }
      onReplyUpdated(review.id, replyText.trim());
      setReplyText("");
      setShowReplyBox(false);
    } catch {
      setReplyError("Network error");
    } finally {
      setSending(false);
    }
  };

  const handleDeleteReply = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/inbox/reviews/${encodeURIComponent(review.id)}/reply`, {
        method: "DELETE",
      });
      if (res.ok) {
        onReplyDeleted(review.id);
        setShowDeleteConfirm(false);
      }
    } catch {
      // silent fail
    } finally {
      setDeleting(false);
    }
  };

  return (
    <motion.div variants={fadeUp} className="rounded-[12px] border border-border bg-card p-4 space-y-3">
      <div className="flex items-start gap-3">
        <PlatformBadge platform={platform} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold">{review.author_name}</span>
            <StarRating rating={review.rating} />
            <span className="text-xs text-muted-foreground">{formatTimeAgo(review.created_at)}</span>
          </div>
          {review.text && (
            <p className="text-sm mt-1.5 text-foreground/80">{review.text}</p>
          )}
        </div>
      </div>

      {/* Existing reply */}
      {review.reply && (
        <div className="ml-11 rounded-md bg-muted/50 px-3 py-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Your reply</span>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="text-muted-foreground/40 hover:text-destructive transition-colors"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
          <p className="text-sm text-foreground/70">{review.reply}</p>
        </div>
      )}

      {/* Reply button or reply box */}
      {!review.reply && !showReplyBox && (
        <div className="ml-11">
          <button
            type="button"
            onClick={() => setShowReplyBox(true)}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <MessageSquare className="size-3" />
            Reply
          </button>
        </div>
      )}

      {showReplyBox && (
        <div className="ml-11 rounded-lg border border-border bg-muted/30 overflow-hidden">
          <div className="px-3 py-2">
            <textarea
              ref={textareaRef}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  handleSendReply();
                }
                if (e.key === "Escape") setShowReplyBox(false);
              }}
              placeholder="Write your reply..."
              rows={3}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground resize-none"
            />
          </div>
          {replyError && (
            <div className="px-3 pb-1">
              <p className="text-xs text-destructive">{replyError}</p>
            </div>
          )}
          <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border">
            <button
              type="button"
              onClick={() => { setShowReplyBox(false); setReplyText(""); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSendReply}
              disabled={!replyText.trim() || sending}
              className={cn(
                "rounded-full p-1.5 transition-all",
                replyText.trim()
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-muted text-muted-foreground"
              )}
            >
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            </button>
          </div>
        </div>
      )}

      {/* Delete reply confirmation */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete reply</DialogTitle>
            <DialogDescription>
              This will permanently delete your reply to this review.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" size="sm" onClick={handleDeleteReply} disabled={deleting}>
              {deleting ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
