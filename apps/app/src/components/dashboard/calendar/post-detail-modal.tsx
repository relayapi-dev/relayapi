import { useState, useEffect } from "react";
import {
  ExternalLink,
  ThumbsUp,
  MessageSquare,
  Eye,
  TrendingUp,
  Loader2,
  MoreHorizontal,
  Trash2,
  RotateCw,
  Pencil,
} from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { platformIcons } from "@/lib/platform-icons";
import { platformColors, platformLabels } from "@/lib/platform-maps";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatNumber, formatDateTime, statusLabels } from "./post-detail-popover";
import type { PostDetail } from "./post-detail-popover";

interface PostDetailModalProps {
  postId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit?: (postId: string) => void;
  onDelete?: (postId: string) => void;
}

interface PostEngagement {
  likes: number;
  comments: number;
  impressions: number;
  engagement_rate: number;
}

export function PostDetailModal({ postId, open, onOpenChange, onEdit, onDelete }: PostDetailModalProps) {
  const [detail, setDetail] = useState<PostDetail | null>(null);
  const [engagement, setEngagement] = useState<PostEngagement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function fetchDetail() {
      setLoading(true);
      try {
        const res = await fetch(`/api/posts/${postId}?include=targets,media`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;

        const mappedTargets: Record<string, { platform: string; username: string | null; displayName: string | null; avatarUrl: string | null; platformUrl: string | null; platformPostId: string | null; status: string }> = {};
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

        const publishedTargets = Object.values(mappedTargets).filter((t) => t.platformPostId);
        if (publishedTargets.length > 0) {
          const ids = publishedTargets.map((t) => t.platformPostId).filter(Boolean);
          if (ids.length > 0) {
            try {
              const analyticsRes = await fetch(`/api/analytics/platform/posts?platform_post_ids=${ids.join(",")}`);
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
            } catch { /* supplementary */ }
          }
        }
      } catch { /* failed */ } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchDetail();
    return () => { cancelled = true; };
  }, [postId, open]);

  const dateStr = detail ? (detail.published_at || detail.scheduled_at || detail.created_at) : null;
  const targets = detail ? Object.values(detail.targets) : [];
  const firstTarget = targets[0];
  const accountName = firstTarget?.displayName || firstTarget?.username || platformLabels[firstTarget?.platform ?? ""] || "Account";
  const thumbUrl = detail?.media?.[0]?.url ?? null;
  const hasVideo = detail?.media?.[0]?.type === "video" || (thumbUrl && /\.(mp4|mov|webm|avi)$/i.test(thumbUrl));
  const platformUrl = targets.find((t) => t.platformUrl)?.platformUrl;
  const primaryPlatform = firstTarget?.platform;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 gap-0">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !detail ? (
          <div className="py-16 text-center text-sm text-muted-foreground">Failed to load post</div>
        ) : (
          <>
            {/* Header */}
            <div className="px-5 py-3 border-b border-border">
              <span className="text-sm text-muted-foreground">
                {dateStr ? `Published on ${formatDateTime(dateStr)}` : "No date"}
                {" \u00b7 "}
                {statusLabels[detail.status] || detail.status}
              </span>
            </div>

            {/* Account */}
            <div className="px-5 pt-4">
              {firstTarget && (
                <div className="flex items-center gap-2 mb-3">
                  {firstTarget.avatarUrl ? (
                    <img src={firstTarget.avatarUrl} alt={accountName} className="size-8 rounded-full object-cover shrink-0" />
                  ) : (
                    <div className={cn("size-8 rounded-full flex items-center justify-center text-white text-xs font-medium shrink-0", platformColors[firstTarget.platform] || "bg-neutral-600")}>
                      {accountName.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="text-sm font-medium truncate">{accountName}</span>
                </div>
              )}

              {/* Full content */}
              {detail.content && (
                <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
                  {detail.content}
                </p>
              )}

              {/* Large media */}
              {thumbUrl && (
                hasVideo ? (
                  <div className="relative mt-3 rounded-lg overflow-hidden">
                    <video
                      src={thumbUrl!}
                      controls
                      muted
                      preload="metadata"
                      className="w-full max-h-[400px] rounded-lg"
                      onError={(e) => { const vid = e.target as HTMLVideoElement; const img = document.createElement("img"); img.src = thumbUrl!; img.alt = ""; img.className = "w-full max-h-[400px] object-cover rounded-lg"; img.onerror = () => { img.style.display = "none"; }; vid.replaceWith(img); }}
                    />
                  </div>
                ) : platformUrl ? (
                  <a
                    href={platformUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative block mt-3 rounded-lg overflow-hidden cursor-pointer hover:opacity-90 transition-opacity"
                  >
                    <img src={thumbUrl} alt="" className="w-full max-h-[400px] object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                  </a>
                ) : (
                  <div className="mt-3 rounded-lg overflow-hidden">
                    <img src={thumbUrl} alt="" className="w-full max-h-[400px] object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                  </div>
                )
              )}
            </div>

            {/* Engagement */}
            {engagement && (
              <div className="px-5 py-3 border-t border-border mt-3">
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

            {/* Footer */}
            <div className="flex items-center justify-between px-5 py-3 border-t border-border">
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
                {(onDelete || onEdit) && (
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
