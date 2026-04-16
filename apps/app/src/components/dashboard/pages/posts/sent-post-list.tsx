import { useMemo } from "react";
import { motion } from "motion/react";
import { Loader2, Send } from "lucide-react";
import { LoadMore } from "@/components/ui/load-more";
import {
  SentPostCard,
  type SentPostEngagement,
  type SentPostTarget,
} from "./sent-post-card";

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

interface SentPost {
  id: string;
  source?: "internal" | "external";
  content: string | null;
  media: Array<{ url: string; type?: string }> | null;
  published_at: string | null;
  created_at: string;
  // Internal posts have targets
  targets?: Record<
    string,
    {
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
    }
  >;
  // Both internal and external posts can have inline metrics
  metrics?: {
    impressions?: number;
    reach?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    saves?: number;
    clicks?: number;
    views?: number;
    engagement_rate?: number;
  };
  // External post fields
  platform?: string;
  social_account_id?: string;
  platform_post_id?: string;
  platform_url?: string | null;
  media_urls?: string[];
  media_type?: string | null;
  thumbnail_url?: string | null;
}

export interface SentPostListProps {
  posts: SentPost[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  engagementMap?: Map<string, SentPostEngagement> | null;
  onDelete?: (postId: string) => void;
  onUnpublish?: (postId: string) => void;
  onDuplicate?: (postId: string) => void;
}

interface FlatCard {
  postId: string;
  content: string | null;
  media: Array<{ url: string; type?: string }> | null;
  target: SentPostTarget;
  dateKey: string;
  sortTime: number;
}

function formatDateHeader(dateKey: string): string {
  const d = new Date(dateKey + "T12:00:00"); // noon to avoid timezone shifts
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

export function SentPostList({
  posts,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
  engagementMap,
  onDelete,
  onUnpublish,
  onDuplicate,
}: SentPostListProps) {
  // Flatten posts into one card per target, grouped by date
  const { groups, orderedDates } = useMemo(() => {
    const cards: (FlatCard & { inlineMetrics?: SentPostEngagement | null })[] = [];

    for (const post of posts) {
      // External posts: single card (no targets map)
      if (post.source === "external") {
        const publishedAt = post.published_at || post.created_at;
        const d = new Date(publishedAt);
        const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const m = post.metrics;

        cards.push({
          postId: post.id,
          content: post.content,
          media: post.thumbnail_url
            ? [{ url: post.thumbnail_url, type: post.media_type ?? undefined }]
            : post.media_urls?.length
              ? post.media_urls.map((url) => ({ url }))
              : post.media,
          target: {
            accountId: post.social_account_id || "",
            platform: post.platform || "",
            username: null,
            displayName: null,
            avatarUrl: null,
            platformUrl: post.platform_url ?? null,
            platformPostId: post.platform_post_id ?? null,
            publishedAt,
          },
          dateKey,
          sortTime: d.getTime(),
          inlineMetrics: m ? {
            impressions: m.impressions ?? 0,
            reach: m.reach ?? 0,
            likes: m.likes ?? 0,
            comments: m.comments ?? 0,
            shares: m.shares ?? 0,
            saves: m.saves ?? 0,
            clicks: m.clicks ?? 0,
            engagement_rate: m.engagement_rate ?? 0,
          } : null,
        });
        continue;
      }

      // Internal posts: one card per target
      for (const [accountId, target] of Object.entries(post.targets || {})) {
        if (target.status !== "published") continue;
        const account = target.accounts?.[0];
        const publishedAt = post.published_at || post.created_at;
        const d = new Date(publishedAt);
        const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const m = post.metrics;

        cards.push({
          postId: post.id,
          content: post.content,
          media: post.media,
          target: {
            accountId,
            platform: target.platform,
            username: account?.username ?? null,
            displayName: account?.display_name ?? null,
            avatarUrl: account?.avatar_url ?? null,
            platformUrl: account?.url ?? null,
            platformPostId: account?.platform_post_id ?? null,
            publishedAt,
          },
          dateKey,
          sortTime: d.getTime(),
          inlineMetrics: m ? {
            impressions: m.impressions ?? 0,
            reach: m.reach ?? 0,
            likes: m.likes ?? 0,
            comments: m.comments ?? 0,
            shares: m.shares ?? 0,
            saves: m.saves ?? 0,
            clicks: m.clicks ?? 0,
            engagement_rate: m.engagement_rate ?? 0,
          } : null,
        });
      }
    }

    // Sort newest first
    cards.sort((a, b) => b.sortTime - a.sortTime);

    // Group by date
    const grouped = new Map<string, typeof cards>();
    const dates: string[] = [];
    for (const card of cards) {
      if (!grouped.has(card.dateKey)) {
        grouped.set(card.dateKey, []);
        dates.push(card.dateKey);
      }
      grouped.get(card.dateKey)!.push(card);
    }

    return { groups: grouped, orderedDates: dates };
  }, [posts]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (orderedDates.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-12 text-center space-y-4">
        <Send className="size-8 text-muted-foreground/40 mx-auto" />
        <div>
          <p className="text-sm text-muted-foreground">No published posts yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Posts you publish will appear here with their engagement stats
          </p>
        </div>
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
              {cards.map((card) => {
                // Prefer inline metrics, fall back to engagementMap if available
                const engagement = card.inlineMetrics
                  ?? (card.target.platformPostId && engagementMap
                    ? engagementMap.get(card.target.platformPostId) ?? null
                    : null);

                return (
                  <motion.div key={`${card.postId}-${card.target.accountId}`} variants={fadeUp}>
                    <SentPostCard
                      postId={card.postId}
                      content={card.content}
                      media={card.media}
                      target={card.target}
                      engagement={engagement}
                      onDelete={onDelete}
                      onUnpublish={onUnpublish}
                      onDuplicate={onDuplicate}
                    />
                  </motion.div>
                );
              })}
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
