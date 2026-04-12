import { useState, useCallback, useMemo } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { useSilentRefresh } from "@/hooks/use-silent-refresh";
import { Lock, BookOpen, MessageCircle, PanelRightClose, PanelRightOpen, ArrowLeft, Archive, Inbox } from "lucide-react";
import { usePaginatedApi } from "@/hooks/use-api";
import { useUsage } from "@/hooks/use-usage";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { useFilterQuery } from "@/components/dashboard/filter-context";
import { cn } from "@/lib/utils";

import type { ConversationItem } from "@/components/dashboard/inbox/shared";
import { ConversationList } from "@/components/dashboard/inbox/conversation-list";
import { ChatThread } from "@/components/dashboard/inbox/chat-thread";
import { ContactPanel } from "@/components/dashboard/inbox/contact-panel";

const statusTabs = [
  { key: "open", label: "Open", icon: Inbox },
  { key: "archived", label: "Archived", icon: Archive },
] as const;

export function InboxMessagesPage() {
  const filterQuery = useFilterQuery();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [activeStatus, setActiveStatus] = useState<"open" | "archived">("open");

  const { usage } = useUsage();
  const isPro = usage?.plan === "pro";

  const query = useMemo(() => ({
    ...filterQuery,
    status: activeStatus,
    type: "dm",
  }), [filterQuery, activeStatus]);

  const {
    data: conversations,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    refetch,
    setData: setConversations,
  } = usePaginatedApi<ConversationItem>(
    isPro ? "inbox/conversations" : null,
    { query },
  );

  const getConversationId = useCallback((c: ConversationItem) => c.id, []);
  const { silentRefresh } = useSilentRefresh<ConversationItem>({
    path: isPro ? "inbox/conversations" : null,
    query,
    setData: setConversations,
    getId: getConversationId,
  });

  useRealtimeUpdates(useCallback((event) => {
    if (event.type.startsWith("inbox.message")) silentRefresh();
  }, [silentRefresh]));

  const selectedConversation = conversations.find((c) => c.id === selectedConversationId) || null;

  const handleSelectConversation = (id: string) => {
    setSelectedConversationId(id);
    setMobileView("chat");

    // Mark conversation as read: clear locally + fire API call
    const conv = conversations.find((c) => c.id === id);
    if (conv && (conv.unread_count ?? 0) > 0) {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, unread_count: 0 } : c)),
      );
      fetch(`/api/inbox/conversations/${encodeURIComponent(id)}/read`, {
        method: "POST",
      }).catch(() => {});
    }
  };

  const handleArchive = () => {
    setConversations((prev) => prev.filter((c) => c.id !== selectedConversationId));
    setSelectedConversationId(null);
    setMobileView("list");
  };

  const handleRestore = () => {
    setConversations((prev) => prev.filter((c) => c.id !== selectedConversationId));
    setSelectedConversationId(null);
    setMobileView("list");
  };

  const switchStatus = (status: "open" | "archived") => {
    setActiveStatus(status);
    setSelectedConversationId(null);
    setMobileView("list");
  };

  const handleMessageSent = () => {
    silentRefresh();
  };

  if (!isPro && usage !== null) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Messages</h1>
          <a href="https://docs.relayapi.dev/api-reference/inbox" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
        </div>
        <div className="rounded-md border border-border p-12 text-center">
          <Lock className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-medium">Pro Feature</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
            Upgrade to the Pro plan to access your unified social media inbox with comments, messages, and reviews.
          </p>
          <button className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors">
            Upgrade to Pro
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Messages</h1>
          <a href="https://docs.relayapi.dev/api-reference/inbox" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
          {/* Status tabs */}
          <div className="flex items-center ml-4 border-b border-border">
            {statusTabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => switchStatus(tab.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px",
                  activeStatus === tab.key
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <tab.icon className="size-3" />
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Contact panel toggle (desktop only) */}
          <button
            onClick={() => setContactPanelOpen(!contactPanelOpen)}
            className="hidden md:inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors h-7 px-2"
            title={contactPanelOpen ? "Hide details" : "Show details"}
          >
            {contactPanelOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}
          </button>
          <FilterBar />
        </div>
      </div>

      {/* Desktop: three-column layout */}
      <div
        className="hidden md:flex rounded-lg border border-border overflow-hidden bg-background"
        style={{ height: "calc(-7rem + 100vh)" }}
      >
        {/* Left: conversation list */}
        <div className="w-[300px] shrink-0 border-r border-border">
          <ConversationList
            conversations={conversations}
            selectedId={selectedConversationId}
            onSelect={handleSelectConversation}
            loading={loading || usage === null}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
          />
        </div>

        {/* Center: chat thread */}
        <div className="flex-1 min-w-0 flex flex-col">
          <ChatThread
            conversation={selectedConversation}
            onMessageSent={handleMessageSent}
          />
        </div>

        {/* Right: contact panel (collapsible) */}
        {contactPanelOpen && selectedConversation && (
          <div className="w-[280px] shrink-0 border-l border-border">
            <ContactPanel
              conversation={selectedConversation}
              onArchive={handleArchive}
              onRestore={handleRestore}
            />
          </div>
        )}
      </div>

      {/* Mobile: stacked navigation */}
      <div className="md:hidden">
        {mobileView === "list" ? (
          <div className="rounded-lg border border-border overflow-hidden" style={{ height: "calc(-7rem + 100vh)" }}>
            <ConversationList
              conversations={conversations}
              selectedId={selectedConversationId}
              onSelect={handleSelectConversation}
              loading={loading || usage === null}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadMore={loadMore}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <button
              onClick={() => { setMobileView("list"); setSelectedConversationId(null); }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="size-3" />
              Back to conversations
            </button>
            <div className="rounded-lg border border-border overflow-hidden" style={{ height: "calc(-9rem + 100vh)" }}>
              <ChatThread
                conversation={selectedConversation}
                onMessageSent={handleMessageSent}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
