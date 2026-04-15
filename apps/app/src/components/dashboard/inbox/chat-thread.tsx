import { useState, useEffect, useRef, useCallback } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { motion, AnimatePresence } from "motion/react";
import { Loader2, MessageCircle, ArrowDown, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationItem, MessageItem } from "./shared";
import { formatTimeAgo, getConversationDisplayName, platformLabels } from "./shared";
import { MessageComposer } from "./message-composer";

export function ChatThread({
  conversation,
  onMessageSent,
}: {
  conversation: ConversationItem | null;
  onMessageSent?: () => void;
}) {
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Fetch messages when conversation changes
  useEffect(() => {
    if (!conversation) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(`/api/inbox/conversations/${encodeURIComponent(conversation.id)}`);
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          if (!cancelled) setError(err?.error?.message || "Failed to load messages");
          return;
        }
        const json = await res.json();
        if (!cancelled) {
          // The new /conversations/{id} endpoint returns { conversation, messages }
          // Map messages to the MessageItem format
          const msgs = (json.messages || json.data || []).map((m: any) => ({
            id: m.id,
            sender: m.direction === "outbound" ? "user" : "participant",
            text: m.text ?? "",
            attachments: m.attachments,
            created_at: m.created_at,
          }));
          setMessages(msgs);
        }
      } catch {
        if (!cancelled) setError("Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [conversation?.id]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0 && !loading) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, loading]);

  // Listen for incoming messages via WebSocket
  const fetchMessagesSilently = useCallback(async () => {
    if (!conversation) return;
    try {
      const res = await fetch(`/api/inbox/conversations/${encodeURIComponent(conversation.id)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return;
      const json = await res.json();
      const rawMsgs = json.messages || json.data || [];
      const fresh = rawMsgs.map((m: any) => ({
        id: m.id,
        sender: m.direction === "outbound" ? "user" : "participant",
        text: m.text ?? "",
        attachments: m.attachments,
        created_at: m.created_at,
      })) as MessageItem[];
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = fresh.filter((m) => !existingIds.has(m.id) && !m.id.startsWith("temp-"));
        if (newMsgs.length === 0) return prev;
        return [...prev, ...newMsgs];
      });
    } catch { /* silent */ }
  }, [conversation?.id]);

  useRealtimeUpdates(useCallback((event) => {
    if (
      event.type === "inbox.message.received" &&
      event.conversation_id === conversation?.id
    ) {
      fetchMessagesSilently();
    }
  }, [conversation?.id, fetchMessagesSilently]));

  // Track scroll position for "scroll to bottom" button
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollButton(distanceFromBottom > 100);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleSend = async (text: string) => {
    if (!conversation) return;

    // Optimistic insert
    const tempId = `temp-${Date.now()}`;
    const optimisticMsg: MessageItem = {
      id: tempId,
      sender: "user",
      text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const res = await fetch(`/api/inbox/conversations/${encodeURIComponent(conversation.id)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, account_id: conversation.account_id }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        // Remove optimistic message on failure
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        return;
      }
      // Replace optimistic message with real one
      setMessages((prev) =>
        prev.map((m) => m.id === tempId ? { ...m, id: json.message_id || tempId } : m)
      );
      onMessageSent?.();
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    }
  };

  // Empty state
  if (!conversation) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <MessageCircle className="size-10 text-muted-foreground/20 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Select a conversation</p>
          <p className="text-xs text-muted-foreground mt-1">Choose a conversation from the left to start messaging</p>
        </div>
      </div>
    );
  }

  const displayName = getConversationDisplayName(conversation);

  return (
    <div className="flex flex-col h-full">
      {/* Chat header */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-border shrink-0">
        {conversation.participant_avatar ? (
          <img
            src={conversation.participant_avatar}
            alt={displayName}
            className="size-8 rounded-full border border-border object-cover"
          />
        ) : (
          <div className="size-8 rounded-full border border-border bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
            {displayName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{displayName}</p>
          <p className="text-[11px] text-muted-foreground capitalize">
            {platformLabels[conversation.platform?.toLowerCase()] || conversation.platform}
          </p>
        </div>
      </div>

      {/* Messages area */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3 relative"
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive text-center">
            {error}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-xs text-muted-foreground">No messages in this conversation yet</p>
          </div>
        ) : (
          <>
            <AnimatePresence initial={false}>
            {messages.map((msg) => {
              const isOutbound = msg.sender === "user";
              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.1, ease: [0.32, 0.72, 0, 1] } }}
                  className={cn("flex", isOutbound ? "justify-end" : "justify-start")}
                >
                  <div className={cn("max-w-[75%] space-y-1")}>
                    {msg.text && (
                      <div
                        className={cn(
                          "rounded-2xl px-3.5 py-2 text-sm",
                          isOutbound
                            ? "bg-primary text-primary-foreground rounded-br-md"
                            : "bg-muted rounded-bl-md"
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                      </div>
                    )}

                    {/* Attachments */}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="space-y-1">
                        {msg.attachments.map((att, i) => {
                          if (att.type.startsWith("image/")) {
                            return (
                              <a key={i} href={att.url} target="_blank" rel="noopener noreferrer">
                                <img src={att.url} alt="" className="max-w-[200px] rounded-lg border border-border" />
                              </a>
                            );
                          }
                          return (
                            <a
                              key={i}
                              href={att.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-accent/30 transition-colors"
                            >
                              <FileText className="size-3" />
                              Attachment
                            </a>
                          );
                        })}
                      </div>
                    )}

                    <p className={cn(
                      "text-[10px] text-muted-foreground",
                      isOutbound ? "text-right" : "text-left"
                    )}>
                      {formatTimeAgo(msg.created_at)}
                    </p>
                  </div>
                </motion.div>
              );
            })}
            </AnimatePresence>
            <div ref={messagesEndRef} />
          </>
        )}

        {/* Scroll to bottom button */}
        {showScrollButton && (
          <button
            onClick={scrollToBottom}
            className="sticky bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background border border-border shadow-sm p-2 hover:bg-accent transition-colors"
          >
            <ArrowDown className="size-4 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Composer */}
      <MessageComposer
        conversationId={conversation.id}
        accountId={conversation.account_id}
        onSend={handleSend}
      />
    </div>
  );
}
