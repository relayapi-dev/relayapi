import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Search, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationItem } from "./shared";
import { newItemEnter, formatTimeAgo, platformColors, platformLabels } from "./shared";
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
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return conversations;
    const q = search.toLowerCase();
    return conversations.filter((c) =>
      c.participant_name?.toLowerCase().includes(q) ||
      c.last_message_text?.toLowerCase().includes(q)
    );
  }, [conversations, search]);

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="px-3 h-14 flex items-center border-b border-border shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations..."
            className="w-full h-8 rounded-md border border-border bg-transparent pl-8 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-muted-foreground">
              {search ? "No conversations match your search" : "No conversations yet"}
            </p>
          </div>
        ) : (
          <div>
            <AnimatePresence initial={false}>
            {filtered.map((conv) => {
              const platform = conv.platform?.toLowerCase() || "";
              const isSelected = selectedId === conv.id;
              const isUnread = (conv.unread_count ?? 0) > 0;
              return (
                <motion.button
                  key={conv.id}
                  layout
                  transition={{ layout: { duration: 0.1 } }}
                  initial={newItemEnter.initial}
                  animate={newItemEnter.animate}
                  onClick={() => onSelect(conv.id)}
                  className={cn(
                    "w-full text-left flex items-start gap-2.5 px-3 py-3 transition-colors border-b border-border/50",
                    isSelected ? "bg-primary/5" : "hover:bg-accent/30",
                  )}
                >
                  {/* Avatar with platform badge */}
                  <div className="relative shrink-0">
                    {conv.participant_avatar ? (
                      <img
                        src={conv.participant_avatar}
                        alt={conv.participant_name || "Unknown"}
                        className="size-10 rounded-full border border-border object-cover"
                      />
                    ) : (
                      <div className="size-10 rounded-full border border-border bg-muted flex items-center justify-center text-sm font-medium text-muted-foreground">
                        {(conv.participant_name || "?").charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-4 rounded-full flex items-center justify-center text-[7px] font-bold text-white border-2 border-background",
                        platformColors[platform] || "bg-neutral-700"
                      )}
                    >
                      {(platformLabels[platform] || platform.slice(0, 1)).charAt(0)}
                    </div>
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className={cn("text-sm truncate", isUnread ? "font-semibold" : "font-medium")}>
                        {conv.participant_name || "Unknown"}
                      </span>
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                        {formatTimeAgo(conv.updated_at)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <p className={cn(
                        "text-xs truncate flex-1",
                        isUnread ? "text-foreground/80" : "text-muted-foreground"
                      )}>
                        {conv.last_message_text || "No messages"}
                      </p>
                      {isUnread && (
                        <span className="shrink-0 flex items-center justify-center size-4 rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
                          {conv.unread_count}
                        </span>
                      )}
                    </div>
                  </div>
                </motion.button>
              );
            })}
            </AnimatePresence>
            <div className="p-2">
              <LoadMore hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} count={filtered.length} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
