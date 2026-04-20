export interface InboxComment {
  id: string;
  platform: string;
  author_name: string;
  author_avatar: string | null;
  text: string;
  created_at: string;
  likes?: number;
  replies_count?: number;
  hidden?: boolean;
  parent_id?: string | null;
  post_id?: string;
  post_text?: string | null;
  post_thumbnail_url?: string | null;
  post_platform_url?: string | null;
  account_id?: string;
  account_avatar_url?: string | null;
}

export interface ConversationItem {
  id: string;
  platform: string;
  account_id: string;
  participant_name: string | null;
  participant_avatar?: string | null;
  participant_metadata?: {
    instagramProfile?: {
      scopedId?: string | null;
      username?: string | null;
      followersCount?: number | null;
      mediaCount?: number | null;
      fetchedAt?: string | null;
    } | null;
  } | null;
  contact_id?: string | null;
  status: "open" | "archived" | "snoozed";
  assigned_user_id?: string | null;
  unread_count?: number;
  message_count?: number;
  last_message_text?: string | null;
  last_message_at?: string | null;
  labels?: string[];
  priority?: "low" | "normal" | "high" | "urgent";
  updated_at: string;
}

export interface MessageItem {
  id: string;
  sender: "user" | "participant";
  author_name?: string | null;
  text: string;
  created_at: string;
  attachments?: Array<{ type: string; url: string }>;
}

export interface PostWithComments {
  id: string;
  platform: string;
  account_id: string;
  account_avatar_url?: string | null;
  text: string | null;
  thumbnail_url: string | null;
  platform_url: string | null;
  created_at: string;
  comments_count: number;
}

export interface ReviewItem {
  id: string;
  author_name: string;
  platform: string;
  rating: number;
  text?: string | null;
  reply?: string | null;
  created_at: string;
  account_id?: string;
}

export const platformColors: Record<string, string> = {
  twitter: "bg-neutral-700",
  instagram: "bg-pink-600",
  linkedin: "bg-blue-700",
  facebook: "bg-blue-600",
  youtube: "bg-red-600",
  tiktok: "bg-neutral-800",
  googlebusiness: "bg-emerald-600",
  threads: "bg-neutral-800",
};

export const platformLabels: Record<string, string> = {
  twitter: "X",
  instagram: "IG",
  linkedin: "in",
  facebook: "fb",
  youtube: "YT",
  tiktok: "TT",
  googlebusiness: "GB",
  threads: "TH",
};

export const platformNames: Record<string, string> = {
  twitter: "X",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  youtube: "YouTube",
  tiktok: "TikTok",
  googlebusiness: "Google Business",
  threads: "Threads",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
  sms: "SMS",
};

export const commentCapabilities: Record<string, { hide: boolean; like: boolean; privateReply: boolean }> = {
  facebook: { hide: true, like: true, privateReply: true },
  instagram: { hide: true, like: false, privateReply: false },
  youtube: { hide: false, like: false, privateReply: false },
};

export const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};

export const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

export const newItemEnter = {
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.1, ease: [0.32, 0.72, 0, 1] as const } },
};

export function groupCommentsByThread(comments: InboxComment[]) {
  const topLevel = comments.filter((c) => !c.parent_id);
  const repliesByParent = new Map<string, InboxComment[]>();
  for (const c of comments) {
    if (c.parent_id) {
      const arr = repliesByParent.get(c.parent_id) || [];
      arr.push(c);
      repliesByParent.set(c.parent_id, arr);
    }
  }
  return { topLevel, repliesByParent };
}

export function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatMessageTime(dateStr: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(dateStr));
}

export function formatMessageDayLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();

  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  }).format(date);
}

export function getPlatformDisplayName(platform?: string | null): string {
  if (!platform) return "Unknown";
  const key = platform.toLowerCase();
  return platformNames[key] || platform;
}

export function getConversationDisplayName(conversation: Pick<ConversationItem, "platform" | "participant_name" | "participant_metadata">): string {
  const platform = conversation.platform?.toLowerCase();
  const instagramUsername = conversation.participant_metadata?.instagramProfile?.username?.trim();
  if (platform === "instagram" && instagramUsername) {
    return instagramUsername;
  }

  const participantName = conversation.participant_name?.trim();
  return participantName || "Unknown";
}

export function getInstagramScopedId(conversation: Pick<ConversationItem, "platform" | "participant_name" | "participant_metadata">): string | null {
  if (conversation.platform?.toLowerCase() !== "instagram") {
    return null;
  }

  const metadataScopedId = conversation.participant_metadata?.instagramProfile?.scopedId?.trim();
  if (metadataScopedId) {
    return metadataScopedId;
  }

  const participantName = conversation.participant_name?.trim();
  return participantName && /^\d+$/.test(participantName) ? participantName : null;
}
