import { useState } from "react";
import {
  ExternalLink,
  ThumbsUp,
  MessageSquare,
  MessageCircle,
  Eye,
  X,
  Share2,
  Bookmark,
  MousePointerClick,
  MoreVertical,
  Trash2,
  Undo2,
  Copy,
  Link,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { platformIcons } from "@/lib/platform-icons";
import { platformColors, platformLabels } from "@/lib/platform-maps";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { NotesPanel } from "./notes-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface SentPostEngagement {
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  engagement_rate: number;
}

export interface SentPostTarget {
  accountId: string;
  platform: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  platformUrl: string | null;
  platformPostId: string | null;
  publishedAt: string | null;
}

export interface SentPostCardProps {
  postId: string;
  content: string | null;
  media: Array<{ url: string; type?: string; poster?: string; thumbnail?: string }> | null;
  target: SentPostTarget;
  engagement: SentPostEngagement | null;
  onDelete?: (postId: string) => void;
  onUnpublish?: (postId: string) => void;
  onDuplicate?: (postId: string) => void;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function getMediaThumbUrl(media: Array<{ url: string; type?: string; poster?: string; thumbnail?: string }>): string | null {
  if (!media.length) return null;
  return media[0]?.url ?? null;
}

function isVideo(media: Array<{ url: string; type?: string; poster?: string; thumbnail?: string }>): boolean {
  const first = media[0];
  if (!first) return false;
  if (first.type === "video") return true;
  try {
    const pathname = new URL(first.url).pathname;
    return /\.(mp4|mov|webm|avi)$/i.test(pathname);
  } catch {
    return /\.(mp4|mov|webm|avi)$/i.test(first.url);
  }
}

export function SentPostCard({
  postId,
  content,
  media,
  target,
  engagement,
  onDelete,
  onUnpublish,
  onDuplicate,
}: SentPostCardProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const thumbUrl = media ? getMediaThumbUrl(media) : null;
  // Durable poster: legacy synced `poster` OR the API's hyper-optimized thumbnail
  // (survives after the R2 original is lifecycle-deleted).
  const posterUrl = media?.[0]?.poster ?? media?.[0]?.thumbnail ?? null;
  const hasVideo = media ? isVideo(media) : false;
  // Small card prefers the durable poster (rendered as a plain image); the
  // full-screen overlay prefers the original for playback / full quality.
  const cardThumb = posterUrl ?? thumbUrl;
  const showVideoInCard = hasVideo && !posterUrl;
  const overlayUrl = thumbUrl ?? posterUrl;
  const overlayIsVideo = hasVideo && !!thumbUrl;
  const accountName = target.displayName || target.username || "Unknown";
  const platformLabel = platformLabels[target.platform] || target.platform;
  const time = formatTime(target.publishedAt);

  return (
    <div className="flex gap-0 items-stretch">
      {/* Left gutter: time (hidden on mobile) */}
      <div className="hidden sm:flex w-24 shrink-0 flex-col items-start pr-4 pt-3 gap-1.5">
        {time && (
          <span className="text-xs text-muted-foreground font-medium">{time}</span>
        )}
      </div>

      {/* Main card */}
      <div className="flex-1 min-w-0 rounded-lg border border-border bg-card overflow-hidden">
        {/* Header: avatar + account name */}
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative shrink-0">
              {target.avatarUrl ? (
                <img
                  src={target.avatarUrl}
                  alt={accountName}
                  className="size-8 rounded-full object-cover"
                />
              ) : (
                <div
                  className={cn(
                    "size-8 rounded-full flex items-center justify-center text-white text-xs font-medium",
                    platformColors[target.platform] || "bg-neutral-600"
                  )}
                >
                  {accountName.charAt(0).toUpperCase()}
                </div>
              )}
              {/* Platform badge overlay */}
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 size-4 rounded-full flex items-center justify-center text-white ring-2 ring-card",
                  platformColors[target.platform] || "bg-neutral-600"
                )}
              >
                <span className="[&_svg]:size-2.5">{platformIcons[target.platform]}</span>
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{accountName}</p>
              {target.username && target.username !== target.displayName && (
                <p className="text-xs text-muted-foreground truncate">{target.username}</p>
              )}
            </div>
          </div>
          {/* Mobile: time + notes inline */}
          <div className="flex sm:hidden items-center gap-2 shrink-0">
            {time && <span className="text-xs text-muted-foreground">{time}</span>}
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="size-7 rounded-full border border-border bg-card flex items-center justify-center hover:bg-accent transition-colors"
                  title="Notes"
                >
                  <MessageCircle className="size-3.5 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" className="w-72">
                <NotesPanel postId={postId} />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Content + media — caption beside a large preview on desktop; preview stacked on top, caption below on mobile */}
        <div className="px-4 pb-3">
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
            {content && (
              <div className="order-2 sm:order-1 flex-1 min-w-0">
                <p className="text-[13px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
                  {content}
                </p>
              </div>
            )}
            {cardThumb && (
              <button
                type="button"
                onClick={() => {
                  if (target.platformUrl) {
                    window.open(target.platformUrl, '_blank');
                  } else {
                    setPreviewOpen(true);
                  }
                }}
                className={cn(
                  "order-1 sm:order-2 shrink-0 relative w-full sm:w-auto sm:ml-auto",
                  target.platformUrl ? "cursor-pointer" : "cursor-zoom-in",
                )}
              >
                {showVideoInCard ? (
                  <video
                    src={cardThumb}
                    muted
                    preload="metadata"
                    onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).currentTime = 0.001; }}
                    className="w-full aspect-[4/3] sm:aspect-auto sm:size-52 rounded-md object-cover"
                  />
                ) : (
                  <img
                    src={cardThumb}
                    alt=""
                    className="w-full aspect-[4/3] sm:aspect-auto sm:size-52 rounded-md object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                )}
                {hasVideo && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="size-10 sm:size-12 rounded-full bg-black/60 flex items-center justify-center">
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="white" className="size-4 sm:size-5 ml-0.5">
                        <polygon points="5,3 19,12 5,21" />
                      </svg>
                    </div>
                  </div>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Media preview overlay */}
        {previewOpen && overlayUrl && (
          // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop that closes on click; it contains a close button so it cannot be a <button> itself
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
            onClick={() => setPreviewOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape" || e.key === "Enter" || e.key === " ") setPreviewOpen(false);
            }}
          >
            <button
              type="button"
              onClick={() => setPreviewOpen(false)}
              className="absolute top-4 right-4 text-white/80 hover:text-white"
            >
              <X className="size-6" />
            </button>
            {overlayIsVideo ? (
              <video
                src={overlayUrl}
                controls
                autoPlay
                className="max-w-[90vw] max-h-[90vh] rounded-lg"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <track kind="captions" />
              </video>
            ) : (
              // biome-ignore lint/a11y/noStaticElementInteractions: preview image only stops backdrop-close propagation; it is not an interactive control
              <img
                src={overlayUrl}
                alt=""
                className="max-w-[90vw] max-h-[90vh] rounded-lg object-contain"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              />
            )}
          </div>
        )}

        {/* Engagement stats */}
        {engagement && (
          <div className="px-4 pb-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <StatItem icon={ThumbsUp} label="Reactions" value={engagement.likes} />
              <StatItem icon={MessageSquare} label="Comments" value={engagement.comments} />
              <StatItem icon={Eye} label="Views" value={engagement.impressions} />
              <StatItem icon={Share2} label="Shares" value={engagement.shares} />
              {engagement.saves > 0 && (
                <StatItem icon={Bookmark} label="Saves" value={engagement.saves} />
              )}
              {engagement.clicks > 0 && (
                <StatItem icon={MousePointerClick} label="Clicks" value={engagement.clicks} />
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border bg-muted/30">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Published via</span>
            <span className="inline-flex items-center gap-1">
              <span
                className={cn(
                  "inline-flex items-center justify-center size-4 rounded text-white",
                  platformColors[target.platform] || "bg-neutral-600"
                )}
              >
                <span className="[&_svg]:size-2.5">{platformIcons[target.platform]}</span>
              </span>
              <span className="font-medium text-foreground/70">{platformLabel}</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            {target.platformUrl && (
              <a
                href={target.platformUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors"
              >
                <ExternalLink className="size-3" />
                View Post
              </a>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="rounded p-1.5 hover:bg-accent transition-colors">
                  <MoreVertical className="size-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {target.platformUrl && (
                  <DropdownMenuItem onClick={() => { if (target.platformUrl) navigator.clipboard.writeText(target.platformUrl); }}>
                    <Link className="size-3.5 mr-2" />
                    Copy Link
                  </DropdownMenuItem>
                )}
                {onDuplicate && (
                  <DropdownMenuItem onClick={() => onDuplicate(postId)}>
                    <Copy className="size-3.5 mr-2" />
                    Duplicate
                  </DropdownMenuItem>
                )}
                {(target.platformUrl || onDuplicate) && (onUnpublish || onDelete) && (
                  <DropdownMenuSeparator />
                )}
                {onUnpublish && (
                  <DropdownMenuItem onClick={() => onUnpublish(postId)}>
                    <Undo2 className="size-3.5 mr-2" />
                    Unpublish
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
          </div>
        </div>
      </div>

      {/* Notes button — right side (hidden on mobile) */}
      <div className="hidden sm:flex w-10 shrink-0 justify-center pt-0">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="size-8 rounded-full border border-border bg-card flex items-center justify-center hover:bg-accent transition-colors"
              title="Notes"
            >
              <MessageCircle className="size-4 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="left" align="start" className="w-72">
            <NotesPanel postId={postId} />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

function StatItem({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-1" title={label}>
      <Icon className="size-3.5" />
      <span className="font-medium text-foreground">{formatNumber(value)}</span>
    </div>
  );
}
