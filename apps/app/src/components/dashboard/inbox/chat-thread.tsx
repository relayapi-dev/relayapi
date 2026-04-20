import { useState, useEffect, useRef, useCallback } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { motion, AnimatePresence } from "motion/react";
import {
  Archive,
  ArrowDown,
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  MessageCircle,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationItem, InboxOrganizationMember, MessageItem, NoteItem, ThreadItem } from "./shared";
import {
  formatMessageDayLabel,
  formatMessageTime,
  getConversationDisplayName,
  getPlatformDisplayName,
} from "./shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MessageComposer } from "./message-composer";
import { NoteCard } from "./conversation-notes";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useUser } from "@/components/dashboard/user-context";

const platformInboxUrls: Record<string, string> = {
  instagram: "https://www.instagram.com/direct/inbox/",
  facebook: "https://www.facebook.com/messages/",
  twitter: "https://x.com/messages",
  whatsapp: "https://web.whatsapp.com/",
  telegram: "https://web.telegram.org/",
  linkedin: "https://www.linkedin.com/messaging/",
  threads: "https://www.threads.net/",
};

const UNASSIGNED_VALUE = "__unassigned";

function normalizeAttachments(value: unknown): Array<{ type: string; url: string }> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const rawType = "type" in item ? item.type : null;
    const rawUrl = "url" in item ? item.url : null;

    return typeof rawType === "string" && typeof rawUrl === "string"
      ? [{ type: rawType, url: rawUrl }]
      : [];
  });
}

function mapApiMessage(message: any): MessageItem {
  return {
    id: message.id,
    sender: message.direction === "outbound" ? "user" : "participant",
    author_name: message.author_name ?? null,
    text: message.text ?? "",
    attachments: normalizeAttachments(message.attachments),
    created_at: message.created_at,
  };
}

function dayKey(dateStr: string) {
  const date = new Date(dateStr);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function EmptyThreadState() {
  return (
    <div className="flex h-full items-center justify-center bg-white px-6">
      <div className="max-w-sm text-center">
        <div className="relative mx-auto mb-8 h-32 w-32">
          <div className="absolute left-3 top-11 h-11 w-11 rounded-full bg-[#64ddee]" />
          <div className="absolute left-10 top-5 h-16 w-16 rounded-full bg-[#b12a67]" />
          <div className="absolute right-7 top-[4.5rem] h-10 w-10 rounded-full bg-[#cc34d9]" />
          <div className="absolute right-0 top-10 h-4 w-14 rounded-full bg-[#64ddee]" />
          <div className="absolute right-0 top-[4.75rem] h-4 w-14 rounded-full bg-[#64ddee]" />
          <div className="absolute right-0 top-28 h-4 w-14 rounded-full bg-[#64ddee]" />
          <div className="absolute left-12 top-12 h-8 w-8 bg-[#64ddee]" />
          <div className="absolute left-20 top-20 h-8 w-8 bg-[#64ddee]" />
          <div className="absolute left-20 top-12 h-8 w-8 bg-[#b12a67]" />
          <div className="absolute left-12 top-20 h-8 w-8 bg-[#b12a67]" />
        </div>
        <h3 className="text-[28px] font-semibold tracking-tight text-slate-800">Inbox</h3>
        <p className="mt-3 text-[15px] leading-6 text-slate-500">
          This is where messages from your connected channels appear. Select a chat to continue the conversation.
        </p>
      </div>
    </div>
  );
}

export function ChatThread({
  conversation,
  members,
  membersLoading = false,
  onMessageSent,
  onAssignmentChange,
  onStatusChange,
}: {
  conversation: ConversationItem | null;
  members: InboxOrganizationMember[];
  membersLoading?: boolean;
  onMessageSent?: () => void;
  onAssignmentChange?: (assignedUserId: string | null) => Promise<void>;
  onStatusChange?: (nextStatus: "open" | "archived") => Promise<void>;
}) {
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const currentUser = useUser();
  const currentUserId = currentUser?.id ?? null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [assignmentPending, setAssignmentPending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [statusPending, setStatusPending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!conversation) {
      setMessages([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSendError(null);

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
          setMessages((json.messages || json.data || []).map(mapApiMessage));
        }
      } catch {
        if (!cancelled) setError("Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversation?.id]);

  useEffect(() => {
    setAssignmentError(null);
    setAssignmentPending(false);
  }, [conversation?.id]);

  useEffect(() => {
    if (messages.length > 0 && !loading) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, loading]);

  const fetchMessagesSilently = useCallback(async () => {
    if (!conversation) return;

    try {
      const res = await fetch(`/api/inbox/conversations/${encodeURIComponent(conversation.id)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return;

      const json = await res.json();
      const fresh = (json.messages || json.data || []).map(mapApiMessage) as MessageItem[];

      setMessages((prev) => {
        const existingIds = new Set(prev.map((message) => message.id));
        const newMessages = fresh.filter(
          (message) => !existingIds.has(message.id) && !message.id.startsWith("temp-"),
        );
        if (newMessages.length === 0) return prev;
        return [...prev, ...newMessages];
      });
    } catch {
      // Silent background refresh.
    }
  }, [conversation?.id]);

  useRealtimeUpdates(useCallback((event) => {
    if (
      event.type === "inbox.message.received"
      && event.conversation_id === conversation?.id
    ) {
      void fetchMessagesSilently();
    }
  }, [conversation?.id, fetchMessagesSilently]));

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollButton(distanceFromBottom > 120);
  }, []);

  useEffect(() => {
    if (!conversation) {
      setNotes([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/inbox/conversations/${encodeURIComponent(conversation.id)}/notes`,
        );
        if (cancelled) return;
        if (!res.ok) return;
        const json = (await res.json()) as { data?: NoteItem[] };
        if (cancelled) return;
        setNotes(Array.isArray(json.data) ? json.data : []);
      } catch {
        // Notes are non-critical; silent failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversation?.id]);

  const handleSend = async ({
    text,
    attachments,
  }: {
    text: string;
    attachments: Array<{ url: string; type: string }>;
  }) => {
    if (!conversation) return;
    setSendError(null);

    const tempId = `temp-${Date.now()}`;
    const optimisticMsg: MessageItem = {
      id: tempId,
      sender: "user",
      author_name: "You",
      text,
      created_at: new Date().toISOString(),
      attachments,
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const res = await fetch(
        `/api/inbox/conversations/${encodeURIComponent(conversation.id)}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: text || undefined,
            account_id: conversation.account_id,
            attachments: attachments.length > 0 ? attachments : undefined,
          }),
        },
      );
      const json = await res.json().catch(() => null);

      if (!res.ok) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        setSendError(json?.error?.message || json?.error || "Failed to send message");
        return;
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === tempId ? { ...m, id: json.message_id || tempId } : m,
        ),
      );
      onMessageSent?.();
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setSendError("Network error while sending the message");
    }
  };

  const handleCreateNote = async (text: string) => {
    if (!conversation) return;
    const res = await fetch(
      `/api/inbox/conversations/${encodeURIComponent(conversation.id)}/notes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      },
    );
    if (!res.ok) {
      throw new Error("Failed to save note");
    }
    const json = (await res.json()) as { note: NoteItem };
    setNotes((prev) => [...prev, json.note]);
  };

  const handleStatusButton = async () => {
    if (!conversation || !onStatusChange || statusPending) return;

    const nextStatus = conversation.status === "archived" ? "open" : "archived";
    setStatusPending(true);
    try {
      await onStatusChange(nextStatus);
    } finally {
      setStatusPending(false);
    }
  };

  const handleAssignmentSelect = async (value: string) => {
    if (!conversation || !onAssignmentChange || assignmentPending) return;

    const nextAssignedUserId = value === UNASSIGNED_VALUE ? null : value;
    if ((conversation.assigned_user_id ?? null) === nextAssignedUserId) return;

    setAssignmentPending(true);
    setAssignmentError(null);

    try {
      await onAssignmentChange(nextAssignedUserId);
    } catch (assignmentError) {
      setAssignmentError(
        assignmentError instanceof Error
          ? assignmentError.message
          : "Failed to update assignee",
      );
    } finally {
      setAssignmentPending(false);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  if (!conversation) {
    return <EmptyThreadState />;
  }

  const displayName = getConversationDisplayName(conversation);
  const platformLabel = getPlatformDisplayName(conversation.platform);
  const platformUrl = platformInboxUrls[conversation.platform?.toLowerCase() || ""];
  const isArchived = conversation.status === "archived";
  const assignedMember = members.find((member) => member.user.id === conversation.assigned_user_id);
  const assigneeLabel = assignedMember?.user.name?.trim()
    || (conversation.assigned_user_id ? "Assigned" : "Unassigned");
  const assigneeValue = conversation.assigned_user_id ?? UNASSIGNED_VALUE;

  const threadItems: ThreadItem[] = [
    ...messages.map((m) => ({ kind: "message" as const, createdAt: m.created_at, data: m })),
    ...notes.map((n) => ({ kind: "note" as const, createdAt: n.created_at, data: n })),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="border-b border-[#e7e9ef] bg-white">
        <div className="flex min-h-[52px] items-center justify-between gap-4 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            {conversation.participant_avatar ? (
              <img
                src={conversation.participant_avatar}
                alt={displayName}
                className="size-10 rounded-full border border-[#e5e7eb] object-cover"
              />
            ) : (
              <div className="flex size-10 items-center justify-center rounded-full border border-[#e5e7eb] bg-[#f4f6fa] text-sm font-semibold text-slate-500">
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}

            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold text-slate-900">{displayName}</p>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={assignmentPending}
                    className="inline-flex max-w-full items-center gap-1 rounded-sm text-[12px] text-slate-500 outline-none transition-colors hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <span className="truncate">{assigneeLabel}</span>
                    {assignmentPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <ChevronDown className="size-3.5" />
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  sideOffset={8}
                  className="w-[17rem] border-[#d9dee8] bg-white p-1.5"
                >
                  <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-slate-400">
                    Assign chat
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator className="bg-[#ececf1]" />
                  {membersLoading ? (
                    <div className="flex items-center gap-2 px-2 py-2 text-[13px] text-slate-500">
                      <Loader2 className="size-3.5 animate-spin" />
                      Loading team members
                    </div>
                  ) : (
                    <DropdownMenuRadioGroup value={assigneeValue} onValueChange={(value) => void handleAssignmentSelect(value)}>
                      <DropdownMenuRadioItem
                        value={UNASSIGNED_VALUE}
                        className="gap-3 rounded-md px-2 py-2 [&>span:first-child]:hidden"
                        disabled={assignmentPending}
                      >
                        <div className="flex size-7 items-center justify-center rounded-full border border-[#e5e7eb] bg-[#f8fafc] text-[11px] font-semibold text-slate-500">
                          U
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-slate-700">Unassigned</p>
                          <p className="truncate text-[11px] text-slate-400">No owner</p>
                        </div>
                        {assigneeValue === UNASSIGNED_VALUE && (
                          <Check className="size-4 shrink-0 text-slate-500" />
                        )}
                      </DropdownMenuRadioItem>
                      {members.map((member) => {
                        const memberLabel = member.user.name?.trim() || member.user.email;

                        return (
                          <DropdownMenuRadioItem
                            key={member.user.id}
                            value={member.user.id}
                            className="gap-3 rounded-md px-2 py-2 [&>span:first-child]:hidden"
                            disabled={assignmentPending}
                          >
                            {member.user.image ? (
                              <img
                                src={member.user.image}
                                alt={memberLabel}
                                className="size-7 rounded-full border border-[#e5e7eb] object-cover"
                              />
                            ) : (
                              <div className="flex size-7 items-center justify-center rounded-full border border-[#e5e7eb] bg-[#f8fafc] text-[11px] font-semibold text-slate-500">
                                {memberLabel.charAt(0).toUpperCase()}
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13px] font-medium text-slate-700">{memberLabel}</p>
                              <p className="truncate text-[11px] text-slate-400">{member.user.email}</p>
                            </div>
                            {assigneeValue === member.user.id && (
                              <Check className="size-4 shrink-0 text-slate-500" />
                            )}
                          </DropdownMenuRadioItem>
                        );
                      })}
                    </DropdownMenuRadioGroup>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {platformUrl && (
              <a
                href={platformUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex size-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-[#f5f6f8] hover:text-slate-800"
                title={`Open ${platformLabel}`}
              >
                <ExternalLink className="size-4" />
              </a>
            )}
            <button
              type="button"
              onClick={() => void handleStatusButton()}
              disabled={statusPending || !onStatusChange}
              className="inline-flex size-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-[#f5f6f8] hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              title={isArchived ? "Restore conversation" : "Archive conversation"}
            >
              {statusPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : isArchived ? (
                <RotateCcw className="size-4" />
              ) : (
                <Archive className="size-4" />
              )}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-[#eef0f5] px-4">
          <span className="border-b-2 border-[#2d71f8] px-1 py-2 text-[13px] font-medium text-slate-800">
            {platformLabel}
          </span>
          <div className="flex items-center gap-3 text-[12px] text-slate-400">
            <span>{assigneeLabel}</span>
            {(conversation.unread_count ?? 0) > 0 && (
              <span className="font-medium text-[#2d71f8]">{conversation.unread_count} unread</span>
            )}
            {isArchived && (
              <span className="font-medium text-slate-500">Archived</span>
            )}
          </div>
        </div>
      </div>

      {assignmentError && (
        <div className="border-b border-[#f2d2d2] bg-[#fff7f7] px-4 py-2 text-sm text-[#b14242]">
          {assignmentError}
        </div>
      )}

      <ScrollArea
        viewportRef={scrollContainerRef}
        viewportProps={{
          onScroll: handleScroll,
          className: "[&>div]:!block [&>div]:min-h-full",
        }}
        className="relative flex-1 bg-white"
      >
        <div className="flex min-h-full flex-col px-4 py-5 sm:px-6">
        {loading ? (
          <div className="flex flex-1 items-center justify-center py-12">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="mx-auto flex max-w-xl items-start gap-3 rounded-md border border-[#f2c0c0] bg-[#fff6f6] px-4 py-3 text-sm text-[#b14242]">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : messages.length === 0 && notes.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-12">
            <div className="text-center">
              <MessageCircle className="mx-auto size-9 text-slate-300" />
              <p className="mt-3 text-sm font-medium text-slate-700">No messages yet</p>
              <p className="mt-1 text-xs text-slate-500">
                When this contact replies, the thread will appear here.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <AnimatePresence initial={false}>
              {threadItems.map((item, index) => {
                if (item.kind === "note") {
                  return (
                    <motion.div
                      key={`note-${item.data.id}`}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{
                        opacity: 1,
                        y: 0,
                        transition: { duration: 0.12, ease: [0.32, 0.72, 0, 1] },
                      }}
                    >
                      <NoteCard
                        note={item.data}
                        canDelete={item.data.user_id === currentUserId}
                        onDelete={async () => {
                          const res = await fetch(
                            `/api/inbox/notes/${item.data.id}`,
                            { method: "DELETE" },
                          );
                          if (res.ok) {
                            setNotes((prev) => prev.filter((n) => n.id !== item.data.id));
                          }
                        }}
                      />
                    </motion.div>
                  );
                }

                const isOutbound = item.data.sender === "user";
                const previous = threadItems
                  .slice(0, index)
                  .reverse()
                  .find((t) => t.kind === "message")?.data;
                const showDayDivider = !previous || dayKey(previous.created_at) !== dayKey(item.data.created_at);

                return (
                  <motion.div
                    key={item.data.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{
                      opacity: 1,
                      y: 0,
                      transition: { duration: 0.12, ease: [0.32, 0.72, 0, 1] },
                    }}
                  >
                    {showDayDivider && (
                      <div className="relative my-4 flex items-center justify-center">
                        <div className="absolute inset-x-0 top-1/2 border-t border-[#ececf1]" />
                        <span className="relative bg-white px-3 text-[12px] font-medium text-slate-400">
                          {formatMessageDayLabel(item.data.created_at)}
                        </span>
                      </div>
                    )}

                    <div className={cn("flex gap-3", isOutbound ? "justify-end" : "justify-start")}>
                      {!isOutbound && (
                        conversation.participant_avatar ? (
                          <img
                            src={conversation.participant_avatar}
                            alt={displayName}
                            className="mt-1 size-8 shrink-0 rounded-full border border-[#e5e7eb] object-cover"
                          />
                        ) : (
                          <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full border border-[#e5e7eb] bg-white text-[11px] font-semibold text-slate-500">
                            {displayName.charAt(0).toUpperCase()}
                          </div>
                        )
                      )}

                      <div className="max-w-[78%] min-w-0">
                        {item.data.text && (
                          <div
                            className={cn(
                              "rounded-[18px] px-4 py-2.5 text-[14px] leading-6",
                              isOutbound
                                ? "rounded-br-md bg-[#edf3ff] text-[#304259]"
                                : "rounded-bl-md bg-[#f3f4f6] text-slate-700",
                            )}
                          >
                            <p className="whitespace-pre-wrap break-words">{item.data.text}</p>
                          </div>
                        )}

                        {item.data.attachments && item.data.attachments.length > 0 && (
                          <div className="mt-2 space-y-2">
                            {item.data.attachments.map((attachment, attachmentIndex) => {
                              if (attachment.type.startsWith("image/")) {
                                return (
                                  <a
                                    key={attachmentIndex}
                                    href={attachment.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block overflow-hidden rounded-xl border border-[#dde3ee] bg-white"
                                  >
                                    <img
                                      src={attachment.url}
                                      alt=""
                                      className="max-h-64 w-full object-cover"
                                    />
                                  </a>
                                );
                              }

                              return (
                                <a
                                  key={attachmentIndex}
                                  href={attachment.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-2 rounded-md border border-[#d9dee8] bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-[#f8f9fc]"
                                >
                                  <ExternalLink className="size-3" />
                                  Attachment
                                </a>
                              );
                            })}
                          </div>
                        )}

                        <p
                          className={cn(
                            "mt-1 px-1 text-[11px] text-slate-400",
                            isOutbound ? "text-right" : "text-left",
                          )}
                        >
                          {formatMessageTime(item.data.created_at)}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>

            <div ref={messagesEndRef} />
          </div>
        )}

        {showScrollButton && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="sticky bottom-4 left-1/2 flex -translate-x-1/2 items-center justify-center rounded-full border border-[#d9dee8] bg-white p-2 text-slate-500 shadow-sm transition-colors hover:bg-[#f8f9fc]"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
        </div>
      </ScrollArea>

      {sendError && (
        <div className="border-t border-[#f2d2d2] bg-[#fff7f7] px-4 py-2 text-sm text-[#b14242]">
          {sendError}
        </div>
      )}

      <MessageComposer
        onSend={handleSend}
        onCreateNote={handleCreateNote}
        disabled={isArchived}
        platform={conversation.platform}
        platformLabel={platformLabel}
      />
    </div>
  );
}
