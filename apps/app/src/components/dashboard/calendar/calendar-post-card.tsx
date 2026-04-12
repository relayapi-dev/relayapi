import { useState, useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Play, Settings, Film, ImageIcon, ExternalLink, Loader2, ThumbsUp, MessageSquare, Eye, TrendingUp } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { platformIcons } from "@/lib/platform-icons";
import { platformColors, platformLabels } from "@/lib/platform-maps";
import { PostDetailPopover, formatDateTime, formatNumber } from "./post-detail-popover";
import { PostDetailModal } from "./post-detail-modal";
import type { CalendarPost } from "./use-calendar-posts";

/** Simple popover for external (synced) posts — no API fetch needed, data is already on the card */
function ExternalPostPopover({ post }: { post: CalendarPost }) {
  const dateStr = post.published_at || post.created_at;
  const thumbUrl = post.media?.[0]?.url ?? null;
  const thumbType = post.media?.[0]?.type ?? "";
  const popoverIsVideo = thumbType === "video" || thumbType.startsWith("video/") || (() => { try { return /\.(mp4|mov|webm|avi)$/i.test(new URL(thumbUrl ?? "").pathname); } catch { return /\.(mp4|mov|webm|avi)$/i.test(thumbUrl ?? ""); } })();
  const accountName = post.accountName || platformLabels[post.platform] || post.platform || "Account";
  return (
    <PopoverContent className="w-80 p-0" side="right" align="start">
      <div className="px-4 pt-3 pb-2">
        <span className="text-[11px] text-muted-foreground">
          {dateStr ? formatDateTime(dateStr) : "External post"}
          {" \u00b7 Published"}
        </span>
      </div>
      <div className="px-4 pb-3">
        {/* Account info */}
        <div className="flex items-center gap-2 mb-2">
          {post.accountAvatarUrl ? (
            <img src={post.accountAvatarUrl} alt={accountName} className="size-6 rounded-full object-cover shrink-0" />
          ) : (
            <div className={cn("size-6 rounded-full flex items-center justify-center text-white text-[9px] font-medium shrink-0", platformColors[post.platform] || "bg-neutral-600")}>
              {accountName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex items-center gap-1.5">
            <span className="text-xs font-medium truncate">{accountName}</span>
            {post.platform && (
              <span className={cn("inline-flex items-center justify-center size-4 rounded text-white shrink-0", platformColors[post.platform] || "bg-neutral-600")}>
                <span className="[&_svg]:size-2.5">{platformIcons[post.platform]}</span>
              </span>
            )}
          </div>
        </div>
        {post.content && (
          <p className="text-[12px] leading-relaxed text-foreground/90 whitespace-pre-wrap line-clamp-6">{post.content}</p>
        )}
        {thumbUrl && (
          <a href={post.platformUrl || undefined} target="_blank" rel="noopener noreferrer" onClick={(e) => { if (!post.platformUrl) e.preventDefault(); e.stopPropagation(); }} className={post.platformUrl ? "cursor-pointer hover:opacity-90 transition-opacity" : ""}>
            {popoverIsVideo ? (
              <video src={thumbUrl} muted preload="metadata" onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).currentTime = 0.001; }} className="mt-2 w-full max-h-48 rounded-md object-cover" onError={(e) => { const vid = e.target as HTMLVideoElement; const img = document.createElement("img"); img.src = thumbUrl!; img.alt = ""; img.className = vid.className; img.onerror = () => { img.style.display = "none"; }; vid.replaceWith(img); }} />
            ) : (
              <img src={thumbUrl} alt="" className="mt-2 w-full max-h-48 rounded-md object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            )}
          </a>
        )}
      </div>

      {/* Engagement stats */}
      {post.metrics && (post.metrics.likes || post.metrics.comments || post.metrics.impressions || post.metrics.views) ? (
        <div className="px-4 pb-3 border-t border-border pt-2">
          <div className="grid grid-cols-4 gap-2">
            {(post.metrics.likes != null) && (
              <div className="text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground mb-0.5">
                  <ThumbsUp className="size-3" />
                  <span className="text-[10px]">Reactions</span>
                </div>
                <span className="text-sm font-semibold">{formatNumber(post.metrics.likes)}</span>
              </div>
            )}
            {(post.metrics.comments != null) && (
              <div className="text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground mb-0.5">
                  <MessageSquare className="size-3" />
                  <span className="text-[10px]">Comments</span>
                </div>
                <span className="text-sm font-semibold">{formatNumber(post.metrics.comments)}</span>
              </div>
            )}
            {(post.metrics.impressions != null || post.metrics.views != null) && (
              <div className="text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground mb-0.5">
                  <Eye className="size-3" />
                  <span className="text-[10px]">Views</span>
                </div>
                <span className="text-sm font-semibold">{formatNumber(post.metrics.views ?? post.metrics.impressions ?? 0)}</span>
              </div>
            )}
            {(post.metrics.shares != null) && (
              <div className="text-center">
                <div className="flex items-center justify-center gap-1 text-muted-foreground mb-0.5">
                  <TrendingUp className="size-3" />
                  <span className="text-[10px]">Shares</span>
                </div>
                <span className="text-sm font-semibold">{formatNumber(post.metrics.shares)}</span>
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30">
        {post.platform && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Published via</span>
            <span className={cn("inline-flex items-center justify-center size-4 rounded text-white", platformColors[post.platform] || "bg-neutral-600")}>
              <span className="[&_svg]:size-2.5">{platformIcons[post.platform]}</span>
            </span>
            <span>{platformLabels[post.platform] || post.platform}</span>
          </div>
        )}
        {post.platformUrl && (
          <a href={post.platformUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent transition-colors border border-border">
            <ExternalLink className="size-3" />
            View Post
          </a>
        )}
      </div>
    </PopoverContent>
  );
}

interface CalendarPostCardProps {
  post: CalendarPost;
  overlay?: boolean;
  compact?: boolean;
  onEdit?: (postId: string) => void;
  onDelete?: (postId: string) => void;
  timezone?: string;
}

export function CalendarPostCard({ post, overlay, compact, onEdit, onDelete, timezone }: CalendarPostCardProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const didDrag = useRef(false);

  const isDraggable = post.status === "scheduled" || post.status === "draft";
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: post.id,
    data: { post },
    disabled: !isDraggable,
  });

  const dateSource = post.scheduled_at || post.published_at;
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeStr = dateSource
    ? new Date(dateSource).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
    : null;

  const primaryPlatform = post.platform || post.platforms?.[0] || "";
  const thumbUrl = post.media?.[0]?.url ?? null;
  const thumbType = post.media?.[0]?.type ?? "";
  const isVideo = thumbType === "video" || thumbType.startsWith("video/") || (() => { try { return /\.(mp4|mov|webm|avi)$/i.test(new URL(thumbUrl ?? "").pathname); } catch { return /\.(mp4|mov|webm|avi)$/i.test(thumbUrl ?? ""); } })();
  const [videoError, setVideoError] = useState(false);
  const hasMedia = thumbUrl && (!imgError || isVideo);

  const handlePointerDown = () => { didDrag.current = false; };
  const handlePointerMove = () => { didDrag.current = true; };
  const handleClick = (e: React.MouseEvent) => {
    if (didDrag.current || isDragging) return;
    e.stopPropagation();
    setPopoverOpen(true);
  };

  const handleExpand = () => {
    setPopoverOpen(false);
    setModalOpen(true);
  };

  // Drag overlay
  if (overlay) {
    return (
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs border bg-background shadow-lg ring-1 ring-foreground/10">
        {primaryPlatform && (
          <span className={cn("inline-flex items-center justify-center size-[18px] rounded text-white shrink-0", platformColors[primaryPlatform] || "bg-neutral-600")}>
            <span className="[&_svg]:size-2.5">{platformIcons[primaryPlatform]}</span>
          </span>
        )}
        {timeStr && <span className="text-[11px] font-semibold text-foreground shrink-0">{timeStr}</span>}
        <span className="truncate flex-1 text-foreground/70 text-[11px]">
          {post.content ? post.content.slice(0, 40) : "No content"}
        </span>
      </div>
    );
  }

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <div
            ref={setNodeRef}
            {...(isDraggable ? { ...listeners, ...attributes } : {})}
            onPointerDown={(e) => { handlePointerDown(); listeners?.onPointerDown?.(e); }}
            onPointerMove={handlePointerMove}
            onClick={handleClick}
            className={cn(
              "group flex rounded-md border border-border/60 bg-background transition-all overflow-hidden",
              "hover:shadow-sm hover:border-border",
              compact ? "h-10" : "h-16",
              isDraggable && "cursor-grab active:cursor-grabbing",
              isDragging && "opacity-30",
            )}
          >
            {/* Main content */}
            <div className={cn("flex-1 min-w-0", compact ? "px-1 py-0.5" : "px-2 py-1.5")}>
              {/* Row 1: platform icon + time + type icon */}
              <div className="flex items-center gap-1 mb-0.5">
                {primaryPlatform && (
                  <span className={cn("inline-flex items-center justify-center size-[18px] rounded text-white shrink-0", platformColors[primaryPlatform] || "bg-neutral-600")}>
                    <span className="[&_svg]:size-2.5">{platformIcons[primaryPlatform]}</span>
                  </span>
                )}
                {timeStr && (
                  <span className="text-[11px] font-semibold text-foreground shrink-0">{timeStr}</span>
                )}
                {/* no extra platform icons — each card is one platform (Buffer-style) */}
                {/* Post type / status icon (right-aligned) */}
                <span className="ml-auto text-muted-foreground/40 shrink-0">
                  {post.status === "publishing" ? <Loader2 className="size-3 animate-spin" /> : isVideo ? <Film className="size-3" /> : hasMedia ? <ImageIcon className="size-3" /> : <Settings className="size-3" />}
                </span>
              </div>

              {/* Row 2+: Caption text */}
              <p className={cn(
                "text-[11px] leading-snug text-foreground/70",
                compact ? "line-clamp-1" : "line-clamp-3",
              )}>
                {post.content || "No content"}
              </p>
            </div>

            {/* Media thumbnail (right side, like Buffer) */}
            {hasMedia && (
              <div className={cn("relative shrink-0", compact ? "w-10" : "w-12")}>
                {isVideo ? (
                  videoError ? (
                    <img
                      src={thumbUrl!}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <video
                      src={thumbUrl!}
                      muted
                      preload="metadata"
                      onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).currentTime = 0.001; }}
                      className="h-full w-full object-cover"
                      onError={() => setVideoError(true)}
                    />
                  )
                ) : (
                  <img
                    src={thumbUrl!}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                    onError={() => setImgError(true)}
                  />
                )}
                {isVideo && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <Play className="size-3.5 text-white fill-white" />
                  </div>
                )}
              </div>
            )}
          </div>
        </PopoverTrigger>
        {popoverOpen && !post.isExternal && (
          <PostDetailPopover postId={post.postId} onEdit={onEdit} onDelete={onDelete} onExpand={handleExpand} />
        )}
        {popoverOpen && post.isExternal && (
          <ExternalPostPopover post={post} />
        )}
      </Popover>

      {/* Full modal — lives outside the Popover so it survives popover closing */}
      {modalOpen && !post.isExternal && (
        <PostDetailModal postId={post.postId} open={modalOpen} onOpenChange={setModalOpen} onEdit={onEdit} onDelete={onDelete} />
      )}
    </>
  );
}
