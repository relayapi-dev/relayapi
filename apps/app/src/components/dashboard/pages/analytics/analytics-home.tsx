import { motion } from "motion/react";
import { Flame, TrendingUp, TrendingDown, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStreak } from "@/hooks/use-streak";
import { platformLabels, platformColors, platformAvatars } from "@/lib/platform-maps";
import { platformIcons } from "@/lib/platform-icons";

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

interface ChannelSummary {
  account_id: string;
  platform: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  followers: number | null;
  impressions: number | null;
  engagement_rate: number | null;
  has_analytics: boolean;
  needs_reconnect: boolean;
}

interface AnalyticsHomeProps {
  channels: ChannelSummary[];
  totals: {
    total_audience: number;
    total_impressions: number;
    total_engagement: number;
    audience_change: number | null;
    impressions_change: number | null;
    engagement_change: number | null;
  };
  loading: boolean;
  onSelectChannel: (accountId: string) => void;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function ChangeBadge({ change }: { change: number | null }) {
  if (change === null || change === undefined) return null;
  const up = change >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium",
        up ? "text-emerald-400" : "text-red-400",
      )}
    >
      {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
      {up ? "+" : ""}
      {change}%
    </span>
  );
}

function SkeletonTotals() {
  return (
    <div className="rounded-md border border-border p-5">
      <div className="h-4 w-16 rounded bg-muted-foreground/10 animate-pulse mb-4" />
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-3 w-24 rounded bg-muted-foreground/10 animate-pulse" />
            <div className="h-7 w-20 rounded bg-muted-foreground/10 animate-pulse" />
            <div className="h-3 w-14 rounded bg-muted-foreground/10 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

function SkeletonTable() {
  return (
    <div className="rounded-md border border-border p-5">
      <div className="h-4 w-44 rounded bg-muted-foreground/10 animate-pulse mb-4" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="size-8 rounded-full bg-muted-foreground/10 animate-pulse" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-32 rounded bg-muted-foreground/10 animate-pulse" />
              <div className="h-2.5 w-20 rounded bg-muted-foreground/10 animate-pulse" />
            </div>
            <div className="h-3 w-16 rounded bg-muted-foreground/10 animate-pulse" />
            <div className="h-3 w-16 rounded bg-muted-foreground/10 animate-pulse" />
            <div className="h-3 w-16 rounded bg-muted-foreground/10 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}

function StreakCard() {
  const { streak, loading } = useStreak();

  if (loading) {
    return (
      <div className="rounded-md border border-border p-5">
        <div className="h-4 w-28 rounded bg-muted-foreground/10 animate-pulse mb-4" />
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-3 w-20 rounded bg-muted-foreground/10 animate-pulse" />
              <div className="h-7 w-14 rounded bg-muted-foreground/10 animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!streak) return null;

  const hoursRemaining = streak.hours_remaining;
  const isUrgent = hoursRemaining != null && hoursRemaining < 2;
  const startedAt = streak.streak_started_at
    ? new Date(streak.streak_started_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <div className="rounded-md border border-border p-5">
      <div className="flex items-center gap-2 mb-4">
        <Flame
          className={cn(
            "size-4",
            streak.active
              ? isUrgent
                ? "text-red-400 animate-pulse"
                : "text-amber-400"
              : "text-muted-foreground",
          )}
        />
        <h3 className="text-[13px] font-medium">Posting Streak</h3>
      </div>

      {streak.active ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <p className="text-xs text-muted-foreground">Current Streak</p>
            <p className="mt-1 text-2xl font-semibold text-amber-400">
              {streak.current_streak_days}d
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Best Streak</p>
            <p className="mt-1 text-2xl font-semibold">
              {streak.best_streak_days}d
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Started</p>
            <p className="mt-1 text-lg font-medium text-muted-foreground">
              {startedAt}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Time Remaining</p>
            <p
              className={cn(
                "mt-1 text-lg font-medium",
                isUrgent ? "text-red-400" : "text-muted-foreground",
              )}
            >
              {hoursRemaining != null
                ? hoursRemaining >= 1
                  ? `${Math.floor(hoursRemaining)}h ${Math.round((hoursRemaining % 1) * 60)}m`
                  : `${Math.round(hoursRemaining * 60)}m`
                : "\u2014"}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <p className="text-sm text-muted-foreground">
              No active streak.{" "}
              {streak.best_streak_days > 0 && (
                <span>
                  Your best was <strong>{streak.best_streak_days} days</strong>.{" "}
                </span>
              )}
              Publish a post to start one!
            </p>
          </div>
          {streak.total_streaks_broken > 0 && (
            <p className="text-xs text-muted-foreground">
              Streaks broken: {streak.total_streaks_broken}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function AnalyticsHome({
  channels,
  totals,
  loading,
  onSelectChannel,
}: AnalyticsHomeProps) {
  if (loading) {
    return (
      <div className="space-y-6">
        <SkeletonTotals />
        <SkeletonTable />
      </div>
    );
  }

  const sortedChannels = [...channels].sort(
    (a, b) => (b.followers ?? 0) - (a.followers ?? 0),
  );

  const totalMetrics = [
    {
      label: "Total Audience",
      value: formatNumber(totals.total_audience),
      change: totals.audience_change,
    },
    {
      label: "Total Impressions",
      value: formatNumber(totals.total_impressions),
      change: totals.impressions_change,
    },
    {
      label: "Total Engagement",
      value: formatNumber(totals.total_engagement),
      change: totals.engagement_change,
    },
  ];

  return (
    <motion.div
      className="space-y-6"
      variants={stagger}
      initial="hidden"
      animate="visible"
    >
      {/* Totals Section */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border p-5"
      >
        <h3 className="text-[13px] font-medium mb-4">Totals</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          {totalMetrics.map((m) => (
            <div key={m.label}>
              <p className="text-xs text-muted-foreground">{m.label}</p>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-semibold">{m.value}</span>
                <ChangeBadge change={m.change} />
              </div>
            </div>
          ))}
        </div>
      </motion.div>

      {/* Posting Streak */}
      <motion.div variants={fadeUp}>
        <StreakCard />
      </motion.div>

      {/* Social Channels Overview */}
      <motion.div
        variants={fadeUp}
        className="rounded-md border border-border p-5"
      >
        <h3 className="text-[13px] font-medium mb-4">
          Social channels overview
        </h3>

        {sortedChannels.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No channels connected yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="pb-2 pr-4 text-left font-medium">Profiles</th>
                  <th className="pb-2 px-4 text-right font-medium">
                    Followers
                  </th>
                  <th className="pb-2 px-4 text-right font-medium">
                    Impressions
                  </th>
                  <th className="pb-2 pl-4 text-right font-medium">
                    Engagement Rate
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedChannels.map((channel) => (
                  <tr
                    key={channel.account_id}
                    onClick={() => onSelectChannel(channel.account_id)}
                    className="border-b border-border last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-3">
                        {/* Avatar */}
                        <div className="relative">
                          {channel.avatar_url ? (
                            <img
                              src={channel.avatar_url}
                              alt=""
                              className="size-8 rounded-full object-cover"
                            />
                          ) : (
                            <div
                              className={cn(
                                "size-8 rounded-full flex items-center justify-center text-[10px] font-bold text-white",
                                platformColors[channel.platform] ||
                                  "bg-neutral-700",
                              )}
                            >
                              {platformAvatars[channel.platform] || "?"}
                            </div>
                          )}
                          {/* Platform icon badge */}
                          <div
                            className={cn(
                              "absolute -bottom-0.5 -right-0.5 size-4 rounded-full flex items-center justify-center text-white [&_svg]:size-2.5",
                              platformColors[channel.platform] ||
                                "bg-neutral-700",
                            )}
                          >
                            {platformIcons[channel.platform]}
                          </div>
                        </div>

                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {channel.display_name ||
                              channel.username ||
                              "Unknown"}
                          </p>
                          <div className="flex items-center gap-1.5">
                            <p className="text-xs text-muted-foreground truncate">
                              {platformLabels[channel.platform] ||
                                channel.platform}
                            </p>
                            {channel.needs_reconnect && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
                                <AlertCircle className="size-2.5" />
                                Reconnect
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="py-3 px-4 text-right text-muted-foreground">
                      {channel.has_analytics && channel.followers !== null
                        ? formatNumber(channel.followers)
                        : "\u2014"}
                    </td>

                    <td className="py-3 px-4 text-right text-muted-foreground">
                      {channel.has_analytics && channel.impressions !== null
                        ? formatNumber(channel.impressions)
                        : "\u2014"}
                    </td>

                    <td className="py-3 pl-4 text-right text-muted-foreground">
                      {channel.has_analytics &&
                      channel.engagement_rate !== null
                        ? `${channel.engagement_rate.toFixed(1)}%`
                        : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
