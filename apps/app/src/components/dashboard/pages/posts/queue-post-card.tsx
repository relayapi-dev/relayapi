import { useState } from "react";
import {
  Clock,
  Check,
  AlertCircle,
  FileEdit,
  Loader2,
  Pencil,
  MoreVertical,
  Trash2,
  Copy,
  RotateCw,
  X,
  MessageCircle,
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

interface PostTarget {
  status: string;
  platform: string;
  accounts?: Array<{
    id: string;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    url: string | null;
    platform_post_id: string | null;
  }>;
  error?: { code: string; message: string };
}

export interface QueuePost {
  id: string;
  content: string;
  platforms: string[];
  status: "scheduled" | "published" | "draft" | "failed" | "publishing" | "partial";
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  targets?: Record<string, PostTarget>;
  media?: Array<{ url: string; type?: string }> | null;
}

/** A flattened card — one per target (account + platform). */
export interface FlatQueueCard {
  postId: string;
  content: string;
  media: Array<{ url: string; type?: string }> | null;
  platform: string;
  accountId: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  targetStatus: string;
  postStatus: string;
  scheduledAt: string | null;
  createdAt: string;
  error?: { code: string; message: string };
  /** Keep reference to full post for edit/duplicate */
  _post: QueuePost;
}

export interface QueuePostCardProps {
  card: FlatQueueCard;
  isDraft?: boolean;
  onEdit?: (post: QueuePost) => void;
  onDuplicate?: (post: QueuePost) => void;
  onRetry?: (id: string) => void;
  onDelete?: (id: string) => void;
  onShowErrors?: (id: string) => void;
}

const statusConfig: Record<string, { label: string; color: string; bgColor: string; icon: React.ComponentType<{ className?: string }> }> = {
  scheduled: { label: "Scheduled", color: "text-blue-600", bgColor: "bg-blue-50 text-blue-600", icon: Clock },
  published: { label: "Published", color: "text-emerald-600", bgColor: "bg-emerald-50 text-emerald-600", icon: Check },
  publishing: { label: "Publishing", color: "text-amber-600", bgColor: "bg-amber-50 text-amber-600", icon: Loader2 },
  draft: { label: "Draft", color: "text-violet-600", bgColor: "bg-violet-50 text-violet-600", icon: FileEdit },
  failed: { label: "Failed", color: "text-red-600", bgColor: "bg-red-50 text-red-600", icon: AlertCircle },
  partial: { label: "Partial", color: "text-amber-600", bgColor: "bg-amber-50 text-amber-600", icon: AlertCircle },
};

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "1 day ago";
  if (diffDays < 30) return `${diffDays} days ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function getMediaThumbUrl(media: Array<{ url: string; type?: string }>): string | null {
  if (!media.length) return null;
  return media[0]?.url ?? null;
}

function isVideo(media: Array<{ url: string; type?: string }>): boolean {
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

/** Flatten a post into one card per target. */
export function flattenPost(post: QueuePost): FlatQueueCard[] {
  const targets = post.targets ? Object.entries(post.targets) : [];

  if (targets.length === 0) {
    // No targets data — create one card per platform from the platforms array
    return post.platforms.map((platform) => ({
      postId: post.id,
      content: post.content,
      media: post.media ?? null,
      platform,
      accountId: platform,
      displayName: null,
      username: null,
      avatarUrl: null,
      targetStatus: post.status,
      postStatus: post.status,
      scheduledAt: post.scheduled_at,
      createdAt: post.created_at,
      _post: post,
    }));
  }

  return targets.map(([accountId, target]) => {
    const account = target.accounts?.[0];
    return {
      postId: post.id,
      content: post.content,
      media: post.media ?? null,
      platform: target.platform,
      accountId,
      displayName: account?.display_name ?? null,
      username: account?.username ?? null,
      avatarUrl: account?.avatar_url ?? null,
      targetStatus: target.status,
      postStatus: post.status,
      scheduledAt: post.scheduled_at,
      createdAt: post.created_at,
      error: target.error,
      _post: post,
    };
  });
}

export function QueuePostCard({
  card,
  isDraft,
  onEdit,
  onDuplicate,
  onRetry,
  onDelete,
  onShowErrors,
}: QueuePostCardProps) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const thumbUrl = card.media ? getMediaThumbUrl(card.media) : null;
  const hasVideo = card.media ? isVideo(card.media) : false;
  const accountName = card.displayName || card.username || platformLabels[card.platform] || card.platform;
  const platformLabel = platformLabels[card.platform] || card.platform;
  const st = statusConfig[card.targetStatus] ?? statusConfig.draft!;
  const StIcon = st.icon;
  const isFailed = card.targetStatus === "failed";
  const time = isDraft ? null : formatTime(card.scheduledAt);

  return (
    <div className="flex gap-0 items-stretch">
      {/* Left gutter: time + status badge */}
      <div className="hidden sm:flex w-24 shrink-0 flex-col items-start pr-4 pt-3 gap-1.5">
        {time && (
          <span className="text-xs text-muted-foreground font-medium">{time}</span>
        )}
        {!time && !isDraft && (
          <span className="text-xs text-muted-foreground">No time</span>
        )}
        <span className={cn(
          "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium",
          st.bgColor
        )}>
          <StIcon className={cn("size-3", card.targetStatus === "publishing" && "animate-spin")} />
          {st.label}
        </span>
      </div>

      {/* Main card */}
      <div className="flex-1 min-w-0 rounded-lg border border-border bg-card overflow-hidden">
        {/* Header: avatar + account name */}
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative shrink-0">
              {card.avatarUrl ? (
                <img
                  src={card.avatarUrl}
                  alt={accountName}
                  className="size-8 rounded-full object-cover"
                />
              ) : (
                <div
                  className={cn(
                    "size-8 rounded-full flex items-center justify-center text-white text-xs font-medium",
                    platformColors[card.platform] || "bg-neutral-600"
                  )}
                >
                  {accountName.charAt(0).toUpperCase()}
                </div>
              )}
              {/* Platform badge overlay */}
              <span
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 size-4 rounded-full flex items-center justify-center text-white ring-2 ring-card",
                  platformColors[card.platform] || "bg-neutral-600"
                )}
              >
                <span className="[&_svg]:size-2.5">{platformIcons[card.platform]}</span>
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{accountName}</p>
              {card.username && card.username !== card.displayName && (
                <p className="text-xs text-muted-foreground truncate">{card.username}</p>
              )}
            </div>
          </div>
          {/* Mobile: time + status + notes inline */}
          <div className="flex sm:hidden items-center gap-2 shrink-0">
            {time && <span className="text-xs text-muted-foreground">{time}</span>}
            <span className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium", st.bgColor)}>
              <StIcon className={cn("size-3", card.targetStatus === "publishing" && "animate-spin")} />
              {st.label}
            </span>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  className="size-7 rounded-full border border-border bg-card flex items-center justify-center hover:bg-accent transition-colors"
                  title="Notes"
                >
                  <MessageCircle className="size-3.5 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" className="w-72">
                <NotesPanel postId={card.postId} />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Content + media */}
        <div className="px-4 pb-3">
          <div className="flex gap-4">
            <div className="flex-1 min-w-0">
              {card.content ? (
                <p className="text-[13px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
                  {card.content}
                </p>
              ) : (
                <p className="text-[13px] text-muted-foreground italic">No content</p>
              )}
            </div>
            {thumbUrl && (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="shrink-0 relative cursor-zoom-in"
              >
                {hasVideo ? (
                  <video
                    src={thumbUrl}
                    muted
                    preload="metadata"
                    onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).currentTime = 0.001; }}
                    className="w-20 h-20 sm:w-36 sm:h-36 rounded-md object-cover"
                  />
                ) : (
                  <img
                    src={thumbUrl}
                    alt=""
                    className="w-20 h-20 sm:w-36 sm:h-36 rounded-md object-cover"
                  />
                )}
                {hasVideo && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="size-9 rounded-full bg-black/60 flex items-center justify-center">
                      <svg viewBox="0 0 24 24" fill="white" className="size-4 ml-0.5">
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
        {previewOpen && thumbUrl && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
            onClick={() => setPreviewOpen(false)}
          >
            <button
              onClick={() => setPreviewOpen(false)}
              className="absolute top-4 right-4 text-white/80 hover:text-white"
            >
              <X className="size-6" />
            </button>
            {hasVideo ? (
              <video
                src={thumbUrl}
                controls
                autoPlay
                className="max-w-[90vw] max-h-[90vh] rounded-lg"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <img
                src={thumbUrl}
                alt=""
                className="max-w-[90vw] max-h-[90vh] rounded-lg object-contain"
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border bg-muted/30">
          <span className="text-xs text-muted-foreground">
            {isFailed ? (
              <button
                onClick={() => onShowErrors?.(card.postId)}
                className="text-red-500 hover:underline cursor-pointer"
              >
                {card.error?.message || "Publishing failed — click for details"}
              </button>
            ) : (
              `Created ${timeAgo(card.createdAt)}`
            )}
          </span>
          <div className="flex items-center gap-1">
            {onEdit && (
              <button
                onClick={() => onEdit(card._post)}
                className="rounded p-1.5 hover:bg-accent transition-colors"
                title="Edit"
              >
                <Pencil className="size-3.5 text-muted-foreground" />
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded p-1.5 hover:bg-accent transition-colors">
                  <MoreVertical className="size-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {onDuplicate && (
                  <DropdownMenuItem onClick={() => onDuplicate(card._post)}>
                    <Copy className="size-3.5 mr-2" />
                    Duplicate
                  </DropdownMenuItem>
                )}
                {isFailed && onRetry && (
                  <DropdownMenuItem onClick={() => onRetry(card.postId)}>
                    <RotateCw className="size-3.5 mr-2" />
                    Retry
                  </DropdownMenuItem>
                )}
                {(onDuplicate || (isFailed && onRetry)) && onDelete && (
                  <DropdownMenuSeparator />
                )}
                {onDelete && (
                  <DropdownMenuItem
                    onClick={() => onDelete(card.postId)}
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
              className="size-8 rounded-full border border-border bg-card flex items-center justify-center hover:bg-accent transition-colors"
              title="Notes"
            >
              <MessageCircle className="size-4 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="left" align="start" className="w-72">
            <NotesPanel postId={card.postId} />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

