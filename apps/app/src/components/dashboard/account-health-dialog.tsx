import { useState } from "react";
import { Loader2, CheckCircle2, XCircle, Key, Shield, RefreshCw, AlertTriangle, Clock, ChevronDown, ChevronUp, Copy, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { useApi, useMutation } from "@/hooks/use-api";
import { platformLabels, platformColors, platformAvatars } from "@/lib/platform-maps";
import { categorizeScopeList, getExpectedScopes, hasPostingCapability, hasAnalyticsCapability } from "@/lib/platform-scopes";
import { cn } from "@/lib/utils";

interface Account {
  id: string;
  platform: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

interface HealthData {
  id: string;
  platform: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  healthy: boolean;
  token_expires_at: string | null;
  scopes: string[];
  error?: { code: string; message: string };
  sync?: {
    enabled: boolean;
    last_sync_at: string | null;
    next_sync_at: string | null;
    total_posts_synced: number;
    total_sync_runs: number;
    last_error: string | null;
    last_error_at: string | null;
    consecutive_errors: number;
    rate_limit_reset_at: string | null;
  } | null;
}

interface AccountHealthDialogProps {
  account: Account | null;
  onOpenChange: (open: boolean) => void;
}

type Tone = "ok" | "warn" | "danger";

const TONES: Record<Tone, { hero: string; iconWrap: string; icon: string; title: string; dot: string }> = {
  ok: {
    hero: "border-emerald-500/20 bg-emerald-500/5",
    iconWrap: "bg-emerald-500/15",
    icon: "text-emerald-600",
    title: "text-emerald-700",
    dot: "bg-emerald-500",
  },
  warn: {
    hero: "border-amber-500/20 bg-amber-500/5",
    iconWrap: "bg-amber-500/15",
    icon: "text-amber-600",
    title: "text-amber-700",
    dot: "bg-amber-500",
  },
  danger: {
    hero: "border-destructive/20 bg-destructive/5",
    iconWrap: "bg-destructive/15",
    icon: "text-destructive",
    title: "text-destructive",
    dot: "bg-destructive",
  },
};

export function AccountHealthDialog({ account, onOpenChange }: AccountHealthDialogProps) {
  const { data, loading, error, refetch } = useApi<HealthData>(
    account ? `accounts/${account.id}/health` : null,
  );

  const platform = account?.platform?.toLowerCase() || "";
  const title = account?.display_name || account?.username || "Unknown";
  const overall = data ? deriveOverall(data) : null;

  return (
    <Dialog open={!!account} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl grid-rows-[auto_1fr_auto]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              {account?.avatar_url ? (
                <img
                  src={account.avatar_url}
                  alt=""
                  className="size-9 rounded-md object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                    const fallback = (e.currentTarget as HTMLImageElement).nextElementSibling;
                    if (fallback) fallback.classList.remove("hidden");
                  }}
                />
              ) : null}
              <div
                className={cn(
                  "flex size-9 items-center justify-center rounded-md text-xs font-bold text-white",
                  platformColors[platform] || "bg-neutral-700",
                  account?.avatar_url ? "hidden" : "",
                )}
              >
                {platformAvatars[platform] || platform.slice(0, 2).toUpperCase()}
              </div>
              {overall && (
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-background",
                    TONES[overall.tone].dot,
                  )}
                />
              )}
            </div>
            <div className="min-w-0">
              <DialogTitle className="truncate text-base">{title}</DialogTitle>
              <p className="truncate text-xs text-muted-foreground">
                {account?.username && account.username !== title
                  ? `@${account.username.replace(/^@/, "")} · `
                  : ""}
                {platformLabels[platform] || account?.platform}
              </p>
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-4 pr-4">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : data && account && overall ? (
            <HealthContent data={data} platform={platform} accountId={account.id} refetch={refetch} overall={overall} />
          ) : null}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Derive the headline status — surfaces an early-warning amber tier for tokens the API still reports as healthy but that expire soon. */
function deriveOverall(data: HealthData): { tone: Tone; title: string; summary: string } {
  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const days = expiresAt ? daysUntil(expiresAt) : null;

  if (!data.healthy) {
    const title =
      data.error?.code === "TOKEN_EXPIRED"
        ? "Token expired"
        : data.error?.code === "SYNC_FAILING"
          ? "Sync failing"
          : "Needs attention";
    return { tone: "danger", title, summary: data.error?.message ?? "This connection needs attention." };
  }

  if (days !== null && days > 0 && days <= 14) {
    return {
      tone: "warn",
      title: "Expiring soon",
      summary: `Access token expires in ${days} day${days === 1 ? "" : "s"}. Reconnect to avoid interruption.`,
    };
  }

  const parts: string[] = [
    expiresAt === null ? "Token never expires" : `Token valid for ${days} day${days === 1 ? "" : "s"}`,
  ];
  if (data.sync) parts.push(data.sync.enabled ? "sync running" : "sync paused");
  return { tone: "ok", title: "Healthy", summary: `${parts.join(" · ")}.` };
}

function HealthContent({
  data,
  platform,
  accountId,
  refetch,
  overall,
}: {
  data: HealthData;
  platform: string;
  accountId: string;
  refetch: () => void;
  overall: { tone: Tone; title: string; summary: string };
}) {
  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const days = expiresAt ? daysUntil(expiresAt) : null;
  const isExpired = days !== null && days <= 0;
  const tokenTone: Tone = isExpired || (days !== null && days <= 3) ? "danger" : days !== null && days <= 14 ? "warn" : "ok";
  const tokenColor = tokenTone === "danger" ? "text-destructive" : tokenTone === "warn" ? "text-amber-600" : "text-foreground";

  const granted = categorizeScopeList(platform, data.scopes);
  const expected = getExpectedScopes(platform);
  const canPost = hasPostingCapability(platform, data.scopes);
  const canAnalytics = hasAnalyticsCapability(platform, data.scopes);
  const hasScopes = data.scopes.length > 0;

  const tone = TONES[overall.tone];
  const HeroIcon = overall.tone === "ok" ? CheckCircle2 : overall.tone === "warn" ? Clock : AlertTriangle;

  const tokenSection = (
    <Section icon={Key} title="Access token">
      {expiresAt === null ? (
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold leading-none text-emerald-600">Never</span>
          <span className="text-sm text-muted-foreground">expires</span>
        </div>
      ) : isExpired ? (
        <>
          <div className="text-2xl font-semibold leading-none text-destructive">Expired</div>
          <Row className="mt-3" label="Expired on" value={formatDate(expiresAt)} />
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className={cn("text-2xl font-semibold leading-none tabular-nums", tokenColor)}>{days}</span>
            <span className="text-sm text-muted-foreground">day{days === 1 ? "" : "s"} remaining</span>
          </div>
          <Row className="mt-3" label="Expires on" value={formatDate(expiresAt)} />
        </>
      )}
    </Section>
  );

  const permissionsSection = hasScopes ? (
    <Section icon={Shield} title="Permissions">
      <div className="flex flex-wrap gap-2">
        <CapabilityBadge label="Can post" enabled={canPost} />
        {expected.analytics.length > 0 && <CapabilityBadge label="Analytics" enabled={canAnalytics} />}
      </div>
      {(granted.posting.length > 0 || granted.analytics.length > 0 || granted.optional.length > 0) && (
        <div className="mt-3 space-y-2.5">
          {granted.posting.length > 0 && (
            <ScopeGroup label="Required for posting" scopes={granted.posting} grantedScopes={data.scopes} />
          )}
          {granted.analytics.length > 0 && (
            <ScopeGroup label="For analytics" scopes={granted.analytics} grantedScopes={data.scopes} />
          )}
          {granted.optional.length > 0 && (
            <ScopeGroup label="Optional" scopes={granted.optional} grantedScopes={data.scopes} />
          )}
        </div>
      )}
    </Section>
  ) : null;

  const syncSection = data.sync ? (
    <SyncSection sync={data.sync} accountId={accountId} refetch={refetch} />
  ) : null;

  // Two-column split only when there is enough to fill both sides; otherwise a
  // single column avoids leaving an empty half at the wider dialog size.
  const twoColumn = !!permissionsSection && !!syncSection;

  return (
    <div className="space-y-3">
      {/* Status hero — spans full width above the columns */}
      <div className={cn("flex items-start gap-3 rounded-lg border p-4", tone.hero)}>
        <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", tone.iconWrap)}>
          <HeroIcon className={cn("size-5", tone.icon)} />
        </div>
        <div className="min-w-0">
          <p className={cn("text-sm font-semibold leading-tight", tone.title)}>{overall.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{overall.summary}</p>
        </div>
      </div>

      {twoColumn ? (
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <div className="space-y-3">
            {tokenSection}
            {syncSection}
          </div>
          <div className="space-y-3">{permissionsSection}</div>
        </div>
      ) : (
        <div className="space-y-3">
          {tokenSection}
          {permissionsSection}
          {syncSection}
        </div>
      )}
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon className="size-3.5 text-muted-foreground" />
          {title}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Row({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 text-sm", className)}>
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2.5">
      <div className="text-lg font-semibold leading-none tabular-nums">{value.toLocaleString()}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function CapabilityBadge({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        enabled ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground",
      )}
    >
      {enabled ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
      {label}
    </div>
  );
}

function ScopeGroup({
  label,
  scopes,
  grantedScopes,
}: {
  label: string;
  scopes: { scope: string; label: string }[];
  grantedScopes: string[];
}) {
  const grantedSet = new Set(grantedScopes);
  return (
    <div>
      <p className="mb-1.5 text-xs text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {scopes.map((s) => {
          const ok = grantedSet.has(s.scope);
          return (
            <span
              key={s.scope}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium",
                ok ? "bg-emerald-500/10 text-emerald-700" : "bg-muted text-muted-foreground line-through",
              )}
            >
              {ok ? <Check className="size-2.5" /> : <XCircle className="size-2.5" />}
              {s.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

type SyncStatusKey = "active" | "error" | "rate_limited" | "paused";

const SYNC_STATUS: Record<SyncStatusKey, { label: string; cls: string; dot: string }> = {
  active: { label: "Active", cls: "border-emerald-500/30 text-emerald-600", dot: "bg-emerald-500" },
  error: { label: "Error", cls: "border-destructive/30 text-destructive", dot: "bg-destructive" },
  rate_limited: { label: "Rate limited", cls: "border-amber-500/30 text-amber-600", dot: "bg-amber-500" },
  paused: { label: "Paused", cls: "border-border text-muted-foreground", dot: "bg-muted-foreground" },
};

function SyncSection({
  sync,
  accountId,
  refetch,
}: {
  sync: NonNullable<HealthData["sync"]>;
  accountId: string;
  refetch: () => void;
}) {
  const { mutate, loading: retrying, error: retryError } = useMutation(`accounts/${accountId}/sync`);
  const [retrySuccess, setRetrySuccess] = useState(false);
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  const [copied, setCopied] = useState(false);

  const isRateLimited = !!sync.rate_limit_reset_at && new Date(sync.rate_limit_reset_at) > new Date();
  const hasErrors = sync.consecutive_errors > 0;

  const status: SyncStatusKey = !sync.enabled
    ? "paused"
    : isRateLimited
      ? "rate_limited"
      : hasErrors
        ? "error"
        : "active";
  const sc = SYNC_STATUS[status];

  const handleRetry = async () => {
    setRetrySuccess(false);
    const result = await mutate();
    if (result) {
      setRetrySuccess(true);
      refetch();
      setTimeout(() => setRetrySuccess(false), 3000);
    }
  };

  return (
    <Section
      icon={RefreshCw}
      title="Post sync"
      action={
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", sc.cls)}>
          <span className={cn("size-1.5 rounded-full", sc.dot)} />
          {sc.label}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-2.5">
        <Stat label="Posts synced" value={sync.total_posts_synced} />
        <Stat label="Sync runs" value={sync.total_sync_runs} />
      </div>

      <div className="mt-3 space-y-1.5">
        <Row
          label="Last synced"
          value={
            sync.last_sync_at ? (
              formatRelativeTime(new Date(sync.last_sync_at))
            ) : (
              <span className="text-muted-foreground">Never</span>
            )
          }
        />
        <Row
          label="Next sync"
          value={
            !sync.enabled ? (
              <span className="text-muted-foreground">Paused</span>
            ) : sync.next_sync_at ? (
              formatRelativeTime(new Date(sync.next_sync_at))
            ) : (
              <span className="text-muted-foreground">—</span>
            )
          }
        />
      </div>

      {/* Error details */}
      {hasErrors && sync.last_error && (
        <div className="mt-3 space-y-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangle className="size-3" />
              {sync.consecutive_errors} consecutive failure{sync.consecutive_errors > 1 ? "s" : ""}
            </div>
            <button
              type="button"
              onClick={() => setShowErrorDetail(!showErrorDetail)}
              className="flex items-center gap-1 text-[11px] font-medium text-destructive/70 transition-colors hover:text-destructive"
            >
              {showErrorDetail ? "Hide" : "Details"}
              {showErrorDetail ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </button>
          </div>
          <p className="text-xs text-destructive/80">{sync.last_error}</p>
          {showErrorDetail && (
            <div className="space-y-1.5 border-t border-destructive/20 pt-1">
              {sync.last_error_at && (
                <Row
                  label="Time"
                  value={<span className="text-xs text-destructive/70">{new Date(sync.last_error_at).toLocaleString()}</span>}
                />
              )}
              <Row label="Failures" value={<span className="text-xs text-destructive/70">{sync.consecutive_errors}</span>} />
              <Row label="Total runs" value={<span className="text-xs text-destructive/70">{sync.total_sync_runs}</span>} />
              <button
                type="button"
                onClick={() => {
                  const detail = [
                    `Error: ${sync.last_error}`,
                    `Time: ${sync.last_error_at ? new Date(sync.last_error_at).toISOString() : "N/A"}`,
                    `Consecutive failures: ${sync.consecutive_errors}`,
                    `Total sync runs: ${sync.total_sync_runs}`,
                    `Last synced: ${sync.last_sync_at ?? "Never"}`,
                    `Account: ${accountId}`,
                  ].join("\n");
                  navigator.clipboard.writeText(detail);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="flex w-full items-center justify-center gap-1.5 pt-1 text-[11px] font-medium text-destructive/60 transition-colors hover:text-destructive"
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? "Copied" : "Copy error details"}
              </button>
            </div>
          )}
          {!showErrorDetail && sync.last_error_at && (
            <p className="text-xs text-destructive/60">Last error: {formatRelativeTime(new Date(sync.last_error_at))}</p>
          )}
        </div>
      )}

      {/* Rate limit info */}
      {isRateLimited && sync.rate_limit_reset_at && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700">
            <Clock className="size-3" />
            Rate limited until {formatRelativeTime(new Date(sync.rate_limit_reset_at))}
          </div>
        </div>
      )}

      {/* Retry button */}
      <Button variant="outline" size="sm" className="mt-3 w-full" onClick={handleRetry} disabled={retrying}>
        {retrying ? (
          <>
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            Syncing...
          </>
        ) : retrySuccess ? (
          <>
            <CheckCircle2 className="mr-1.5 size-3.5 text-emerald-600" />
            Sync enqueued
          </>
        ) : (
          <>
            <RefreshCw className="mr-1.5 size-3.5" />
            Retry sync now
          </>
        )}
      </Button>

      {retryError && <p className="mt-1.5 text-xs text-destructive">{retryError}</p>}
    </Section>
  );
}

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);
  const isPast = diffMs < 0;

  if (absDiffMs < 60_000) return isPast ? "just now" : "in a moment";

  const minutes = Math.floor(absDiffMs / 60_000);
  if (minutes < 60) {
    const label = `${minutes} minute${minutes > 1 ? "s" : ""}`;
    return isPast ? `${label} ago` : `in ${label}`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const label = `${hours} hour${hours > 1 ? "s" : ""}`;
    return isPast ? `${label} ago` : `in ${label}`;
  }

  const days = Math.floor(hours / 24);
  const label = `${days} day${days > 1 ? "s" : ""}`;
  return isPast ? `${label} ago` : `in ${label}`;
}
