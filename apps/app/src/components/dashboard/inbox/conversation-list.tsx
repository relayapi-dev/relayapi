import { motion, AnimatePresence } from "motion/react";
import { Loader2, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationItem } from "./shared";
import {
  newItemEnter,
  formatTimeAgo,
  getConversationDisplayName,
  getPlatformDisplayName,
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
    <div className="flex h-full flex-col bg-card">
      <ScrollArea className="flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center py-12">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <MessageSquareText className="size-5" />
            </div>
            <p className="text-sm font-medium text-foreground">No chats found</p>
            <p className="mt-1 max-w-[15rem] text-xs text-muted-foreground">
              Messages matching the current inbox view will appear here.
            </p>
          </div>
        ) : (
          <div>
            <AnimatePresence initial={false}>
              {conversations.map((conv) => {
                const platform = conv.platform?.toLowerCase() || "";
                const displayName = getConversationDisplayName(conv);
                const isSelected = selectedId === conv.id;
                const isUnread = (conv.unread_count ?? 0) > 0;
                const preview = conv.last_message_text?.trim() || "No messages yet";
                const statusLabel = conv.assigned_user_id ? "Assigned" : "Unassigned";

                return (
                  <motion.button
                    key={conv.id}
                    layout
                    transition={{ layout: { duration: 0.1 } }}
                    initial={newItemEnter.initial}
                    animate={newItemEnter.animate}
                    onClick={() => onSelect(conv.id)}
                    className={cn(
                      "w-full border-b border-border px-3.5 py-3 text-left transition-colors",
                      isSelected ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="relative shrink-0">
                        <Avatar
                          src={conv.participant_avatar}
                          name={displayName}
                          className="size-10"
                          fallbackClassName="text-sm"
                        />
                        <div
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-card text-[8px] font-bold text-white",
                            platformColors[platform] || "bg-neutral-700",
                          )}
                        >
                          {(platformLabels[platform] || platform.slice(0, 1)).charAt(0)}
                        </div>
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p
                              className={cn(
                                "truncate text-[13px] leading-5 text-foreground",
                                isUnread ? "font-semibold" : "font-medium",
                              )}
                            >
                              {displayName}
                            </p>
                            <p className="truncate text-[12px] text-muted-foreground">
                              {preview}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {isUnread && <span className="size-2 rounded-full bg-foreground" />}
                            <span
                              className={cn(
                                "text-[11px] font-medium",
                                isUnread ? "text-foreground" : "text-muted-foreground",
                              )}
                            >
                              {formatTimeAgo(conv.updated_at)}
                            </span>
                          </div>
                        </div>

                        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span>{statusLabel}</span>
                          <span className="size-1 rounded-full bg-border" />
                          <span>{getPlatformDisplayName(conv.platform)}</span>
                          {isUnread && (conv.unread_count ?? 0) > 1 && (
                            <>
                              <span className="size-1 rounded-full bg-border" />
                              <span className="font-medium text-foreground">{conv.unread_count} unread</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.button>
                );
              })}
            </AnimatePresence>

            <div className="border-t border-border p-3">
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
    </div>
  );
}
