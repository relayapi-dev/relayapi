import { useState, useMemo } from "react";
import { motion } from "motion/react";
import { Home, Lock, Loader2, AlertTriangle, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApi } from "@/hooks/use-api";
import { useUsage } from "@/hooks/use-usage";
import { platformLabels, platformColors, platformAvatars } from "@/lib/platform-maps";
import { platformIcons } from "@/lib/platform-icons";
import { AnalyticsHome } from "./analytics-home";
import { AnalyticsChannel } from "./analytics-channel";
import type { InitialApiData } from "@/lib/dashboard-page";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface ChannelsResponse {
  data: ChannelSummary[];
  totals: {
    total_audience: number;
    total_impressions: number;
    total_engagement: number;
    audience_change: number | null;
    impressions_change: number | null;
    engagement_change: number | null;
  };
}

// ---------------------------------------------------------------------------
// Date range helpers
// ---------------------------------------------------------------------------

type DatePreset = "7d" | "30d" | "90d" | "year";

function getDateRange(preset: DatePreset): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  switch (preset) {
    case "7d":
      from.setDate(from.getDate() - 7);
      break;
    case "30d":
      from.setDate(from.getDate() - 30);
      break;
    case "90d":
      from.setDate(from.getDate() - 90);
      break;
    case "year":
      from.setMonth(0, 1);
      break;
  }
  return {
    from: from.toISOString().split("T")[0]!,
    to: to.toISOString().split("T")[0]!,
  };
}

const datePresetLabels: Record<DatePreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  year: "This year",
};

// ---------------------------------------------------------------------------
// Animation variants
// ---------------------------------------------------------------------------

const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const },
  },
};

function AnalyticsPageLoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Analytics</h1>
          <a
            href="https://docs.relayapi.dev/api-reference/analytics"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <BookOpen className="size-3.5" />
          </a>
        </div>
        <div className="h-7 w-32 rounded bg-muted-foreground/10 animate-pulse" />
      </div>

      <div className="sm:hidden">
        <div className="h-10 w-full rounded-md border border-border bg-muted-foreground/10 animate-pulse" />
      </div>

      <div className="flex gap-6">
        <nav className="hidden sm:block w-[200px] shrink-0">
          <div className="space-y-1">
            <div className="h-9 w-full rounded-md bg-muted-foreground/10 animate-pulse" />
            <div className="h-3 w-16 rounded bg-muted-foreground/10 animate-pulse mt-4 mb-2" />
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex items-center gap-2 px-2.5 py-2">
                <div className="size-5 rounded-full bg-muted-foreground/10 animate-pulse" />
                <div className="h-3 w-24 rounded bg-muted-foreground/10 animate-pulse" />
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1">
          <AnalyticsHome
            channels={[]}
            totals={{
              total_audience: 0,
              total_impressions: 0,
              total_engagement: 0,
              audience_change: null,
              impressions_change: null,
              engagement_change: null,
            }}
            loading
            onSelectChannel={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AnalyticsPageNewProps {
  initialChannelsData?: InitialApiData<ChannelsResponse>;
  initialDatePreset?: DatePreset;
  initialSelectedChannel?: string | null;
}

export function AnalyticsPageNew({
  initialChannelsData,
  initialDatePreset = "30d",
  initialSelectedChannel = null,
}: AnalyticsPageNewProps = {}) {
  // -- Usage / pro gate -----------------------------------------------------

  const { usage, loading: usageLoading } = useUsage();
  const isPro = usage?.plan === "pro";

  // -- URL-driven state: selected channel -----------------------------------

  const [selectedChannel, setSelectedChannel] = useState<string | null>(initialSelectedChannel);

  const selectChannel = (channelId: string | null) => {
    setSelectedChannel(channelId);
    const url = new URL(window.location.href);
    if (channelId) {
      url.searchParams.set("channel", channelId);
    } else {
      url.searchParams.delete("channel");
    }
    window.history.replaceState({}, "", url.toString());
  };

  // -- URL-driven state: date range -----------------------------------------

  const [datePreset, setDatePreset] = useState<DatePreset>(initialDatePreset);

  const dateRange = useMemo(() => getDateRange(datePreset), [datePreset]);

  const changeDatePreset = (preset: DatePreset) => {
    setDatePreset(preset);
    const range = getDateRange(preset);
    const url = new URL(window.location.href);
    url.searchParams.set("from", range.from);
    url.searchParams.set("to", range.to);
    window.history.replaceState({}, "", url.toString());
  };

  // -- Fetch channels -------------------------------------------------------

  const { data: channelsResponse, loading: channelsLoading } = useApi<ChannelsResponse>(
    isPro ? "analytics/channels" : null,
    {
      initialData: initialChannelsData?.data,
      initialRequestKey: initialChannelsData?.requestKey,
      query: { from_date: dateRange.from, to_date: dateRange.to },
    },
  );

  const channels = channelsResponse?.data ?? [];
  const totals = channelsResponse?.totals ?? {
    total_audience: 0,
    total_impressions: 0,
    total_engagement: 0,
    audience_change: null,
    impressions_change: null,
    engagement_change: null,
  };

  const selectedChannelData = useMemo(
    () => channels.find((c) => c.account_id === selectedChannel) ?? null,
    [channels, selectedChannel],
  );

  // -- Pro gate UI ----------------------------------------------------------

  if (usageLoading && usage === null) {
    return <AnalyticsPageLoadingSkeleton />;
  }

  if (!isPro) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Analytics</h1>
          <a
            href="https://docs.relayapi.dev/api-reference/analytics"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <BookOpen className="size-3.5" />
          </a>
        </div>
        <div className="rounded-md border border-border p-12 text-center">
          <Lock className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-medium">Pro Feature</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Upgrade to the Pro plan to access cross-platform analytics,
            engagement metrics, and performance insights.
          </p>
          <button className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
            Upgrade to Pro
          </button>
        </div>
      </div>
    );
  }

  // -- Main layout ----------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Analytics</h1>
          <a
            href="https://docs.relayapi.dev/api-reference/analytics"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <BookOpen className="size-3.5" />
          </a>
        </div>
        <select
          value={datePreset}
          onChange={(e) => changeDatePreset(e.target.value as DatePreset)}
          className="rounded-md border border-border bg-transparent pl-2.5 pr-7 py-1 text-xs text-foreground"
        >
          {(Object.entries(datePresetLabels) as [DatePreset, string][]).map(
            ([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ),
          )}
        </select>
      </div>

      {/* Mobile channel selector (visible below sm) */}
      <div className="sm:hidden">
        <select
          value={selectedChannel ?? ""}
          onChange={(e) =>
            selectChannel(e.target.value === "" ? null : e.target.value)
          }
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-2 text-sm text-foreground"
        >
          <option value="">Home</option>
          {channels.map((ch) => (
            <option key={ch.account_id} value={ch.account_id}>
              {ch.display_name || ch.username || platformLabels[ch.platform] || ch.platform}
              {ch.needs_reconnect ? " (reconnect)" : ""}
            </option>
          ))}
        </select>
      </div>

      {/* Body: sidebar + content */}
      <div className="flex gap-6">
        {/* Sidebar (hidden on mobile) */}
        <nav className="hidden sm:block w-[200px] shrink-0">
          <motion.div
            className="space-y-1"
            initial="hidden"
            animate="visible"
            variants={{
              hidden: {},
              visible: { transition: { staggerChildren: 0.03 } },
            }}
          >
            {/* Home item */}
            <motion.button
              variants={fadeUp}
              onClick={() => selectChannel(null)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                selectedChannel === null
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              )}
            >
              <Home className="size-4" />
              Home
            </motion.button>

            {/* Section header */}
            <motion.p
              variants={fadeUp}
              className="px-2.5 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Channels
            </motion.p>

            {/* Loading skeleton */}
            {channelsLoading &&
              channels.length === 0 &&
              Array.from({ length: 3 }).map((_, i) => (
                <motion.div
                  key={i}
                  variants={fadeUp}
                  className="flex items-center gap-2 px-2.5 py-2"
                >
                  <div className="size-5 rounded-full bg-muted-foreground/10 animate-pulse" />
                  <div className="h-3 w-24 rounded bg-muted-foreground/10 animate-pulse" />
                </motion.div>
              ))}

            {/* Channel items */}
            {channels.map((ch) => (
              <motion.button
                key={ch.account_id}
                variants={fadeUp}
                onClick={() => selectChannel(ch.account_id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
                  selectedChannel === ch.account_id
                    ? "bg-muted text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                )}
              >
                {/* Platform avatar */}
                <div
                  className={cn(
                    "size-5 shrink-0 rounded-full flex items-center justify-center text-[8px] font-bold text-white [&_svg]:size-2.5",
                    platformColors[ch.platform] || "bg-neutral-700",
                  )}
                >
                  {platformIcons[ch.platform] ||
                    platformAvatars[ch.platform] ||
                    "?"}
                </div>

                {/* Name */}
                <span className="truncate">
                  {ch.display_name || ch.username || platformLabels[ch.platform] || ch.platform}
                </span>

                {/* Reconnect warning */}
                {ch.needs_reconnect && (
                  <AlertTriangle className="size-3 shrink-0 text-amber-400" />
                )}
              </motion.button>
            ))}
          </motion.div>
        </nav>

        {/* Content area */}
        <div className="min-w-0 flex-1">
          {channelsLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : selectedChannel === null ? (
            <AnalyticsHome
              channels={channels}
              totals={totals}
              loading={false}
              onSelectChannel={selectChannel}
            />
          ) : selectedChannelData ? (
            <AnalyticsChannel
              accountId={selectedChannelData.account_id}
              platform={selectedChannelData.platform}
              displayName={selectedChannelData.display_name}
              username={selectedChannelData.username}
              avatarUrl={selectedChannelData.avatar_url}
              dateRange={dateRange}
              needsReconnect={selectedChannelData.needs_reconnect}
            />
          ) : (
            // Channel not found — fall back to home
            <AnalyticsHome
              channels={channels}
              totals={totals}
              loading={false}
              onSelectChannel={selectChannel}
            />
          )}
        </div>
      </div>
    </div>
  );
}
