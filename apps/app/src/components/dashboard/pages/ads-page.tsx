import { useState, useCallback, useEffect } from "react";
import { motion } from "motion/react";
import {
  Plus, Megaphone, Loader2, BookOpen, BarChart3, Pause, Play, X as XIcon,
  RefreshCw, Upload, Trash2, Search, Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { cn } from "@/lib/utils";
import { usePaginatedApi, useMutation } from "@/hooks/use-api";
import { useFilterQuery } from "@/components/dashboard/filter-context";
import { LoadMore } from "@/components/ui/load-more";
import { CreateCampaignDialog } from "@/components/dashboard/ads/create-campaign-dialog";
import { CreateAdDialog } from "@/components/dashboard/ads/create-ad-dialog";
import { CreateAudienceDialog } from "@/components/dashboard/ads/create-audience-dialog";
import { AdAnalyticsSheet } from "@/components/dashboard/ads/ad-analytics-sheet";
import { AdAccountCombobox } from "@/components/dashboard/ads/ad-account-combobox";
import type { AccountOption } from "@/components/dashboard/account-search-combobox";

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.04 } } };
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

// --- Types ---

interface AdAccount {
  id: string;
  social_account_id: string;
  platform: string;
  platform_ad_account_id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  status: string | null;
}

interface Campaign {
  id: string;
  ad_account_id: string;
  platform: string;
  platform_campaign_id: string | null;
  name: string;
  objective: string;
  status: string;
  daily_budget_cents: number | null;
  lifetime_budget_cents: number | null;
  currency: string | null;
  start_date: string | null;
  end_date: string | null;
  is_external: boolean;
  ad_count: number;
  created_at: string;
  updated_at: string;
}

interface Ad {
  id: string;
  campaign_id: string;
  ad_account_id: string;
  platform: string;
  platform_ad_id: string | null;
  name: string;
  status: string;
  headline: string | null;
  body: string | null;
  call_to_action: string | null;
  link_url: string | null;
  image_url: string | null;
  video_url: string | null;
  boost_post_target_id: string | null;
  daily_budget_cents: number | null;
  lifetime_budget_cents: number | null;
  is_external: boolean;
  created_at: string;
  updated_at: string;
}

interface Audience {
  id: string;
  ad_account_id: string;
  platform: string;
  platform_audience_id: string | null;
  name: string;
  type: string;
  description: string | null;
  size: number | null;
  status: string | null;
  created_at: string;
  updated_at: string;
}

// --- Helpers ---

const statusConfig: Record<string, { label: string; classes: string }> = {
  draft: { label: "Draft", classes: "text-neutral-400 bg-neutral-400/10" },
  pending_review: { label: "Pending", classes: "text-blue-400 bg-blue-400/10" },
  active: { label: "Active", classes: "text-emerald-400 bg-emerald-400/10" },
  paused: { label: "Paused", classes: "text-amber-400 bg-amber-400/10" },
  completed: { label: "Completed", classes: "text-neutral-400 bg-neutral-400/10" },
  rejected: { label: "Rejected", classes: "text-red-400 bg-red-400/10" },
  cancelled: { label: "Cancelled", classes: "text-neutral-500 bg-neutral-500/10" },
};

const platformConfig: Record<string, { label: string; classes: string }> = {
  meta: { label: "Meta", classes: "text-blue-400 bg-blue-400/10" },
  google: { label: "Google", classes: "text-emerald-400 bg-emerald-400/10" },
  tiktok: { label: "TikTok", classes: "text-pink-400 bg-pink-400/10" },
  linkedin: { label: "LinkedIn", classes: "text-sky-400 bg-sky-400/10" },
  pinterest: { label: "Pinterest", classes: "text-red-400 bg-red-400/10" },
  twitter: { label: "X", classes: "text-neutral-400 bg-neutral-400/10" },
};

const audienceTypeConfig: Record<string, { label: string; classes: string }> = {
  customer_list: { label: "Customer List", classes: "text-purple-400 bg-purple-400/10" },
  website: { label: "Website", classes: "text-blue-400 bg-blue-400/10" },
  lookalike: { label: "Lookalike", classes: "text-emerald-400 bg-emerald-400/10" },
};

function Badge({ config, value }: { config: Record<string, { label: string; classes: string }>; value: string }) {
  const cfg = config[value] ?? { label: value, classes: "text-neutral-400 bg-neutral-400/10" };
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cfg.classes)}>
      {cfg.label}
    </span>
  );
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatBudget(cents: number | null, currency?: string | null) {
  if (cents == null) return "—";
  const sym = currency === "EUR" ? "\u20AC" : "$";
  return `${sym}${(cents / 100).toFixed(2)}`;
}

// --- Tab Definitions ---

const tabs = [
  { key: "ads", label: "Ads" },
  { key: "campaigns", label: "Campaigns" },
  { key: "audiences", label: "Audiences" },
  { key: "accounts", label: "Accounts" },
] as const;

const adStatuses = ["all", "active", "paused", "draft", "pending_review", "completed", "rejected", "cancelled"] as const;
const campaignStatuses = ["all", "active", "paused", "draft", "completed", "cancelled"] as const;

// --- Main Component ---

export function AdsPage({
  initialTab = "ads",
}: {
  initialTab?: "ads" | "campaigns" | "audiences" | "accounts";
} = {}) {
  const filterQuery = useFilterQuery();
  const [activeTab, setActiveTab] = useState(initialTab);

  const switchTab = (tab: typeof initialTab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  // Filters
  const [adStatus, setAdStatus] = useState("all");
  const [adSource, setAdSource] = useState("all");
  const [campaignStatus, setCampaignStatus] = useState("all");
  const [selectedAdAccountId, setSelectedAdAccountId] = useState<string>("");

  // Dialogs
  const [createAdOpen, setCreateAdOpen] = useState(false);
  const [createCampaignOpen, setCreateCampaignOpen] = useState(false);
  const [createAudienceOpen, setCreateAudienceOpen] = useState(false);
  const [boostDialogOpen, setBoostDialogOpen] = useState(false);
  const [uploadUsersOpen, setUploadUsersOpen] = useState(false);
  const [uploadAudienceId, setUploadAudienceId] = useState<string>("");
  const [analyticsAdId, setAnalyticsAdId] = useState<string | null>(null);
  const [analyticsAdName, setAnalyticsAdName] = useState("");
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverSocialId, setDiscoverSocialId] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [accountActionError, setAccountActionError] = useState<string | null>(null);
  const [accountActionSuccess, setAccountActionSuccess] = useState<string | null>(null);

  // --- Data ---
  const adsQuery = {
    ...filterQuery,
    ...(adStatus !== "all" ? { status: adStatus } : {}),
    ...(adSource !== "all" ? { source: adSource === "created" ? "internal" : "external" } : {}),
  };
  const {
    data: ads, loading: adsLoading, error: adsError, hasMore: adsHasMore,
    loadMore: adsLoadMore, loadingMore: adsLoadingMore, refetch: adsRefetch,
  } = usePaginatedApi<Ad>(activeTab === "ads" ? "ads" : null, { query: adsQuery });

  const campaignsQuery = {
    ...filterQuery,
    ...(campaignStatus !== "all" ? { status: campaignStatus } : {}),
  };
  const {
    data: campaigns, loading: campaignsLoading, error: campaignsError, hasMore: campaignsHasMore,
    loadMore: campaignsLoadMore, loadingMore: campaignsLoadingMore, refetch: campaignsRefetch,
  } = usePaginatedApi<Campaign>(activeTab === "campaigns" ? "ads/campaigns" : null, { query: campaignsQuery });

  const audiencesQuery = {
    ...(selectedAdAccountId ? { ad_account_id: selectedAdAccountId } : {}),
  };
  const {
    data: audiences, loading: audiencesLoading, error: audiencesError, hasMore: audiencesHasMore,
    loadMore: audiencesLoadMore, loadingMore: audiencesLoadingMore, refetch: audiencesRefetch,
  } = usePaginatedApi<Audience>(
    activeTab === "audiences" && selectedAdAccountId ? "ads/audiences" : null,
    { query: audiencesQuery },
  );

  const {
    data: adAccounts, loading: accountsLoading, error: accountsError,
    hasMore: accountsHasMore, loadMore: accountsLoadMore, loadingMore: accountsLoadingMore,
    refetch: accountsRefetch,
  } = usePaginatedApi<AdAccount>(
    "ads/accounts",
    { query: filterQuery },
  );

  // Set default ad account for audiences tab
  useEffect(() => {
    if (!selectedAdAccountId && adAccounts.length > 0) {
      setSelectedAdAccountId(adAccounts[0]!.id);
    }
  }, [selectedAdAccountId, adAccounts]);

  // --- Actions ---
  const { mutate: cancelAd } = useMutation("ads", "DELETE");
  const { mutate: updateCampaign } = useMutation("ads/campaigns", "PATCH");
  const { mutate: cancelCampaign } = useMutation("ads/campaigns", "DELETE");
  const { mutate: deleteAudience } = useMutation("ads/audiences", "DELETE");
  const { mutate: syncAccount, loading: syncing } = useMutation("ads/accounts", "POST");

  const handleCancelAd = useCallback(async (id: string) => {
    if (!confirm("Cancel this ad?")) return;
    await fetch(`/api/ads/${id}`, { method: "DELETE" });
    adsRefetch();
  }, [adsRefetch]);

  const handleToggleCampaign = useCallback(async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "paused" : "active";
    await fetch(`/api/ads/campaigns/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    campaignsRefetch();
  }, [campaignsRefetch]);

  const handleCancelCampaign = useCallback(async (id: string) => {
    if (!confirm("Cancel this campaign?")) return;
    await fetch(`/api/ads/campaigns/${id}`, { method: "DELETE" });
    campaignsRefetch();
  }, [campaignsRefetch]);

  const handleDeleteAudience = useCallback(async (id: string) => {
    if (!confirm("Delete this audience?")) return;
    await fetch(`/api/ads/audiences/${id}`, { method: "DELETE" });
    audiencesRefetch();
  }, [audiencesRefetch]);

  const handleSync = useCallback(async (accountId: string) => {
    setAccountActionError(null);
    setAccountActionSuccess(null);
    try {
      const res = await fetch(`/api/ads/accounts/${accountId}/sync`, { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(json?.error?.message || "Failed to sync ad account.");
      }
      const json = await res.json().catch(() => null) as {
        ads_created?: number;
        ads_updated?: number;
        metrics_updated?: number;
      } | null;
      setAccountActionSuccess(
        `Sync finished: ${json?.ads_created ?? 0} imported, ${json?.ads_updated ?? 0} updated, ${json?.metrics_updated ?? 0} metrics refreshed.`,
      );
      accountsRefetch();
    } catch (err) {
      setAccountActionError(err instanceof Error ? err.message : "Failed to sync ad account.");
    }
  }, [accountsRefetch]);

  const handleDiscoverAccounts = useCallback(async (socialAccountId: string) => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const res = await fetch(`/api/ads/accounts?social_account_id=${encodeURIComponent(socialAccountId)}`);
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(json?.error?.message || "Failed to discover ad accounts.");
      }
      accountsRefetch();
      setDiscoverOpen(false);
      setDiscoverSocialId(null);
      setDiscoverError(null);
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : "Failed to discover ad accounts.");
    } finally {
      setDiscovering(false);
    }
  }, [accountsRefetch]);

  const handleUpdateAd = useCallback(async (id: string, status: string) => {
    await fetch(`/api/ads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    adsRefetch();
  }, [adsRefetch]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Ads</h1>
          <a href="https://docs.relayapi.dev/api-reference/ads" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors">
            <BookOpen className="size-3.5" />
          </a>
        </div>
        {activeTab === "ads" && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs" onClick={() => setBoostDialogOpen(true)}>
              <Megaphone className="size-3.5" />
              Boost Post
            </Button>
            <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setCreateAdOpen(true)}>
              <Plus className="size-3.5" />
              Create Ad
            </Button>
          </div>
        )}
        {activeTab === "campaigns" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setCreateCampaignOpen(true)}>
            <Plus className="size-3.5" />
            Create Campaign
          </Button>
        )}
        {activeTab === "audiences" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setCreateAudienceOpen(true)}>
            <Plus className="size-3.5" />
            Create Audience
          </Button>
        )}
        {activeTab === "accounts" && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setDiscoverOpen(true)}>
            <Search className="size-3.5" />
            Discover Ad Accounts
          </Button>
        )}
      </div>

      {/* Tabs + filters */}
      <div className="flex items-end justify-between gap-x-4 border-b border-border">
        <div className="flex gap-4 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              className={cn(
                "pb-2 text-[13px] font-medium transition-colors whitespace-nowrap border-b-2 -mb-px",
                activeTab === tab.key
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="pb-2 shrink-0">
          <FilterBar />
        </div>
      </div>

      {/* ====== ADS TAB ====== */}
      {activeTab === "ads" && (
        <>
          {/* Status + Source filters */}
          <div className="flex flex-wrap gap-2">
            <div className="flex gap-1 flex-wrap">
              {adStatuses.map((s) => (
                <button
                  key={s}
                  onClick={() => setAdStatus(s)}
                  className={cn(
                    "px-2.5 py-1 text-xs rounded-md transition-colors",
                    adStatus === s ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s === "all" ? "All" : (statusConfig[s]?.label ?? s)}
                </button>
              ))}
            </div>
            <div className="h-6 w-px bg-border self-center" />
            <div className="flex gap-1">
              {(["all", "created", "external"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setAdSource(s)}
                  className={cn(
                    "px-2.5 py-1 text-xs rounded-md transition-colors",
                    adSource === s ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {s === "all" ? "All Sources" : s === "created" ? "Created" : "External"}
                </button>
              ))}
            </div>
          </div>

          {adsError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{adsError}</div>
          )}
          {adsLoading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : ads.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <Megaphone className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {adAccounts.length > 0 ? "No synced ads yet" : "No ads yet"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {adAccounts.length > 0
                  ? "Your ad accounts are connected, but external ads only appear after an account sync."
                  : "Create an ad or boost a published post to get started"}
              </p>
            </div>
          ) : (
            <>
              <motion.div className="rounded-md border border-border overflow-hidden" variants={stagger} initial={false} animate="visible">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-accent/10 text-xs font-medium text-muted-foreground">
                      <th className="px-4 py-2.5 text-left">Name</th>
                      <th className="px-4 py-2.5 text-left hidden md:table-cell">Platform</th>
                      <th className="px-4 py-2.5 text-left">Status</th>
                      <th className="px-4 py-2.5 text-right hidden lg:table-cell">Budget</th>
                      <th className="px-4 py-2.5 text-right hidden sm:table-cell">Created</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ads.map((ad, i) => (
                      <motion.tr
                        key={ad.id}
                        variants={fadeUp}
                        className={cn("hover:bg-accent/30 transition-colors", i !== ads.length - 1 && "border-b border-border")}
                      >
                        <td className="px-4 py-3">
                          <div className="text-[13px] font-medium">{ad.name}</div>
                          {ad.boost_post_target_id && (
                            <span className="text-[10px] text-muted-foreground">Boosted post</span>
                          )}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell"><Badge config={platformConfig} value={ad.platform} /></td>
                        <td className="px-4 py-3"><Badge config={statusConfig} value={ad.status} /></td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden lg:table-cell">
                          {ad.daily_budget_cents ? `${formatBudget(ad.daily_budget_cents)}/day` : formatBudget(ad.lifetime_budget_cents)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">{formatDate(ad.created_at)}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => { setAnalyticsAdId(ad.id); setAnalyticsAdName(ad.name); }}
                              className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                              title="View analytics"
                            >
                              <BarChart3 className="size-3.5" />
                            </button>
                            {ad.status === "active" && (
                              <button onClick={() => handleUpdateAd(ad.id, "paused")} className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" title="Pause">
                                <Pause className="size-3.5" />
                              </button>
                            )}
                            {ad.status === "paused" && (
                              <button onClick={() => handleUpdateAd(ad.id, "active")} className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground" title="Resume">
                                <Play className="size-3.5" />
                              </button>
                            )}
                            {!["completed", "rejected", "cancelled"].includes(ad.status) && (
                              <button onClick={() => handleCancelAd(ad.id)} className="p-1 rounded hover:bg-destructive/20 transition-colors text-muted-foreground hover:text-destructive" title="Cancel">
                                <XIcon className="size-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
              <LoadMore hasMore={adsHasMore} loading={adsLoadingMore} onLoadMore={adsLoadMore} count={ads.length} />
            </>
          )}
        </>
      )}

      {/* ====== CAMPAIGNS TAB ====== */}
      {activeTab === "campaigns" && (
        <>
          <div className="flex gap-1 flex-wrap">
            {campaignStatuses.map((s) => (
              <button
                key={s}
                onClick={() => setCampaignStatus(s)}
                className={cn(
                  "px-2.5 py-1 text-xs rounded-md transition-colors",
                  campaignStatus === s ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s === "all" ? "All" : (statusConfig[s]?.label ?? s)}
              </button>
            ))}
          </div>

          {campaignsError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{campaignsError}</div>
          )}
          {campaignsLoading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : campaigns.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <Megaphone className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {adAccounts.length > 0 ? "No synced campaigns yet" : "No campaigns yet"}
              </p>
              {adAccounts.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  External campaigns are imported when you sync an ad account.
                </p>
              )}
            </div>
          ) : (
            <>
              <motion.div className="rounded-md border border-border overflow-hidden" variants={stagger} initial={false} animate="visible">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-accent/10 text-xs font-medium text-muted-foreground">
                      <th className="px-4 py-2.5 text-left">Name</th>
                      <th className="px-4 py-2.5 text-left hidden md:table-cell">Platform</th>
                      <th className="px-4 py-2.5 text-left hidden lg:table-cell">Objective</th>
                      <th className="px-4 py-2.5 text-left">Status</th>
                      <th className="px-4 py-2.5 text-right hidden lg:table-cell">Budget</th>
                      <th className="px-4 py-2.5 text-right hidden md:table-cell">Ads</th>
                      <th className="px-4 py-2.5 text-right hidden sm:table-cell">Created</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((camp, i) => (
                      <motion.tr
                        key={camp.id}
                        variants={fadeUp}
                        className={cn("hover:bg-accent/30 transition-colors", i !== campaigns.length - 1 && "border-b border-border")}
                      >
                        <td className="px-4 py-3 text-[13px] font-medium">{camp.name}</td>
                        <td className="px-4 py-3 hidden md:table-cell"><Badge config={platformConfig} value={camp.platform} /></td>
                        <td className="px-4 py-3 text-xs text-muted-foreground capitalize hidden lg:table-cell">{camp.objective.replace("_", " ")}</td>
                        <td className="px-4 py-3"><Badge config={statusConfig} value={camp.status} /></td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden lg:table-cell">
                          {camp.daily_budget_cents ? `${formatBudget(camp.daily_budget_cents, camp.currency)}/day` : formatBudget(camp.lifetime_budget_cents, camp.currency)}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden md:table-cell">{camp.ad_count}</td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">{formatDate(camp.created_at)}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {(camp.status === "active" || camp.status === "paused") && (
                              <button
                                onClick={() => handleToggleCampaign(camp.id, camp.status)}
                                className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                                title={camp.status === "active" ? "Pause" : "Resume"}
                              >
                                {camp.status === "active" ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                              </button>
                            )}
                            {!["completed", "cancelled"].includes(camp.status) && (
                              <button onClick={() => handleCancelCampaign(camp.id)} className="p-1 rounded hover:bg-destructive/20 transition-colors text-muted-foreground hover:text-destructive" title="Cancel">
                                <XIcon className="size-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
              <LoadMore hasMore={campaignsHasMore} loading={campaignsLoadingMore} onLoadMore={campaignsLoadMore} count={campaigns.length} />
            </>
          )}
        </>
      )}

      {/* ====== AUDIENCES TAB ====== */}
      {activeTab === "audiences" && (
        <>
          {/* Ad account selector */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Ad Account:</label>
            <AdAccountCombobox
              value={selectedAdAccountId}
              onSelect={setSelectedAdAccountId}
              workspaceId={filterQuery.workspace_id}
              className="w-64"
            />
          </div>

          {!selectedAdAccountId ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <p className="text-sm text-muted-foreground">Select an ad account to view audiences</p>
            </div>
          ) : audiencesError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{audiencesError}</div>
          ) : audiencesLoading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : audiences.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <Megaphone className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No audiences yet</p>
            </div>
          ) : (
            <>
              <motion.div className="rounded-md border border-border overflow-hidden" variants={stagger} initial={false} animate="visible">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-accent/10 text-xs font-medium text-muted-foreground">
                      <th className="px-4 py-2.5 text-left">Name</th>
                      <th className="px-4 py-2.5 text-left hidden md:table-cell">Type</th>
                      <th className="px-4 py-2.5 text-left hidden lg:table-cell">Platform</th>
                      <th className="px-4 py-2.5 text-right hidden md:table-cell">Size</th>
                      <th className="px-4 py-2.5 text-right hidden sm:table-cell">Created</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audiences.map((aud, i) => (
                      <motion.tr
                        key={aud.id}
                        variants={fadeUp}
                        className={cn("hover:bg-accent/30 transition-colors", i !== audiences.length - 1 && "border-b border-border")}
                      >
                        <td className="px-4 py-3">
                          <div className="text-[13px] font-medium">{aud.name}</div>
                          {aud.description && <p className="text-[11px] text-muted-foreground mt-0.5">{aud.description}</p>}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell"><Badge config={audienceTypeConfig} value={aud.type} /></td>
                        <td className="px-4 py-3 hidden lg:table-cell"><Badge config={platformConfig} value={aud.platform} /></td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden md:table-cell">
                          {aud.size != null ? aud.size.toLocaleString() : "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">{formatDate(aud.created_at)}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {aud.type === "customer_list" && (
                              <button
                                onClick={() => { setUploadAudienceId(aud.id); setUploadUsersOpen(true); }}
                                className="p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                                title="Upload users"
                              >
                                <Upload className="size-3.5" />
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteAudience(aud.id)}
                              className="p-1 rounded hover:bg-destructive/20 transition-colors text-muted-foreground hover:text-destructive"
                              title="Delete"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </div>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
              <LoadMore hasMore={audiencesHasMore} loading={audiencesLoadingMore} onLoadMore={audiencesLoadMore} count={audiences.length} />
            </>
          )}
        </>
      )}

      {/* ====== ACCOUNTS TAB ====== */}
      {activeTab === "accounts" && (
        <>
          {(accountsError || accountActionError || accountActionSuccess) && (
            <>
              {accountActionSuccess && (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
                  {accountActionSuccess}
                </div>
              )}
              {(accountsError || accountActionError) && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {accountsError || accountActionError}
                </div>
              )}
            </>
          )}
          {accountsLoading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : adAccounts.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-12 text-center">
              <Megaphone className="size-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No ad accounts found</p>
              <p className="text-xs text-muted-foreground mt-1">Select a connected social account to discover its ad accounts</p>
              <Button size="sm" variant="outline" className="mt-4 gap-1.5 h-7 text-xs" onClick={() => setDiscoverOpen(true)}>
                <Search className="size-3.5" />
                Discover Ad Accounts
              </Button>
            </div>
          ) : (
            <>
            <motion.div className="rounded-md border border-border overflow-hidden" variants={stagger} initial={false} animate="visible">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-accent/10 text-xs font-medium text-muted-foreground">
                    <th className="px-4 py-2.5 text-left">Name</th>
                    <th className="px-4 py-2.5 text-left hidden md:table-cell">Platform</th>
                    <th className="px-4 py-2.5 text-left hidden lg:table-cell">Currency</th>
                    <th className="px-4 py-2.5 text-left hidden lg:table-cell">Timezone</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {adAccounts.map((acc, i) => (
                    <motion.tr
                      key={acc.id}
                      variants={fadeUp}
                      className={cn("hover:bg-accent/30 transition-colors", i !== adAccounts.length - 1 && "border-b border-border")}
                    >
                      <td className="px-4 py-3">
                        <div className="text-[13px] font-medium">{acc.name || acc.platform_ad_account_id}</div>
                        <span className="text-[10px] text-muted-foreground font-mono">{acc.platform_ad_account_id}</span>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell"><Badge config={platformConfig} value={acc.platform} /></td>
                      <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">{acc.currency || "—"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">{acc.timezone || "—"}</td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 h-7 text-xs"
                          onClick={() => handleSync(acc.id)}
                        >
                          <RefreshCw className="size-3" />
                          Sync
                        </Button>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </motion.div>
            <LoadMore hasMore={accountsHasMore} loading={accountsLoadingMore} onLoadMore={accountsLoadMore} count={adAccounts.length} />
            </>
          )}
        </>
      )}

      {/* ====== DIALOGS ====== */}

      <CreateAdDialog
        open={createAdOpen}
        onOpenChange={setCreateAdOpen}
        adAccounts={adAccounts}
        onCreated={adsRefetch}
      />
      <CreateAdDialog
        open={boostDialogOpen}
        onOpenChange={setBoostDialogOpen}
        adAccounts={adAccounts}
        onCreated={adsRefetch}
        boostMode
      />
      <CreateCampaignDialog
        open={createCampaignOpen}
        onOpenChange={setCreateCampaignOpen}
        adAccounts={adAccounts}
        onCreated={campaignsRefetch}
      />
      <CreateAudienceDialog
        open={createAudienceOpen}
        onOpenChange={setCreateAudienceOpen}
        existingAudiences={audiences.map((a) => ({ id: a.id, name: a.name }))}
        onCreated={audiencesRefetch}
      />

      {/* Upload Users Dialog */}
      <UploadUsersDialog
        open={uploadUsersOpen}
        onOpenChange={setUploadUsersOpen}
        audienceId={uploadAudienceId}
        onUploaded={audiencesRefetch}
      />

      {/* Discover Ad Accounts Dialog */}
      <DiscoverAdAccountsDialog
        open={discoverOpen}
        onOpenChange={(o) => {
          if (!o && !discovering) {
            setDiscoverOpen(false);
            setDiscoverSocialId(null);
            setDiscoverError(null);
          }
        }}
        selectedId={discoverSocialId}
        onSelect={(id) => {
          setDiscoverSocialId(id);
          setDiscoverError(null);
        }}
        onDiscover={() => discoverSocialId && handleDiscoverAccounts(discoverSocialId)}
        discovering={discovering}
        error={discoverError}
      />

      {/* Analytics Sheet */}
      <AdAnalyticsSheet
        adId={analyticsAdId}
        adName={analyticsAdName}
        open={!!analyticsAdId}
        onOpenChange={(open) => { if (!open) setAnalyticsAdId(null); }}
      />
    </div>
  );
}

// --- Upload Users Dialog (inline) ---

function UploadUsersDialog({ open, onOpenChange, audienceId, onUploaded }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audienceId: string;
  onUploaded: () => void;
}) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ added: number; invalid: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async () => {
    const lines = input.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const users = lines.map((line) => {
      if (line.includes("@")) return { email: line };
      return { phone: line };
    });
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ads/audiences/${audienceId}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ users }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || "Upload failed");
      }
      const data = await res.json();
      setResult(data);
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setInput(""); setResult(null); setError(null); } onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Users</DialogTitle>
          <DialogDescription>One email or phone number per line (max 10,000). Data is SHA-256 hashed before upload.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <textarea
            className="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
            placeholder={"user@example.com\n+15551234567"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          {result && (
            <p className="text-sm text-emerald-400">
              Added: {result.added} | Invalid: {result.invalid}
            </p>
          )}
          <Button onClick={handleUpload} disabled={loading || !input.trim()} className="w-full gap-1.5">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            {loading ? "Uploading..." : "Upload"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- Discover Ad Accounts Dialog ---

const AD_PLATFORMS = ["facebook", "instagram", "twitter", "tiktok", "linkedin", "pinterest"];

function DiscoverAdAccountsDialog({ open, onOpenChange, selectedId, onSelect, onDiscover, discovering, error }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDiscover: () => void;
  discovering: boolean;
  error: string | null;
}) {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const url = new URL("/api/accounts", window.location.origin);
    url.searchParams.set("platforms", AD_PLATFORMS.join(","));
    url.searchParams.set("limit", "50");
    fetch(url.toString())
      .then((r) => r.ok ? r.json() : null)
      .then((json) => { if (json?.data) setAccounts(json.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Discover Ad Accounts</DialogTitle>
          <DialogDescription>Select a connected social account to discover its ad accounts.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No social accounts with ads support found</p>
          ) : (
            <div className="max-h-56 overflow-y-auto rounded-md border border-border divide-y divide-border">
              {accounts.map((acc) => (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => onSelect(selectedId === acc.id ? null : acc.id)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors",
                    selectedId === acc.id ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  {acc.avatar_url ? (
                    <img src={acc.avatar_url} alt="" className="size-7 rounded-full object-cover shrink-0" />
                  ) : (
                    <div className={cn("flex size-7 items-center justify-center rounded-full text-[10px] font-bold text-white shrink-0", platformConfig[acc.platform]?.classes?.replace(/text-\S+/, "").trim() || "bg-neutral-700")}>
                      {acc.platform.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{acc.display_name || acc.username || "Account"}</div>
                    <div className="text-[11px] text-muted-foreground capitalize">{acc.platform}</div>
                  </div>
                  {selectedId === acc.id && (
                    <div className="size-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                      <svg className="size-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              {error}
            </div>
          )}
          <Button
            onClick={onDiscover}
            disabled={!selectedId || discovering}
            className="w-full gap-1.5"
          >
            {discovering ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            {discovering ? "Discovering..." : "Discover"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
