import { useMemo } from "react";
import { motion } from "motion/react";
import { Clock, FileEdit, Loader2 } from "lucide-react";
import { LoadMore } from "@/components/ui/load-more";
import {
  QueuePostCard,
  flattenPost,
  type QueuePost,
  type FlatQueueCard,
} from "./queue-post-card";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const },
  },
};

export interface QueuePostListProps {
  posts: QueuePost[];
  isDrafts?: boolean;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onEdit?: (post: QueuePost) => void;
  onDuplicate?: (post: QueuePost) => void;
  onRetry?: (id: string) => void;
  onDelete?: (id: string) => void;
  onShowErrors?: (id: string) => void;
}

function formatDateHeader(dateKey: string): string {
  const d = new Date(dateKey + "T12:00:00");
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (target.getTime() === today.getTime()) {
    return `Today, ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`;
  }
  if (target.getTime() === yesterday.getTime()) {
    return `Yesterday, ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`;
  }
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function getDateKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function QueuePostList({
  posts,
  isDrafts,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
  onEdit,
  onDuplicate,
  onRetry,
  onDelete,
  onShowErrors,
}: QueuePostListProps) {
  // Flatten all posts into one card per target, then group by date
  const { groups, orderedDates } = useMemo(() => {
    const allCards: FlatQueueCard[] = [];
    for (const post of posts) {
      allCards.push(...flattenPost(post));
    }

    const grouped = new Map<string, FlatQueueCard[]>();
    const dates: string[] = [];

    for (const card of allCards) {
      const dateSource = isDrafts
        ? card.createdAt
        : card.scheduledAt || card.createdAt;
      const dateKey = getDateKey(dateSource);

      if (!grouped.has(dateKey)) {
        grouped.set(dateKey, []);
        dates.push(dateKey);
      }
      grouped.get(dateKey)!.push(card);
    }

    return { groups: grouped, orderedDates: dates };
  }, [posts, isDrafts]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (orderedDates.length === 0) {
    const EmptyIcon = isDrafts ? FileEdit : Clock;
    return (
      <div className="rounded-md border border-dashed border-border p-12 text-center">
        <EmptyIcon className="size-8 text-muted-foreground/40 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">
          {isDrafts ? "No drafts" : "No scheduled posts"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {isDrafts
            ? "Saved drafts will appear here"
            : "Posts you schedule will appear here"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {orderedDates.map((dateKey) => {
        const cards = groups.get(dateKey)!;
        return (
          <div key={dateKey}>
            <h3 className="text-base font-semibold text-foreground mb-4">
              {formatDateHeader(dateKey)}
            </h3>
            <motion.div
              className="flex flex-col gap-4"
              variants={stagger}
              initial={false}
              animate="visible"
            >
              {cards.map((card) => (
                <motion.div key={`${card.postId}-${card.accountId}`} variants={fadeUp}>
                  <QueuePostCard
                    card={card}
                    isDraft={isDrafts}
                    onEdit={onEdit}
                    onDuplicate={onDuplicate}
                    onRetry={onRetry}
                    onDelete={onDelete}
                    onShowErrors={onShowErrors}
                  />
                </motion.div>
              ))}
            </motion.div>
          </div>
        );
      })}
      <LoadMore
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={onLoadMore}
        count={posts.length}
      />
    </div>
  );
}
