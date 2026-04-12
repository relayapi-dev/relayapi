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

export function AccountHealthDialog({ account, onOpenChange }: AccountHealthDialogProps) {
  const { data, loading, error, refetch } = useApi<HealthData>(
    account ? `accounts/${account.id}/health` : null,
  );

  const platform = account?.platform?.toLowerCase() || "";
  const title = account?.display_name || account?.username || "Unknown";

  return (
    <Dialog open={!!account} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md grid-rows-[auto_1fr_auto]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {account?.avatar_url ? (
              <img src={account.avatar_url} alt="" className="size-8 rounded-md object-cover" />
            ) : (
              <div
                className={cn(
                  "flex size-8 items-center justify-center rounded-md text-xs font-bold text-white",
                  platformColors[platform] || "bg-neutral-700",
                )}
              >
                {platformAvatars[platform] || platform.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div>
              <DialogTitle className="text-base">{title}</DialogTitle>
              <p className="text-xs text-muted-foreground">
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
          ) : data && account ? (
            <HealthContent data={data} platform={platform} accountId={account.id} refetch={refetch} />
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

function HealthContent({ data, platform, accountId, refetch }: { data: HealthData; platform: string; accountId: string; refetch: () => void }) {
  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at) : null;
  const now = new Date();
  const daysUntilExpiry = expiresAt
    ? Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const isExpired = daysUntilExpiry !== null && daysUntilExpiry <= 0;

  const granted = categorizeScopeList(platform, data.scopes);
  const expected = getExpectedScopes(platform);
  const canPost = hasPostingCapability(platform, data.scopes);
  const canAnalytics = hasAnalyticsCapability(platform, data.scopes);
  const hasScopes = data.scopes.length > 0;

  return (
    <div className="space-y-4">
      {/* Health badge */}
      <div
        className={cn(
          "flex items-center gap-2 rounded-md px-4 py-3 text-sm font-medium",
          data.healthy
            ? "bg-emerald-500/10 text-emerald-600"
            : "bg-destructive/10 text-destructive",
        )}
      >
        {data.healthy ? (
          <CheckCircle2 className="size-4" />
        ) : (
          <XCircle className="size-4" />
        )}
        {data.healthy ? "Healthy" : "Unhealthy"}
      </div>

      {/* Token status */}
      <div className="rounded-md border border-border p-4 space-y-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Key className="size-3.5 text-muted-foreground" />
          Token Status
        </div>
        <div className="space-y-1.5 text-sm">
          <Row
            label="Valid"
            value={
              <span className={isExpired ? "text-destructive font-medium" : "text-emerald-600 font-medium"}>
                {isExpired ? "No" : "Yes"}
              </span>
            }
          />
          <Row
            label="Expires in"
            value={
              expiresAt === null ? (
                <span className="text-muted-foreground">Never</span>
              ) : isExpired ? (
                <span className="text-destructive font-medium">Expired</span>
              ) : (
                <span>{daysUntilExpiry} days</span>
              )
            }
          />
          <Row
            label="Expires at"
            value={
              expiresAt ? (
                <span>
                  {expiresAt.toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  })}
                </span>
              ) : (
                <span className="text-muted-foreground">N/A</span>
              )
            }
          />
        </div>
      </div>

      {/* Permissions */}
      {hasScopes && (
        <div className="rounded-md border border-border p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Shield className="size-3.5 text-muted-foreground" />
            Permissions
          </div>

          {/* Summary badges */}
          <div className="flex gap-2">
            <CapabilityBadge label="Can Post" enabled={canPost} />
            {expected.analytics.length > 0 && (
              <CapabilityBadge label="Analytics" enabled={canAnalytics} />
            )}
          </div>

          {/* Scope groups */}
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

      {/* Post Sync */}
      {data.sync && (
        <SyncSection sync={data.sync} accountId={accountId} refetch={refetch} />
      )}

      {/* Error message */}
      {data.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {data.error.message}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      {value}
    </div>
  );
}

function CapabilityBadge({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium",
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
      <p className="text-xs text-muted-foreground mb-1.5">{label}:</p>
      <div className="flex flex-wrap gap-1.5">
        {scopes.map((s) => (
          <span
            key={s.scope}
            className={cn(
              "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]",
              grantedSet.has(s.scope)
                ? "bg-emerald-500/10 text-emerald-700"
                : "bg-muted text-muted-foreground",
            )}
          >
            {grantedSet.has(s.scope) ? "✓" : "✗"} {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

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

  const now = new Date();
  const isRateLimited =
    sync.rate_limit_reset_at && new Date(sync.rate_limit_reset_at) > now;
  const hasErrors = sync.consecutive_errors > 0;

  const status = isRateLimited
    ? "rate_limited"
    : hasErrors
      ? "error"
      : "active";

  const statusConfig = {
    active: { label: "Active", className: "text-emerald-600 font-medium" },
    error: { label: "Error", className: "text-destructive font-medium" },
    rate_limited: { label: "Rate Limited", className: "text-amber-600 font-medium" },
  };

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
    <div className="rounded-md border border-border p-4 space-y-2.5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <RefreshCw className="size-3.5 text-muted-foreground" />
        Post Sync
      </div>
      <div className="space-y-1.5 text-sm">
        <Row
          label="Status"
          value={
            <span className={statusConfig[status].className}>
              {statusConfig[status].label}
            </span>
          }
        />
        <Row
          label="Last synced"
          value={
            sync.last_sync_at ? (
              <span>{formatRelativeTime(new Date(sync.last_sync_at))}</span>
            ) : (
              <span className="text-muted-foreground">Never</span>
            )
          }
        />
        <Row
          label="Next sync"
          value={
            sync.next_sync_at ? (
              <span>{formatRelativeTime(new Date(sync.next_sync_at))}</span>
            ) : (
              <span className="text-muted-foreground">N/A</span>
            )
          }
        />
        <Row
          label="Posts synced"
          value={<span>{sync.total_posts_synced}</span>}
        />
        <Row
          label="Sync runs"
          value={<span>{sync.total_sync_runs}</span>}
        />
      </div>

      {/* Error details */}
      {hasErrors && sync.last_error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangle className="size-3" />
              {sync.consecutive_errors} consecutive failure{sync.consecutive_errors > 1 ? "s" : ""}
            </div>
            <button
              type="button"
              onClick={() => setShowErrorDetail(!showErrorDetail)}
              className="flex items-center gap-1 text-[11px] font-medium text-destructive/70 hover:text-destructive transition-colors"
            >
              {showErrorDetail ? "Hide" : "Details"}
              {showErrorDetail ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </button>
          </div>
          <p className="text-xs text-destructive/80">{sync.last_error}</p>
          {showErrorDetail && (
            <div className="space-y-1.5 pt-1 border-t border-destructive/20">
              {sync.last_error_at && (
                <Row
                  label="Time"
                  value={
                    <span className="text-xs text-destructive/70">
                      {new Date(sync.last_error_at).toLocaleString()}
                    </span>
                  }
                />
              )}
              <Row
                label="Failures"
                value={<span className="text-xs text-destructive/70">{sync.consecutive_errors}</span>}
              />
              <Row
                label="Total runs"
                value={<span className="text-xs text-destructive/70">{sync.total_sync_runs}</span>}
              />
              {/* Copy error for sharing / debugging */}
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
                className="flex items-center gap-1.5 text-[11px] font-medium text-destructive/60 hover:text-destructive transition-colors w-full justify-center pt-1"
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? "Copied" : "Copy error details"}
              </button>
            </div>
          )}
          {!showErrorDetail && sync.last_error_at && (
            <p className="text-xs text-destructive/60">
              Last error: {formatRelativeTime(new Date(sync.last_error_at))}
            </p>
          )}
        </div>
      )}

      {/* Rate limit info */}
      {isRateLimited && sync.rate_limit_reset_at && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700">
            <Clock className="size-3" />
            Rate limited until {formatRelativeTime(new Date(sync.rate_limit_reset_at))}
          </div>
        </div>
      )}

      {/* Retry button */}
      <Button
        variant="outline"
        size="sm"
        className="w-full mt-2"
        onClick={handleRetry}
        disabled={retrying}
      >
        {retrying ? (
          <>
            <Loader2 className="size-3.5 mr-1.5 animate-spin" />
            Syncing...
          </>
        ) : retrySuccess ? (
          <>
            <CheckCircle2 className="size-3.5 mr-1.5 text-emerald-600" />
            Sync enqueued
          </>
        ) : (
          <>
            <RefreshCw className="size-3.5 mr-1.5" />
            Retry Sync
          </>
        )}
      </Button>

      {/* Retry error */}
      {retryError && (
        <p className="text-xs text-destructive">{retryError}</p>
      )}
    </div>
  );
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
