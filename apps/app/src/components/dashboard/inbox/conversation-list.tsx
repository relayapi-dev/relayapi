import { motion, AnimatePresence } from "motion/react";
import { Loader2, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationItem } from "./shared";
import {
  newItemEnter,
  formatTimeAgo,
  getConversationDisplayName,
  platformColors,
  platformLabels,
} from "./shared";
import { LoadMore } from "@/components/ui/load-more";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar } from "./avatar";

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  conversations: ConversationItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <ScrollArea
      className="min-h-0 flex-1"
      viewportProps={{ className: "[&>div]:!block [&>div]:min-h-full" }}
    >
      {loading ? (
        <div className="flex h-full items-center justify-center py-12">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : conversations.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
          <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <MessageSquareText className="size-5" />
          </div>
          <p className="text-[13px] font-medium text-foreground">No chats here</p>
          <p className="mt-1 max-w-[15rem] text-[12px] leading-5 text-muted-foreground">
            Conversations matching this view will show up here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5 p-2">
          <AnimatePresence initial={false}>
            {conversations.map((conv) => {
              const platform = conv.platform?.toLowerCase() || "";
              const displayName = getConversationDisplayName(conv);
              const isSelected = selectedId === conv.id;
              const unread = conv.unread_count ?? 0;
              const isUnread = unread > 0;
              const preview = conv.last_message_text?.trim() || "No messages yet";

              return (
                <motion.button
                  key={conv.id}
                  layout
                  transition={{ layout: { duration: 0.1 } }}
                  initial={newItemEnter.initial}
                  animate={newItemEnter.animate}
                  onClick={() => onSelect(conv.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors",
                    isSelected ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <div className="relative shrink-0">
                    <Avatar
                      src={conv.participant_avatar}
                      name={displayName}
                      className="size-10"
                      fallbackClassName="text-sm"
                    />
                    <span
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 flex size-[15px] items-center justify-center rounded-full border-2 border-card text-[8px] font-bold text-white",
                        platformColors[platform] || "bg-neutral-700",
                      )}
                    >
                      {(platformLabels[platform] || platform.slice(0, 1)).charAt(0)}
                    </span>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p
                        className={cn(
                          "truncate text-[13px] leading-5 text-foreground",
                          isUnread ? "font-semibold" : "font-medium",
                        )}
                      >
                        {displayName}
                      </p>
                      <span
                        className={cn(
                          "shrink-0 text-[11px] tabular-nums",
                          isUnread ? "font-medium text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {formatTimeAgo(conv.updated_at)}
                      </span>
                    </div>

                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <p
                        className={cn(
                          "truncate text-[12px] leading-5",
                          isUnread ? "text-foreground/80" : "text-muted-foreground",
                        )}
                      >
                        {preview}
                      </p>
                      {isUnread && (
                        <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-semibold tabular-nums text-background">
                          {unread > 99 ? "99+" : unread}
                        </span>
                      )}
                    </div>
                  </div>
                </motion.button>
              );
            })}
          </AnimatePresence>

          <div className="px-1 pb-1 pt-2">
            <LoadMore
              hasMore={hasMore}
              loading={loadingMore}
              onLoadMore={onLoadMore}
              count={conversations.length}
            />
          </div>
        </div>
      )}
    </ScrollArea>
  );
}
