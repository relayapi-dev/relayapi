import { useState, useEffect } from "react";
import {
  ExternalLink,
  Link2,
  MousePointerClick,
  ThumbsUp,
  MessageSquare,
  Eye,
  TrendingUp,
  Loader2,
  MoreHorizontal,
  Trash2,
  RotateCw,
  Pencil,
  Maximize2,
} from "lucide-react";
import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { platformIcons } from "@/lib/platform-icons";
import { platformColors, platformLabels } from "@/lib/platform-maps";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface PostTarget {
  platform: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  platformUrl: string | null;
  platformPostId: string | null;
  status: string;
}

interface PostEngagement {
  likes: number;
  comments: number;
  impressions: number;
  engagement_rate: number;
}

export interface PostDetail {
  id: string;
  content: string | null;
  status: string;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string | null;
  media: Array<{ url: string; type?: string }> | null;
  targets: Record<string, PostTarget>;
}

interface PostDetailPopoverProps {
  postId: string;
  onEdit?: (postId: string) => void;
  onDelete?: (postId: string) => void;
  onRetry?: (postId: string) => void;
  onExpand?: () => void;
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const statusLabels: Record<string, string> = {
  scheduled: "Scheduled",
  published: "Published",
  publishing: "Publishing",
  draft: "Draft",
  failed: "Failed",
  partial: "Partial",
};

export function PostDetailPopover({ postId, onEdit, onDelete, onRetry, onExpand }: PostDetailPopoverProps) {
  const [detail, setDetail] = useState<PostDetail | null>(null);
  const [engagement, setEngagement] = useState<PostEngagement | null>(null);
  const [shortLinkStats, setShortLinkStats] = useState<Array<{ short_url: string; original_url: string; click_count: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [isLandscape, setIsLandscape] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchDetail() {
      setLoading(true);
      try {
        const res = await fetch(`/api/posts/${postId}?include=targets,media`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;

        const mappedTargets: Record<string, PostTarget> = {};
        for (const [key, target] of Object.entries(data.targets || {})) {
          const t = target as any;
          const account = t.accounts?.[0];
          mappedTargets[key] = {
            platform: t.platform,
            username: account?.username ?? null,
            displayName: account?.display_name ?? null,
            avatarUrl: account?.avatar_url ?? null,
            platformUrl: account?.url ?? null,
            platformPostId: account?.platform_post_id ?? null,
            status: t.status,
          };
        }

        setDetail({
          id: data.id,
          content: data.content,
          status: data.status,
          scheduled_at: data.scheduled_at,
          published_at: data.published_at,
          created_at: data.created_at || null,
          media: data.media || null,
          targets: mappedTargets,
        });

        const mappedTargetValues = Object.values(mappedTargets);
        const publishedTargets = mappedTargetValues.filter((t) => t.platformPostId);
        if (publishedTargets.length > 0) {
          const postIds = publishedTargets.map((t) => t.platformPostId).filter(Boolean);
          if (postIds.length > 0) {
            try {
              const analyticsRes = await fetch(`/api/analytics/platform/posts?platform_post_ids=${postIds.join(",")}`);
              if (analyticsRes.ok && !cancelled) {
                const analytics = await analyticsRes.json();
                if (analytics.data?.length > 0) {
                  const agg = analytics.data.reduce(
                    (acc: PostEngagement, item: any) => ({
                      likes: acc.likes + (item.likes || 0),
                      comments: acc.comments + (item.comments || 0),
                      impressions: acc.impressions + (item.impressions || 0),
                      engagement_rate: item.engagement_rate || acc.engagement_rate,
                    }),
                    { likes: 0, comments: 0, impressions: 0, engagement_rate: 0 },
                  );
                  setEngagement(agg);
                }
              }
            } catch {
              // Analytics are supplementary
            }
          }
        }
        // Fetch short link stats for this post
        if (data.status === "published") {
          try {
            const slRes = await fetch(`/api/short-links/by-post/${postId}`);
            if (slRes.ok && !cancelled) {
              const slData = await slRes.json();
              if (slData.data?.length > 0) {
                setShortLinkStats(slData.data);
              }
            }
          } catch {
            // Short link stats are supplementary
          }
        }
      } catch {
        // Failed to load detail
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDetail();
    return () => { cancelled = true; };
  }, [postId]);

  if (loading) {
    return (
      <PopoverContent className="w-96 p-4" side="right" align="start">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      </PopoverContent>
    );
  }

  if (!detail) {
    return (
      <PopoverContent className="w-96 p-4" side="right" align="start">
        <p className="text-xs text-muted-foreground text-center py-4">Failed to load post details</p>
      </PopoverContent>
    );
  }

  const dateStr = detail.published_at || detail.scheduled_at || detail.created_at;
  const targets = Object.values(detail.targets);
  const firstTarget = targets[0];
  const accountName = firstTarget?.displayName || firstTarget?.username || platformLabels[firstTarget?.platform ?? ""] || "Account";
  const thumbUrl = detail.media?.[0]?.url ?? null;
  const hasVideo = detail.media?.[0]?.type === "video" || (thumbUrl && /\.(mp4|mov|webm|avi)$/i.test(thumbUrl));
  const platformUrl = targets.find((t) => t.platformUrl)?.platformUrl;
  const primaryPlatform = firstTarget?.platform;

  return (
    <PopoverContent className="w-96 p-0" side="right" align="start">
      {/* Header: date + status + expand button */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-[11px] text-muted-foreground">
          {dateStr ? formatDateTime(dateStr) : "No date"}
          {" \u00b7 "}
          {statusLabels[detail.status] || detail.status}
        </span>
        {onExpand && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onExpand();
            }}
            className="rounded p-1 hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            title="Expand"
          >
            <Maximize2 className="size-3.5" />
          </button>
        )}
      </div>

      {/* Account + content + media */}
      <div className="px-4 pb-3">
        {/* Account info */}
        {firstTarget && (
          <div className="flex items-center gap-2 mb-2">
            {firstTarget.avatarUrl ? (
              <img src={firstTarget.avatarUrl} alt={accountName} className="size-6 rounded-full object-cover shrink-0" />
            ) : (
              <div className={cn("size-6 rounded-full flex items-center justify-center text-white text-[9px] font-medium shrink-0", platformColors[firstTarget.platform] || "bg-neutral-600")}>
                {accountName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex items-center gap-1.5">
              <span className="text-xs font-medium truncate">{accountName}</span>
              <div className="flex items-center gap-0.5 shrink-0">
                {targets.slice(0, 3).map((t, i) => (
                  <span key={i} className={cn("inline-flex items-center justify-center size-4 rounded text-white", platformColors[t.platform] || "bg-neutral-600")}>
                    <span className="[&_svg]:size-2.5">{platformIcons[t.platform]}</span>
                  </span>
                ))}
                {targets.length > 3 && (
                  <span className="text-[9px] text-muted-foreground">+{targets.length - 3}</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Content + media: side-by-side for square/portrait, stacked for landscape */}
        <div className={cn(!isLandscape && thumbUrl && "flex gap-3")}>
          <div className="flex-1 min-w-0">
            {detail.content && (
              <p className="text-[12px] leading-relaxed text-foreground/90 line-clamp-4 whitespace-pre-wrap">
                {detail.content}
              </p>
            )}
          </div>

          {/* Thumbnail — right side for square/portrait */}
          {thumbUrl && !isLandscape && (
            hasVideo ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onExpand?.(); }}
                className="shrink-0 relative block rounded-md overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
                title="Click to preview video"
              >
                <video
                  src={thumbUrl}
                  muted
                  preload="metadata"
                  onLoadedMetadata={(e) => {
                    const v = e.target as HTMLVideoElement;
                    v.currentTime = 0.001;
                    if (v.videoWidth > v.videoHeight * 1.3) setIsLandscape(true);
                  }}
                  className="w-20 h-20 object-cover"
                  onError={(e) => { const vid = e.target as HTMLVideoElement; const img = document.createElement("img"); img.src = thumbUrl!; img.alt = ""; img.className = vid.className; img.onload = () => { if (img.naturalWidth > img.naturalHeight * 1.3) setIsLandscape(true); }; img.onerror = () => { img.style.display = "none"; }; vid.replaceWith(img); }}
                />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="size-6 rounded-full bg-black/60 flex items-center justify-center">
                    <svg viewBox="0 0 24 24" fill="white" className="size-3 ml-0.5"><polygon points="5,3 19,12 5,21" /></svg>
                  </div>
                </div>
              </button>
            ) : (
              <a
                href={platformUrl || undefined}
                target="_blank"
                rel="noopener noreferrer"
                className={cn("shrink-0 relative block rounded-md overflow-hidden", platformUrl && "cursor-pointer hover:opacity-90 transition-opacity")}
                onClick={(e) => { if (!platformUrl) e.preventDefault(); e.stopPropagation(); }}
              >
                <img
                  src={thumbUrl} alt="" className="w-20 h-20 object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  onLoad={(e) => {
                    const img = e.target as HTMLImageElement;
                    if (img.naturalWidth > img.naturalHeight * 1.3) setIsLandscape(true);
                  }}
                />
              </a>
            )
          )}
        </div>

        {/* Thumbnail — below content for landscape (16:9) */}
        {thumbUrl && isLandscape && (
          hasVideo ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onExpand?.(); }}
              className="relative block mt-2 rounded-md overflow-hidden w-full cursor-pointer hover:opacity-90 transition-opacity"
              title="Click to preview video"
            >
              <video
                src={thumbUrl}
                muted
                preload="metadata"
                onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).currentTime = 0.001; }}
                className="w-full max-h-48 object-cover"
                onError={(e) => { const vid = e.target as HTMLVideoElement; const img = document.createElement("img"); img.src = thumbUrl!; img.alt = ""; img.className = vid.className; img.onerror = () => { img.style.display = "none"; }; vid.replaceWith(img); }}
              />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="size-8 rounded-full bg-black/60 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="white" className="size-4 ml-0.5"><polygon points="5,3 19,12 5,21" /></svg>
                </div>
              </div>
            </button>
          ) : (
            <a
              href={platformUrl || undefined}
              target="_blank"
              rel="noopener noreferrer"
              className={cn("relative block mt-2 rounded-md overflow-hidden", platformUrl && "cursor-pointer hover:opacity-90 transition-opacity")}
              onClick={(e) => { if (!platformUrl) e.preventDefault(); e.stopPropagation(); }}
            >
              <img
                src={thumbUrl} alt="" className="w-full max-h-48 object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            </a>
          )
        )}
      </div>

      {/* Engagement stats */}
      {engagement && (
        <div className="px-4 pb-3 border-t border-border pt-2">
          <div className="grid grid-cols-4 gap-2">
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-muted-foreground mb-0.5">
                <ThumbsUp className="size-3" />
                <span className="text-[10px]">Reactions</span>
              </div>
              <span className="text-sm font-semibold">{formatNumber(engagement.likes)}</span>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-muted-foreground mb-0.5">
                <MessageSquare className="size-3" />
                <span className="text-[10px]">Comments</span>
              </div>
              <span className="text-sm font-semibold">{formatNumber(engagement.comments)}</span>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-muted-foreground mb-0.5">
                <Eye className="size-3" />
                <span className="text-[10px]">Views</span>
              </div>
              <span className="text-sm font-semibold">{formatNumber(engagement.impressions)}</span>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1 text-muted-foreground mb-0.5">
                <TrendingUp className="size-3" />
                <span className="text-[10px]">Eng. Rate</span>
              </div>
              <span className="text-sm font-semibold">
                {engagement.engagement_rate > 0 ? `${engagement.engagement_rate.toFixed(1)}%` : "-"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Short link click stats */}
      {shortLinkStats.length > 0 && (
        <div className="px-4 pb-3 border-t border-border pt-2">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Link2 className="size-3 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Short Links</span>
          </div>
          <div className="space-y-1">
            {shortLinkStats.map((sl) => (
              <div key={sl.short_url} className="flex items-center justify-between text-xs gap-2">
                <a
                  href={sl.short_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline truncate max-w-[140px]"
                >
                  {sl.short_url.replace(/^https?:\/\//, "")}
                </a>
                <div className="flex items-center gap-1 text-muted-foreground shrink-0">
                  <MousePointerClick className="size-3" />
                  <span className="font-semibold text-foreground">{sl.click_count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer: platform attribution + actions */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30">
        {primaryPlatform && detail.status === "published" ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Published via</span>
            <span className={cn("inline-flex items-center justify-center size-4 rounded text-white", platformColors[primaryPlatform] || "bg-neutral-600")}>
              <span className="[&_svg]:size-2.5">{platformIcons[primaryPlatform]}</span>
            </span>
            <span>{platformLabels[primaryPlatform] || primaryPlatform}</span>
          </div>
        ) : <div />}

        <div className="flex items-center gap-1">
          {platformUrl && (
            <a
              href={platformUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors border border-border"
            >
              <ExternalLink className="size-3" />
              View Post
            </a>
          )}
          {(onDelete || onRetry || onEdit) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded p-1.5 hover:bg-accent transition-colors border border-border">
                  <MoreHorizontal className="size-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                {onEdit && (
                  <DropdownMenuItem onClick={() => onEdit(postId)}>
                    <Pencil className="size-3.5 mr-2" />
                    Edit
                  </DropdownMenuItem>
                )}
                {detail.status === "failed" && onRetry && (
                  <DropdownMenuItem onClick={() => onRetry(postId)}>
                    <RotateCw className="size-3.5 mr-2" />
                    Retry
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <DropdownMenuItem
                    onClick={() => onDelete(postId)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="size-3.5 mr-2" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </PopoverContent>
  );
}
