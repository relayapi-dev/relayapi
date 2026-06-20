import { useState, useCallback, useDeferredValue, useEffect, useMemo } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { useSilentRefresh } from "@/hooks/use-silent-refresh";
import { Lock, Search, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { usePaginatedApi } from "@/hooks/use-api";
import { useUsage } from "@/hooks/use-usage";
import { useFilter, useFilterQuery } from "@/components/dashboard/filter-context";
import { useUser } from "@/components/dashboard/user-context";
import { organization } from "@/lib/auth-client";
import { Segmented } from "@/components/dashboard/segmented";
import { WorkspaceSearchCombobox } from "@/components/dashboard/workspace-search-combobox";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { ConversationItem, InboxOrganizationMember } from "@/components/dashboard/inbox/shared";
import { ConversationList } from "@/components/dashboard/inbox/conversation-list";
import { ChatThread } from "@/components/dashboard/inbox/chat-thread";
import { getConversationDisplayName, getPlatformDisplayName } from "@/components/dashboard/inbox/shared";

type SidebarFilterKey = "all" | "unassigned" | "assigned";

// Soft elevation that lifts the panels off the warm canvas — the "floating" look.
const PANEL =
  "min-h-0 overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04),0_10px_24px_-14px_rgba(0,0,0,0.12)]";

const filterOptions: Array<{ value: SidebarFilterKey; label: string }> = [
  { value: "all", label: "All" },
  { value: "unassigned", label: "Unassigned" },
  { value: "assigned", label: "Mine" },
];

const statusOptions = [
  { value: "open", label: "Open" },
  { value: "archived", label: "Archived" },
] as const;

const sortOptions = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
] as const;

function matchesSidebarFilter(
  conversation: ConversationItem,
  filter: SidebarFilterKey,
  currentUserId?: string | null,
) {
  switch (filter) {
    case "all":
      return true;
    case "unassigned":
      return !conversation.assigned_user_id;
    case "assigned":
      return currentUserId ? conversation.assigned_user_id === currentUserId : false;
    default:
      return true;
  }
}

function FilterToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-accent"
    >
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-foreground" : "bg-input",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-card shadow-xs transition-all",
            checked ? "left-[1.125rem]" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}

function FiltersPanel({
  activeStatus,
  onStatusChange,
  sortOrder,
  onSortChange,
  onlyUnread,
  onUnreadChange,
  platformFilter,
  onPlatformChange,
  platformOptions,
  hasActiveFilters,
  onClearAll,
}: {
  activeStatus: "open" | "archived";
  onStatusChange: (value: "open" | "archived") => void;
  sortOrder: "newest" | "oldest";
  onSortChange: (value: "newest" | "oldest") => void;
  onlyUnread: boolean;
  onUnreadChange: (value: boolean) => void;
  platformFilter: string;
  onPlatformChange: (value: string) => void;
  platformOptions: Array<{ value: string; label: string }>;
  hasActiveFilters: boolean;
  onClearAll: () => void;
}) {
  const { workspaceId, accountId, setWorkspaceId, setAccountId } = useFilter();

  return (
    <div className="space-y-3.5">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold text-foreground">Filters</p>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClearAll}
            className="text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Reset
          </button>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Status</p>
        <Segmented
          value={activeStatus}
          onChange={onStatusChange}
          options={[...statusOptions]}
          className="w-full [&>button]:flex-1"
        />
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Sort by</p>
        <Segmented
          value={sortOrder}
          onChange={onSortChange}
          options={[...sortOptions]}
          className="w-full [&>button]:flex-1"
        />
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Channel</p>
        <Select value={platformFilter} onValueChange={onPlatformChange}>
          <SelectTrigger
            size="sm"
            className="h-8 w-full rounded-md border-border bg-background text-[13px] text-foreground"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {platformOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <FilterToggle label="Unread only" checked={onlyUnread} onChange={onUnreadChange} />

      <div>
        <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Scope</p>
        <div className="space-y-2">
          <WorkspaceSearchCombobox
            value={workspaceId}
            onSelect={(nextWorkspaceId) => {
              setWorkspaceId(nextWorkspaceId);
              setAccountId(null);
            }}
            showAllOption
            showUnassignedOption
            placeholder="All workspaces"
            variant="input"
            className="w-full"
          />
          <AccountSearchCombobox
            value={accountId}
            onSelect={setAccountId}
            workspaceId={workspaceId}
            placeholder="All accounts"
            variant="input"
            className="w-full"
          />
        </div>
      </div>
    </div>
  );
}

export function InboxMessagesPage() {
  const filterQuery = useFilterQuery();
  const { workspaceId, accountId, setWorkspaceId, setAccountId } = useFilter();
  const deferredSearch = useDeferredValue(filterQuery);
  const user = useUser();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [activeStatus, setActiveStatus] = useState<"open" | "archived">("open");
  const [sidebarFilter, setSidebarFilter] = useState<SidebarFilterKey>("all");
  const [search, setSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [members, setMembers] = useState<InboxOrganizationMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  const { usage } = useUsage();
  const isPro = usage?.plan === "pro";

  const query = useMemo(() => ({
    ...deferredSearch,
    status: activeStatus,
    type: "dm",
    ...(platformFilter !== "all" ? { platform: platformFilter } : {}),
  }), [deferredSearch, activeStatus, platformFilter]);

  const {
    data: conversations,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    setData: setConversations,
  } = usePaginatedApi<ConversationItem>(
    isPro ? "inbox/conversations" : null,
    { query },
  );

  const getConversationId = useCallback((conversation: ConversationItem) => conversation.id, []);
  const { silentRefresh } = useSilentRefresh<ConversationItem>({
    path: isPro ? "inbox/conversations" : null,
    query,
    setData: setConversations,
    getId: getConversationId,
  });

  useRealtimeUpdates(useCallback((event) => {
    if (event.type.startsWith("inbox.message")) void silentRefresh();
  }, [silentRefresh]));

  const normalizedSearch = search.trim().toLowerCase();

  const visibleConversations = useMemo(() => {
    const filtered = conversations.filter((conversation) => {
      if (!matchesSidebarFilter(conversation, sidebarFilter, user?.id)) return false;
      if (onlyUnread && (conversation.unread_count ?? 0) === 0) return false;
      if (!normalizedSearch) return true;

      const displayName = getConversationDisplayName(conversation).toLowerCase();
      const preview = conversation.last_message_text?.toLowerCase() || "";
      const participant = conversation.participant_name?.toLowerCase() || "";

      return displayName.includes(normalizedSearch)
        || preview.includes(normalizedSearch)
        || participant.includes(normalizedSearch);
    });

    return [...filtered].sort((left, right) => {
      const leftTime = new Date(left.updated_at).getTime();
      const rightTime = new Date(right.updated_at).getTime();
      return sortOrder === "newest" ? rightTime - leftTime : leftTime - rightTime;
    });
  }, [conversations, sidebarFilter, user?.id, onlyUnread, normalizedSearch, sortOrder]);

  const selectedConversation = conversations.find((conversation) => conversation.id === selectedConversationId) || null;

  useEffect(() => {
    if (!isPro) return;

    let cancelled = false;
    setMembersLoading(true);

    (async () => {
      try {
        const result = await organization.listMembers();
        if (cancelled) return;

        const raw = result.data;
        const list = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { members?: unknown })?.members)
            ? (raw as { members: unknown[] }).members
            : [];

        setMembers(list as InboxOrganizationMember[]);
      } catch {
        if (!cancelled) setMembers([]);
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isPro]);

  useEffect(() => {
    const firstConversation = visibleConversations[0];
    if (selectedConversationId || loading || !firstConversation) return;
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches) {
      setSelectedConversationId(firstConversation.id);
    }
  }, [selectedConversationId, loading, visibleConversations]);

  useEffect(() => {
    if (!selectedConversationId) return;
    const exists = conversations.some((conversation) => conversation.id === selectedConversationId);
    if (!exists) {
      setSelectedConversationId(null);
      setMobileView("list");
    }
  }, [conversations, selectedConversationId]);

  const handleSelectConversation = (id: string) => {
    setSelectedConversationId(id);
    setMobileView("chat");

    const conversation = conversations.find((item) => item.id === id);
    if (conversation && (conversation.unread_count ?? 0) > 0) {
      setConversations((prev) =>
        prev.map((item) => (item.id === id ? { ...item, unread_count: 0 } : item)),
      );
      fetch(`/api/inbox/conversations/${encodeURIComponent(id)}/read`, {
        method: "POST",
      }).catch(() => {});
    }
  };

  const handleMessageSent = () => {
    void silentRefresh();
  };

  const handleStatusFilterChange = useCallback((nextStatus: "open" | "archived") => {
    setActiveStatus(nextStatus);
    setSelectedConversationId(null);
    setMobileView("list");
  }, []);

  const handleConversationStatusChange = useCallback(async (nextStatus: "open" | "archived") => {
    if (!selectedConversationId) return;

    const res = await fetch(`/api/inbox/conversations/${encodeURIComponent(selectedConversationId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (!res.ok) return;

    setConversations((prev) => {
      if (nextStatus !== activeStatus) {
        return prev.filter((conversation) => conversation.id !== selectedConversationId);
      }

      return prev.map((conversation) =>
        conversation.id === selectedConversationId
          ? { ...conversation, status: nextStatus }
          : conversation,
      );
    });

    if (nextStatus !== activeStatus) {
      setSelectedConversationId(null);
      setMobileView("list");
    }
  }, [activeStatus, selectedConversationId, setConversations]);

  const handleConversationAssignmentChange = useCallback(async (nextAssignedUserId: string | null) => {
    if (!selectedConversationId || !selectedConversation) return;

    const res = await fetch(`/api/inbox/conversations/${encodeURIComponent(selectedConversationId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigned_user_id: nextAssignedUserId }),
    });
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      throw new Error(json?.error?.message || "Failed to assign conversation");
    }

    const updatedConversation: ConversationItem = {
      ...selectedConversation,
      assigned_user_id: nextAssignedUserId,
    };

    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === selectedConversationId
          ? { ...conversation, assigned_user_id: nextAssignedUserId }
          : conversation,
      ),
    );

    if (!matchesSidebarFilter(updatedConversation, sidebarFilter, user?.id)) {
      setSelectedConversationId(null);
      setMobileView("list");
    }
  }, [selectedConversationId, selectedConversation, setConversations, sidebarFilter, user?.id]);

  const platformOptions = useMemo(() => {
    const options = Array.from(
      new Set(conversations.map((conversation) => conversation.platform).filter(Boolean)),
    ).sort((left, right) => left.localeCompare(right));

    return [
      { value: "all", label: "All channels" },
      ...options.map((platform) => ({
        value: platform,
        label: getPlatformDisplayName(platform),
      })),
    ];
  }, [conversations]);

  const hasActiveFilters =
    activeStatus !== "open"
    || onlyUnread
    || sortOrder !== "newest"
    || platformFilter !== "all"
    || Boolean(workspaceId)
    || Boolean(accountId);

  const clearAllFilters = useCallback(() => {
    setActiveStatus("open");
    setSelectedConversationId(null);
    setMobileView("list");
    setOnlyUnread(false);
    setSortOrder("newest");
    setPlatformFilter("all");
    setWorkspaceId(null);
    setAccountId(null);
  }, [setWorkspaceId, setAccountId]);

  if (!isPro && usage !== null) {
    return (
      <div className="space-y-5 p-6 md:p-8">
        <PageHeader title="Messages" docsHref="https://docs.relayapi.dev/api-reference/inbox" />
        <div className="rounded-2xl border border-border bg-card p-12 text-center">
          <Lock className="mx-auto mb-2 size-8 text-muted-foreground/40" />
          <p className="text-sm font-medium">Pro Feature</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Upgrade to the Pro plan to access your unified social media inbox with comments, messages, and reviews.
          </p>
          <button
            type="button"
            className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Upgrade to Pro
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-3.25rem)] flex-col bg-background text-foreground md:h-full md:min-h-0">
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 md:flex-row md:gap-4 md:p-4">
        {/* Conversations */}
        <section
          className={cn(
            PANEL,
            "flex-1 flex-col md:flex md:w-[360px] md:flex-none",
            mobileView === "chat" ? "hidden" : "flex",
          )}
        >
          <div className="flex flex-col gap-2.5 border-b border-border p-3">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search conversations"
                  className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-[13px] text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30 placeholder:text-muted-foreground"
                />
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    title="Filters"
                    className={cn(
                      "relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg border transition-colors",
                      hasActiveFilters
                        ? "border-foreground/30 bg-accent text-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <SlidersHorizontal className="size-4" />
                    {hasActiveFilters && (
                      <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-foreground" />
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  sideOffset={8}
                  className="w-[20rem] max-w-[calc(100vw-2rem)] p-3"
                >
                  <FiltersPanel
                    activeStatus={activeStatus}
                    onStatusChange={handleStatusFilterChange}
                    sortOrder={sortOrder}
                    onSortChange={setSortOrder}
                    onlyUnread={onlyUnread}
                    onUnreadChange={setOnlyUnread}
                    platformFilter={platformFilter}
                    onPlatformChange={setPlatformFilter}
                    platformOptions={platformOptions}
                    hasActiveFilters={hasActiveFilters}
                    onClearAll={clearAllFilters}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <Segmented
              value={sidebarFilter}
              onChange={setSidebarFilter}
              options={filterOptions}
              className="w-full [&>button]:flex-1"
            />
          </div>

          <ConversationList
            conversations={visibleConversations}
            selectedId={selectedConversationId}
            onSelect={handleSelectConversation}
            loading={loading || usage === null}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
          />
        </section>

        {/* Chat */}
        <section
          className={cn(
            PANEL,
            "flex-1 md:block",
            mobileView === "list" ? "hidden" : "block",
          )}
        >
          <ChatThread
            conversation={selectedConversation}
            members={members}
            membersLoading={membersLoading}
            onMessageSent={handleMessageSent}
            onAssignmentChange={handleConversationAssignmentChange}
            onStatusChange={handleConversationStatusChange}
            onBack={() => setMobileView("list")}
          />
        </section>
      </div>
    </div>
  );
}
