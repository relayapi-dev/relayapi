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
    <div className="flex h-full flex-col bg-white">
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center py-12">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-[#eef2f9] text-[#94a3b8]">
              <MessageSquareText className="size-5" />
            </div>
            <p className="text-sm font-medium text-slate-700">No chats found</p>
            <p className="mt-1 max-w-[15rem] text-xs text-slate-500">
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
                      "w-full border-b border-[#ececf1] px-3.5 py-3 text-left transition-colors",
                      isSelected ? "bg-[#f3f4f6]" : "hover:bg-[#fafafb]",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="relative shrink-0">
                        {conv.participant_avatar ? (
                          <img
                            src={conv.participant_avatar}
                            alt={displayName}
                            className="size-10 rounded-full border border-[#e5e7eb] object-cover"
                          />
                        ) : (
                          <div className="flex size-10 items-center justify-center rounded-full border border-[#e5e7eb] bg-[#f4f6fa] text-sm font-semibold text-slate-500">
                            {displayName.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-white text-[8px] font-bold text-white",
                            platformColors[platform] || "bg-slate-700",
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
                                "truncate text-[13px] leading-5 text-slate-900",
                                isUnread ? "font-semibold" : "font-medium",
                              )}
                            >
                              {displayName}
                            </p>
                            <p className="truncate text-[12px] text-slate-500">
                              {preview}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {isUnread && <span className="size-2 rounded-full bg-[#2d71f8]" />}
                            <span
                              className={cn(
                                "text-[11px] font-medium",
                                isUnread ? "text-[#2d71f8]" : "text-slate-400",
                              )}
                            >
                              {formatTimeAgo(conv.updated_at)}
                            </span>
                          </div>
                        </div>

                        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                          <span>{statusLabel}</span>
                          <span className="size-1 rounded-full bg-[#d0d5dd]" />
                          <span>{getPlatformDisplayName(conv.platform)}</span>
                          {isUnread && (conv.unread_count ?? 0) > 1 && (
                            <>
                              <span className="size-1 rounded-full bg-[#d0d5dd]" />
                              <span className="font-medium text-[#2d71f8]">{conv.unread_count} unread</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </motion.button>
                );
              })}
            </AnimatePresence>

            <div className="border-t border-[#ececf1] p-3">
              <LoadMore
                hasMore={hasMore}
                loading={loadingMore}
                onLoadMore={onLoadMore}
                count={conversations.length}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
