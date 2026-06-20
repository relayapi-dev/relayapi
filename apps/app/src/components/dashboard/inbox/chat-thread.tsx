import { useState, useEffect, useRef, useCallback } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { motion, AnimatePresence } from "motion/react";
import {
  Archive,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "./avatar";
import type { ConversationItem, InboxOrganizationMember, MessageItem, NoteItem, ThreadItem } from "./shared";
import {
  formatMessageDayLabel,
  formatMessageTime,
  getConversationDisplayName,
  getPlatformDisplayName,
  platformColors,
  platformLabels,
} from "./shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MessageComposer } from "./message-composer";
import { NoteCard } from "./conversation-notes";
import { AutomationBadge } from "./automation-badge";
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

interface AutomationContactControlItem {
  id: string;
  organization_id: string;
  contact_id: string;
  automation_id: string | null;
  pause_reason: string | null;
  paused_until: string | null;
  paused_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AutomationListRow {
  id: string;
  name: string;
  channel: string;
  status: string;
  description?: string | null;
}

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

interface ApiMessage {
  id: string;
  direction?: string | null;
  author_name?: string | null;
  author_avatar_url?: string | null;
  text?: string | null;
  attachments?: unknown;
  created_at: string;
}

function mapApiMessage(message: ApiMessage): MessageItem {
  return {
    id: message.id,
    sender: message.direction === "outbound" ? "user" : "participant",
    author_name: message.author_name ?? null,
    author_avatar_url: message.author_avatar_url ?? null,
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
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-xs text-center">
        <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <MessageCircle className="size-6" />
        </div>
        <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">
          No conversation selected
        </h3>
        <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
          Pick a chat from the list to read and reply across all your connected channels.
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
  onBack,
}: {
  conversation: ConversationItem | null;
  members: InboxOrganizationMember[];
  membersLoading?: boolean;
  onMessageSent?: () => void;
  onAssignmentChange?: (assignedUserId: string | null) => Promise<void>;
  onStatusChange?: (nextStatus: "open" | "archived") => Promise<void>;
  onBack?: () => void;
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
  const [automationControls, setAutomationControls] = useState<AutomationContactControlItem[]>([]);
  const [automationControlPending, setAutomationControlPending] = useState(false);
  const [automationControlError, setAutomationControlError] = useState<string | null>(null);
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
    if (!conversation || !conversation.contact_id) {
      setAutomationControls([]);
      setAutomationControlError(null);
      setAutomationControlPending(false);
      return;
    }

    const contactId = conversation.contact_id;
    let cancelled = false;
    setAutomationControlError(null);

    (async () => {
      try {
        // Plan 3 Unit C4 / V3 — migrated from the legacy
        // `/api/automations/contact-controls?conversation_id=…` route to
        // the contact-scoped `/api/contacts/{id}/automation-controls`
        // proxy that the rest of the app uses. The new API returns both
        // global pauses (automation_id = null) and per-automation pauses;
        // we treat any pause row as "automations paused" for the inbox.
        const res = await fetch(
          `/api/contacts/${encodeURIComponent(contactId)}/automation-controls`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.error?.message || `Error ${res.status}`);
        }
        const json = await res.json() as { data?: AutomationContactControlItem[] };
        if (!cancelled) {
          setAutomationControls(Array.isArray(json.data) ? json.data : []);
        }
      } catch (err) {
        if (!cancelled) {
          setAutomationControlError(
            err instanceof Error ? err.message : "Failed to load automation state",
          );
          setAutomationControls([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversation?.id, conversation?.contact_id]);

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

  const refreshAutomationControls = useCallback(async () => {
    if (!conversation?.contact_id) return;
    const res = await fetch(
      `/api/contacts/${encodeURIComponent(conversation.contact_id)}/automation-controls`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || `Error ${res.status}`);
    }
    const json = await res.json() as { data?: AutomationContactControlItem[] };
    setAutomationControls(Array.isArray(json.data) ? json.data : []);
  }, [conversation?.contact_id]);

  const handleAutomationControlToggle = useCallback(async () => {
    if (!conversation?.contact_id || automationControlPending) return;

    setAutomationControlPending(true);
    setAutomationControlError(null);

    try {
      // Plan 3 Unit C4 / V3 — pause/resume now flow through the
      // contact-scoped proxies. Omitting `automation_id` targets the
      // global pause row for this contact, which matches the inbox's
      // "all automations" toggle semantics.
      const paused = automationControls.length > 0;
      const res = await fetch(
        `/api/contacts/${encodeURIComponent(conversation.contact_id)}/${paused ? "automation-resume" : "automation-pause"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            paused
              ? {}
              : { pause_reason: "Paused from inbox thread" },
          ),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error?.message || `Error ${res.status}`);
      }
      await refreshAutomationControls();
    } catch (err) {
      setAutomationControlError(
        err instanceof Error ? err.message : "Failed to update automation state",
      );
    } finally {
      setAutomationControlPending(false);
    }
  }, [automationControlPending, automationControls.length, conversation?.contact_id, refreshAutomationControls]);

  // --- Start-an-automation picker (Plan 3 Unit C4 / Task V2) --------------
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const [startAutomationsLoading, setStartAutomationsLoading] = useState(false);
  const [startAutomations, setStartAutomations] = useState<AutomationListRow[]>([]);
  const [startAutomationsError, setStartAutomationsError] = useState<string | null>(null);
  const [startPendingId, setStartPendingId] = useState<string | null>(null);
  const [enrollNotice, setEnrollNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!enrollNotice) return;
    const id = window.setTimeout(() => setEnrollNotice(null), 3000);
    return () => window.clearTimeout(id);
  }, [enrollNotice]);

  useEffect(() => {
    if (!startDialogOpen || !conversation) return;
    let cancelled = false;
    setStartAutomationsLoading(true);
    setStartAutomationsError(null);

    (async () => {
      try {
        const url = new URL("/api/automations", window.location.origin);
        url.searchParams.set("status", "active");
        url.searchParams.set("limit", "100");
        if (conversation.platform) {
          url.searchParams.set("channel", conversation.platform);
        }
        const res = await fetch(url.toString(), {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.error?.message || `Error ${res.status}`);
        }
        const json = await res.json() as { data?: AutomationListRow[] };
        if (!cancelled) {
          setStartAutomations(Array.isArray(json.data) ? json.data : []);
        }
      } catch (err) {
        if (!cancelled) {
          setStartAutomationsError(
            err instanceof Error ? err.message : "Failed to load automations",
          );
          setStartAutomations([]);
        }
      } finally {
        if (!cancelled) setStartAutomationsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [startDialogOpen, conversation?.platform, conversation?.id]);

  const handleEnrollAutomation = useCallback(
    async (automation: AutomationListRow) => {
      if (!conversation?.contact_id || startPendingId) return;
      setStartPendingId(automation.id);
      try {
        const res = await fetch(
          `/api/automations/${encodeURIComponent(automation.id)}/enroll`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contact_id: conversation.contact_id }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error?.message || `Error ${res.status}`);
        }
        setEnrollNotice({
          kind: "ok",
          text: `Enrolled in ${automation.name}`,
        });
        setStartDialogOpen(false);
      } catch (err) {
        setEnrollNotice({
          kind: "err",
          text: err instanceof Error ? err.message : "Failed to enroll contact",
        });
      } finally {
        setStartPendingId(null);
      }
    },
    [conversation?.contact_id, startPendingId],
  );

  if (!conversation) {
    return <EmptyThreadState />;
  }

  const platform = conversation.platform?.toLowerCase() || "";
  const displayName = getConversationDisplayName(conversation);
  const platformLabel = getPlatformDisplayName(conversation.platform);
  const platformUrl = platformInboxUrls[platform];
  const isArchived = conversation.status === "archived";
  const automationsPaused = automationControls.length > 0;
  const assignedMember = members.find((member) => member.user.id === conversation.assigned_user_id);
  const assigneeLabel = assignedMember?.user.name?.trim()
    || (conversation.assigned_user_id ? "Assigned" : "Unassigned");
  const assigneeValue = conversation.assigned_user_id ?? UNASSIGNED_VALUE;

  const threadItems: ThreadItem[] = [
    ...messages.map((m) => ({ kind: "message" as const, createdAt: m.created_at, data: m })),
    ...notes.map((n) => ({ kind: "note" as const, createdAt: n.created_at, data: n })),
  ].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-3 py-2.5 sm:px-4">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
            title="Back to conversations"
          >
            <ChevronLeft className="size-5" />
          </button>
        )}

        <div className="relative shrink-0">
          <Avatar
            src={conversation.participant_avatar}
            name={displayName}
            className="size-9"
            fallbackClassName="text-sm"
          />
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 flex size-[14px] items-center justify-center rounded-full border-2 border-card text-[7px] font-bold text-white",
              platformColors[platform] || "bg-neutral-700",
            )}
          >
            {(platformLabels[platform] || platform.slice(0, 1)).charAt(0)}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[14px] font-semibold text-foreground">{displayName}</p>
            {automationsPaused && (
              <span className="hidden shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 sm:inline">
                Paused
              </span>
            )}
            {isArchived && (
              <span className="hidden shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground sm:inline">
                Archived
              </span>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className="shrink-0">{platformLabel}</span>
            <span className="text-border">·</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={assignmentPending}
                  className="inline-flex min-w-0 items-center gap-1 rounded-sm outline-none transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <span className="truncate">{assigneeLabel}</span>
                  {assignmentPending ? (
                    <Loader2 className="size-3 shrink-0 animate-spin" />
                  ) : (
                    <ChevronDown className="size-3.5 shrink-0" />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={8} className="w-[17rem] p-1.5">
                <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  Assign chat
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {membersLoading ? (
                  <div className="flex items-center gap-2 px-2 py-2 text-[13px] text-muted-foreground">
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
                      <div className="flex size-7 items-center justify-center rounded-full border border-border bg-muted text-[11px] font-semibold text-muted-foreground">
                        U
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-foreground">Unassigned</p>
                        <p className="truncate text-[11px] text-muted-foreground">No owner</p>
                      </div>
                      {assigneeValue === UNASSIGNED_VALUE && (
                        <Check className="size-4 shrink-0 text-muted-foreground" />
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
                              className="size-7 rounded-full border border-border object-cover"
                            />
                          ) : (
                            <div className="flex size-7 items-center justify-center rounded-full border border-border bg-muted text-[11px] font-semibold text-muted-foreground">
                              {memberLabel.charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-foreground">{memberLabel}</p>
                            <p className="truncate text-[11px] text-muted-foreground">{member.user.email}</p>
                          </div>
                          {assigneeValue === member.user.id && (
                            <Check className="size-4 shrink-0 text-muted-foreground" />
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

        <div className="flex shrink-0 items-center gap-1">
          {conversation.contact_id ? (
            <div className="hidden md:inline-flex">
              <AutomationBadge
                contactId={conversation.contact_id}
                channel={conversation.platform}
              />
            </div>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="More actions"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8} className="min-w-[15rem]">
              {platformUrl && (
                <DropdownMenuItem
                  onSelect={() => window.open(platformUrl, "_blank", "noopener,noreferrer")}
                  className="gap-2"
                >
                  <ExternalLink className="size-4" />
                  <span>Open in {platformLabel}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={automationControlPending || !conversation.contact_id}
                onSelect={(event) => {
                  event.preventDefault();
                  void handleAutomationControlToggle();
                }}
                className="gap-2"
              >
                {automationControlPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : automationsPaused ? (
                  <PlayCircle className="size-4" />
                ) : (
                  <PauseCircle className="size-4" />
                )}
                <span>{automationsPaused ? "Resume automations" : "Pause automations"}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!conversation.contact_id}
                onSelect={(event) => {
                  event.preventDefault();
                  if (!conversation.contact_id) return;
                  setStartDialogOpen(true);
                }}
                className="gap-2"
              >
                <Zap className="size-4" />
                <span>Start an automation</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={statusPending || !onStatusChange}
                onSelect={(event) => {
                  event.preventDefault();
                  void handleStatusButton();
                }}
                className="gap-2"
              >
                {statusPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : isArchived ? (
                  <RotateCcw className="size-4" />
                ) : (
                  <Archive className="size-4" />
                )}
                <span>{isArchived ? "Restore conversation" : "Archive conversation"}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {assignmentError && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {assignmentError}
        </div>
      )}
      {automationControlError && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {automationControlError}
        </div>
      )}

      <ScrollArea
        viewportRef={scrollContainerRef}
        viewportProps={{
          onScroll: handleScroll,
          className: "[&>div]:!block [&>div]:min-h-full",
        }}
        className="relative flex-1"
      >
        <div className="mx-auto flex min-h-full max-w-3xl flex-col px-4 py-5 sm:px-6">
          {loading ? (
            <div className="flex flex-1 items-center justify-center py-12">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="mx-auto flex max-w-xl items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : messages.length === 0 && notes.length === 0 ? (
            <div className="flex flex-1 items-center justify-center py-12">
              <div className="text-center">
                <MessageCircle className="mx-auto size-9 text-muted-foreground/40" />
                <p className="mt-3 text-[13px] font-medium text-foreground">No messages yet</p>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  When {displayName} replies, the thread will appear here.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col">
              <AnimatePresence initial={false}>
                {threadItems.map((item, index) => {
                  const prevItem = threadItems[index - 1];
                  const nextItem = threadItems[index + 1];

                  if (item.kind === "note") {
                    return (
                      <motion.div
                        key={`note-${item.data.id}`}
                        className={index === 0 ? "" : "mt-3"}
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

                  const msg = item.data;
                  const isOutbound = msg.sender === "user";

                  const samePrev =
                    prevItem?.kind === "message"
                    && prevItem.data.sender === msg.sender
                    && dayKey(prevItem.data.created_at) === dayKey(msg.created_at);
                  const sameNext =
                    nextItem?.kind === "message"
                    && nextItem.data.sender === msg.sender
                    && dayKey(nextItem.data.created_at) === dayKey(msg.created_at);

                  const previousMessage = threadItems
                    .slice(0, index)
                    .reverse()
                    .find((t) => t.kind === "message")?.data;
                  const showDayDivider =
                    !previousMessage || dayKey(previousMessage.created_at) !== dayKey(msg.created_at);

                  const hasAttachments = Boolean(msg.attachments && msg.attachments.length > 0);

                  return (
                    <motion.div
                      key={msg.id}
                      className={cn(
                        index !== 0 && !showDayDivider && (samePrev ? "mt-0.5" : "mt-3"),
                      )}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{
                        opacity: 1,
                        y: 0,
                        transition: { duration: 0.12, ease: [0.32, 0.72, 0, 1] },
                      }}
                    >
                      {showDayDivider && (
                        <div
                          className={cn(
                            "flex items-center justify-center",
                            index === 0 ? "mb-3" : "my-4",
                          )}
                        >
                          <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                            {formatMessageDayLabel(msg.created_at)}
                          </span>
                        </div>
                      )}

                      <div className={cn("flex items-end gap-2", isOutbound ? "justify-end" : "justify-start")}>
                        {!isOutbound && (
                          sameNext ? (
                            <div className="size-7 shrink-0" />
                          ) : (
                            <Avatar
                              src={msg.author_avatar_url ?? conversation.participant_avatar}
                              name={msg.author_name || displayName}
                              className="size-7 shrink-0"
                              fallbackClassName="text-[11px]"
                            />
                          )
                        )}

                        <div className={cn("flex min-w-0 max-w-[80%] flex-col", isOutbound ? "items-end" : "items-start")}>
                          {msg.text && (
                            <div
                              className={cn(
                                "rounded-2xl px-3.5 py-2 text-[14px] leading-6",
                                isOutbound
                                  ? "bg-foreground text-background"
                                  : "bg-muted text-foreground",
                                isOutbound
                                  ? (sameNext ? "rounded-br-md" : "rounded-br-sm")
                                  : (sameNext ? "rounded-bl-md" : "rounded-bl-sm"),
                              )}
                            >
                              <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                            </div>
                          )}

                          {hasAttachments && (
                            <div className={cn("space-y-2", msg.text && "mt-2")}>
                              {msg.attachments?.map((attachment, attachmentIndex) => {
                                if (attachment.type.startsWith("image/")) {
                                  return (
                                    <a
                                      key={attachmentIndex}
                                      href={attachment.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="block overflow-hidden rounded-2xl border border-border bg-card"
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
                                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
                                  >
                                    <ExternalLink className="size-3" />
                                    Attachment
                                  </a>
                                );
                              })}
                            </div>
                          )}

                          {!sameNext && (
                            <p className="mt-1 px-1 text-[10.5px] text-muted-foreground">
                              {formatMessageTime(msg.created_at)}
                            </p>
                          )}
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
              className="sticky bottom-4 z-10 flex size-9 self-center items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-popover transition-colors hover:bg-accent"
            >
              <ArrowDown className="size-4" />
            </button>
          )}
        </div>
      </ScrollArea>

      {sendError && (
        <div className="mx-3 mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive sm:mx-4">
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

      {enrollNotice && (
        <div
          className={cn(
            "pointer-events-none absolute bottom-28 left-1/2 z-40 -translate-x-1/2 rounded-full px-3 py-1.5 text-[12px] font-medium shadow-lg",
            enrollNotice.kind === "ok"
              ? "bg-foreground text-background"
              : "bg-destructive text-white",
          )}
        >
          {enrollNotice.text}
        </div>
      )}

      <Dialog open={startDialogOpen} onOpenChange={setStartDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Start an automation</DialogTitle>
            <DialogDescription>
              Enroll {displayName} in an active automation for {platformLabel}.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-2 max-h-[22rem] overflow-auto">
            {startAutomationsLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : startAutomationsError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
                {startAutomationsError}
              </div>
            ) : startAutomations.length === 0 ? (
              <div className="rounded-md border border-border bg-muted/50 px-3 py-6 text-center text-[13px] text-muted-foreground">
                No active automations available for {platformLabel}.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {startAutomations.map((automation) => {
                  const busy = startPendingId === automation.id;
                  return (
                    <li key={automation.id}>
                      <button
                        type="button"
                        onClick={() => void handleEnrollAutomation(automation)}
                        disabled={busy || startPendingId !== null}
                        className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-70"
                      >
                        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                          <Zap className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-semibold text-foreground">
                            {automation.name}
                          </p>
                          {automation.description ? (
                            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                              {automation.description}
                            </p>
                          ) : (
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              {automation.channel}
                            </p>
                          )}
                        </div>
                        {busy ? (
                          <Loader2 className="mt-1 size-4 shrink-0 animate-spin text-muted-foreground" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
