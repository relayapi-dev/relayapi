import { useState, useMemo } from "react";
import { motion } from "motion/react";
import {
  TrendingUp,
  TrendingDown,
  Loader2,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useApi } from "@/hooks/use-api";
import { platformLabels } from "@/lib/platform-maps";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnalyticsChannelProps {
  accountId: string;
  platform: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  dateRange: { from: string; to: string };
  needsReconnect: boolean;
}

interface PlatformOverview {
  followers: number | null;
  follower_change: number | null;
  impressions: number | null;
  impression_change: number | null;
  engagement: number | null;
  engagement_change: number | null;
  engagement_rate: number | null;
  posts_count: number | null;
  reach: number | null;
  reach_change: number | null;
  platform_specific: Record<string, number | string | null>;
}

interface PlatformPostMetrics {
  platform_post_id: string;
  content: string | null;
  published_at: string;
  media_url: string | null;
  media_type: string | null;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  engagement_rate: number;
  platform_url: string | null;
}

interface PlatformAudienceResponse {
  top_cities: { name: string; count: number }[];
  top_countries: { code: string; name: string; count: number }[];
  age_gender: {
    age_range: string;
    male: number;
    female: number;
    other: number;
  }[];
  available: boolean;
}

interface DailyMetricPoint {
  date: string;
  impressions: number;
  engagement: number;
  reach: number;
  followers: number;
}

// ---------------------------------------------------------------------------
// Animation variants (matching analytics-page.tsx)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_AUDIENCE_PLATFORMS = new Set([
  "twitter",
  "tiktok",
  "pinterest",
  "googlebusiness",
]);

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

type PostSortKey = "impressions" | "reach" | "engagement_rate";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AnalyticsChannel({
  accountId,
  platform,
  displayName,
  username,
  avatarUrl,
  dateRange,
  needsReconnect,
}: AnalyticsChannelProps) {
  const hasAudience = !NO_AUDIENCE_PLATFORMS.has(platform);
  const tabs = hasAudience
    ? (["overview", "posts", "audience"] as const)
    : (["overview", "posts"] as const);
  type Tab = (typeof tabs)[number];

  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [postSort, setPostSort] = useState<PostSortKey>("impressions");

  // ---- Data fetching -------------------------------------------------------

  const { data: overview, loading: overviewLoading, errorCode: overviewErrorCode } =
    useApi<PlatformOverview>("analytics/platform/overview", {
      query: {
        account_id: accountId,
        from_date: dateRange.from,
        to_date: dateRange.to,
      },
    });

  const { data: postsData, loading: postsLoading, error: postsError, errorCode: postsErrorCode } = useApi<{
    data: PlatformPostMetrics[];
  }>(activeTab === "posts" ? "analytics/platform/posts" : null, {
    query: {
      account_id: accountId,
      from_date: dateRange.from,
      to_date: dateRange.to,
      limit: "50",
    },
  });

  const { data: audience, loading: audienceLoading } =
    useApi<PlatformAudienceResponse>(
      activeTab === "audience" ? "analytics/platform/audience" : null,
      {
        query: {
          account_id: accountId,
          from_date: dateRange.from,
          to_date: dateRange.to,
        },
      },
    );

  const { data: dailyData, loading: dailyLoading } = useApi<{
    data: DailyMetricPoint[];
  }>("analytics/platform/daily", {
    query: {
      account_id: accountId,
      from_date: dateRange.from,
      to_date: dateRange.to,
    },
  });

  // ---- Derived data --------------------------------------------------------

  const chartData = dailyData?.data ?? [];
  const maxEngagement = Math.max(...chartData.map((d) => d.engagement), 1);
  const dailyAvg =
    chartData.length > 0
      ? Math.round(
          chartData.reduce((s, d) => s + d.engagement, 0) / chartData.length,
        )
      : 0;

  const posts = useMemo(() => {
    const list = [...(postsData?.data ?? [])];
    list.sort((a, b) => b[postSort] - a[postSort]);
    return list;
  }, [postsData, postSort]);

  const postTotals = useMemo(() => {
    const p = postsData?.data ?? [];
    return {
      count: p.length,
      likes: p.reduce((s, x) => s + x.likes, 0),
      comments: p.reduce((s, x) => s + x.comments, 0),
      shares: p.reduce((s, x) => s + x.shares, 0),
      avgEngRate:
        p.length > 0
          ? p.reduce((s, x) => s + x.engagement_rate, 0) / p.length
          : 0,
    };
  }, [postsData]);

  // ---- Reconnect banner ----------------------------------------------------

  const apiNeedsReconnect =
    overviewErrorCode === "TOKEN_EXPIRED" ||
    overviewErrorCode === "MISSING_PERMISSIONS" ||
    postsErrorCode === "TOKEN_EXPIRED" ||
    postsErrorCode === "MISSING_PERMISSIONS";

  if (needsReconnect || apiNeedsReconnect) {
    return (
      <div className="space-y-6">
        <ChannelHeader
          platform={platform}
          displayName={displayName}
          username={username}
          avatarUrl={avatarUrl}
        />
        <div className="rounded-md border border-border bg-amber-500/5 p-5 flex items-center gap-3">
          <AlertCircle className="size-5 text-amber-500 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">
              Reconnect {platformLabels[platform] ?? platform} to enable
              analytics
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Your connection has expired or was revoked. Reconnect to resume
              data collection.
            </p>
          </div>
          <a
            href="/app/connections"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Reconnect
          </a>
        </div>
      </div>
    );
  }

  // ---- Loading state -------------------------------------------------------

  const isInitialLoading = overviewLoading && dailyLoading;

  if (isInitialLoading) {
    return (
      <div className="space-y-6">
        <ChannelHeader
          platform={platform}
          displayName={displayName}
          username={username}
          avatarUrl={avatarUrl}
        />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // ---- Render --------------------------------------------------------------

  return (
    <div className="space-y-6">
      <ChannelHeader
        platform={platform}
        displayName={displayName}
        username={username}
        avatarUrl={avatarUrl}
      />

      {/* Tab bar */}
      <div className="border-b border-border">
        <div className="flex gap-4 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "pb-2 text-[13px] font-medium transition-colors whitespace-nowrap border-b-2 -mb-px capitalize",
                activeTab === tab
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* ===== Overview Tab ===== */}
      {activeTab === "overview" && (
        <>
          {/* Performance cards */}
          <motion.div
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            variants={stagger}
            initial="hidden"
            animate="visible"
          >
            <MetricCard
              label="Followers"
              value={
                overview?.followers != null
                  ? formatNumber(overview.followers)
                  : "--"
              }
              change={overview?.follower_change}
            />
            <MetricCard
              label="Impressions"
              value={
                overview?.impressions != null
                  ? formatNumber(overview.impressions)
                  : "--"
              }
              change={overview?.impression_change}
            />
            <MetricCard
              label="Engagement"
              value={
                overview?.engagement != null
                  ? formatNumber(overview.engagement)
                  : "--"
              }
              change={overview?.engagement_change}
            />
            <MetricCard
              label="Engagement Rate"
              value={
                overview?.engagement_rate != null
                  ? `${overview.engagement_rate.toFixed(1)}%`
                  : "--"
              }
              change={null}
            />
          </motion.div>

          {/* Daily engagement chart */}
          {chartData.length > 0 && (
            <motion.div
              className="rounded-md border border-border p-5"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.15,
                delay: 0.12,
                ease: [0.32, 0.72, 0, 1],
              }}
            >
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-[13px] font-medium">
                    Average engagements
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatNumber(dailyAvg)} per day
                  </p>
                </div>
                <div className="flex gap-4 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-primary" />
                    Engagement
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                <div className="flex h-52 items-end gap-2" style={{ minWidth: `${chartData.length * 32}px` }}>
                  {chartData.map((d) => (
                    <div
                      key={d.date}
                      className="flex flex-1 flex-col items-center gap-2"
                    >
                      <div className="relative w-full flex flex-col items-center gap-0.5">
                        <div
                          className="w-full max-w-8 rounded-t-md bg-primary/20 hover:bg-primary/40 transition-colors cursor-pointer"
                          style={{
                            height: `${(d.engagement / maxEngagement) * 180}px`,
                          }}
                        />
                      </div>
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                        {formatDate(d.date)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          )}

          {chartData.length === 0 && !dailyLoading && (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <p className="text-sm text-muted-foreground">
                No daily data available for this period
              </p>
            </div>
          )}
        </>
      )}

      {/* ===== Posts Tab ===== */}
      {activeTab === "posts" && (
        <>
          {postsLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Post summary cards */}
              <motion.div
                className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
                variants={stagger}
                initial="hidden"
                animate="visible"
              >
                <MetricCard
                  label="Total Posts"
                  value={postTotals.count.toLocaleString()}
                  change={null}
                />
                <MetricCard
                  label="Total Likes"
                  value={formatNumber(postTotals.likes)}
                  change={null}
                />
                <MetricCard
                  label="Total Comments"
                  value={formatNumber(postTotals.comments)}
                  change={null}
                />
                <MetricCard
                  label="Total Shares"
                  value={formatNumber(postTotals.shares)}
                  change={null}
                />
                <MetricCard
                  label="Avg Engagement Rate"
                  value={`${postTotals.avgEngRate.toFixed(1)}%`}
                  change={null}
                />
              </motion.div>

              {posts.length >= 50 && (
                <p className="text-xs text-muted-foreground">
                  Showing top 50 posts. Narrow the date range to see more.
                </p>
              )}

              {/* Post insights table */}
              {posts.length > 0 ? (
                <motion.div
                  className="rounded-md border border-border overflow-x-auto"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.15,
                    delay: 0.08,
                    ease: [0.32, 0.72, 0, 1],
                  }}
                >
                  <div className="min-w-[540px]">
                  <div className="px-5 py-3 border-b border-border">
                    <h3 className="text-[13px] font-medium">Post Insights</h3>
                  </div>

                  {/* Table header */}
                  <div className="grid grid-cols-[1fr_100px_100px_100px_80px] gap-2 px-5 py-2 border-b border-border text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    <span>Post</span>
                    <SortButton
                      label="Impressions"
                      sortKey="impressions"
                      current={postSort}
                      onSort={setPostSort}
                    />
                    <SortButton
                      label="Reach"
                      sortKey="reach"
                      current={postSort}
                      onSort={setPostSort}
                    />
                    <SortButton
                      label="Eng. Rate"
                      sortKey="engagement_rate"
                      current={postSort}
                      onSort={setPostSort}
                    />
                    <span className="text-right">Clicks</span>
                  </div>

                  {/* Rows */}
                  {posts.map((post) => (
                    <div
                      key={post.platform_post_id}
                      className="grid grid-cols-[1fr_100px_100px_100px_80px] gap-2 px-5 py-3 border-b border-border last:border-b-0 items-center hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {post.media_url && (
                          <img
                            src={post.media_url}
                            alt=""
                            className="size-10 rounded-md object-cover shrink-0 border border-border"
                          />
                        )}
                        <div className="min-w-0">
                          <p className="text-xs text-muted-foreground">
                            {formatDate(post.published_at)}
                          </p>
                          <p className="text-sm truncate">
                            {post.content
                              ? truncate(post.content, 120)
                              : "No content"}
                          </p>
                        </div>
                        {post.platform_url && (
                          <a
                            href={post.platform_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <ExternalLink className="size-3.5" />
                          </a>
                        )}
                      </div>
                      <span className="text-sm tabular-nums">
                        {formatNumber(post.impressions)}
                      </span>
                      <span className="text-sm tabular-nums">
                        {formatNumber(post.reach)}
                      </span>
                      <span className="text-sm tabular-nums">
                        {post.engagement_rate.toFixed(1)}%
                      </span>
                      <span className="text-sm tabular-nums text-right">
                        {formatNumber(post.clicks)}
                      </span>
                    </div>
                  ))}
                  </div>
                </motion.div>
              ) : postsError && postsErrorCode === "API_ERROR" ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-12 text-center">
                  <p className="text-sm text-destructive">
                    {postsError}
                  </p>
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-border p-12 text-center">
                  <p className="text-sm text-muted-foreground">
                    No posts found for this period
                  </p>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ===== Audience Tab ===== */}
      {activeTab === "audience" && (
        <>
          {audienceLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : audience?.available === false ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <AlertCircle className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm font-medium">
                Audience data not available for this platform
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {platformLabels[platform] ?? platform} does not provide audience
                demographic data through its API.
              </p>
            </div>
          ) : (
            <motion.div
              className="space-y-6"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.15,
                ease: [0.32, 0.72, 0, 1],
              }}
            >
              {/* Top Cities */}
              {audience?.top_cities && audience.top_cities.length > 0 && (
                <div className="rounded-md border border-border p-5">
                  <h3 className="text-[13px] font-medium mb-4">Top cities</h3>
                  <HorizontalBarList
                    items={audience.top_cities.map((c) => ({
                      label: c.name,
                      value: c.count,
                    }))}
                  />
                </div>
              )}

              {/* Top Countries */}
              {audience?.top_countries && audience.top_countries.length > 0 && (
                <div className="rounded-md border border-border p-5">
                  <h3 className="text-[13px] font-medium mb-4">
                    Top countries
                  </h3>
                  <HorizontalBarList
                    items={audience.top_countries.map((c) => ({
                      label: c.name,
                      value: c.count,
                    }))}
                  />
                </div>
              )}

              {/* Age & Gender */}
              {audience?.age_gender && audience.age_gender.length > 0 && (
                <div className="rounded-md border border-border p-5">
                  <h3 className="text-[13px] font-medium mb-4">
                    Age &amp; Gender
                  </h3>
                  <div className="flex gap-4 text-xs text-muted-foreground mb-4">
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-blue-500" />
                      Male
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-pink-500" />
                      Female
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-gray-500" />
                      Other
                    </span>
                  </div>
                  <AgeGenderChart data={audience.age_gender} />
                </div>
              )}

              {/* Empty state */}
              {(!audience?.top_cities || audience.top_cities.length === 0) &&
                (!audience?.top_countries ||
                  audience.top_countries.length === 0) &&
                (!audience?.age_gender ||
                  audience.age_gender.length === 0) && (
                  <div className="rounded-md border border-dashed border-border p-12 text-center">
                    <p className="text-sm text-muted-foreground">
                      No audience data available for this period
                    </p>
                  </div>
                )}
            </motion.div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ChannelHeader({
  platform,
  displayName,
  username,
  avatarUrl,
}: {
  platform: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
}) {
  return (
    <div className="flex items-center gap-3">
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className="size-9 rounded-full border border-border object-cover"
        />
      ) : (
        <div className="size-9 rounded-full border border-border bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
          {(displayName ?? platform).charAt(0).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <h2 className="text-sm font-medium truncate">
          {displayName ?? platformLabels[platform] ?? platform}
        </h2>
        {username && (
          <p className="text-xs text-muted-foreground truncate">@{username}</p>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change: number | null | undefined;
}) {
  const up = (change ?? 0) >= 0;
  return (
    <motion.div variants={fadeUp} className="rounded-md border border-border p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold">{value}</span>
        {change != null && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-xs font-medium",
              up ? "text-emerald-400" : "text-red-400",
            )}
          >
            {up ? (
              <TrendingUp className="size-3" />
            ) : (
              <TrendingDown className="size-3" />
            )}
            {up ? "+" : ""}
            {change}%
          </span>
        )}
      </div>
    </motion.div>
  );
}

function SortButton({
  label,
  sortKey,
  current,
  onSort,
}: {
  label: string;
  sortKey: PostSortKey;
  current: PostSortKey;
  onSort: (key: PostSortKey) => void;
}) {
  return (
    <button
      onClick={() => onSort(sortKey)}
      className={cn(
        "text-left hover:text-foreground transition-colors",
        current === sortKey ? "text-foreground" : "",
      )}
    >
      {label}
      {current === sortKey && " \u2193"}
    </button>
  );
}

function HorizontalBarList({
  items,
}: {
  items: { label: string; value: number }[];
}) {
  const maxVal = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="space-y-2">
      {items.map((item, idx) => (
        <div key={item.label} className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground w-5 text-right shrink-0">
            {idx + 1}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm truncate">{item.label}</span>
              <span className="text-xs text-muted-foreground tabular-nums ml-2 shrink-0">
                {formatNumber(item.value)}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary/60"
                style={{ width: `${(item.value / maxVal) * 100}%` }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AgeGenderChart({
  data,
}: {
  data: { age_range: string; male: number; female: number; other: number }[];
}) {
  const maxVal = Math.max(
    ...data.flatMap((d) => [d.male, d.female, d.other]),
    1,
  );
  return (
    <div className="space-y-3">
      {data.map((row) => (
        <div key={row.age_range} className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            {row.age_range}
          </span>
          <div className="flex items-center gap-2">
            <div className="flex-1 flex gap-1">
              <div
                className="h-4 rounded-sm bg-blue-500/70"
                style={{ width: `${(row.male / maxVal) * 100}%` }}
                title={`Male: ${row.male}`}
              />
              <div
                className="h-4 rounded-sm bg-pink-500/70"
                style={{ width: `${(row.female / maxVal) * 100}%` }}
                title={`Female: ${row.female}`}
              />
              {row.other > 0 && (
                <div
                  className="h-4 rounded-sm bg-gray-500/70"
                  style={{ width: `${(row.other / maxVal) * 100}%` }}
                  title={`Other: ${row.other}`}
                />
              )}
            </div>
            <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 w-16 text-right">
              {formatNumber(row.male + row.female + row.other)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
