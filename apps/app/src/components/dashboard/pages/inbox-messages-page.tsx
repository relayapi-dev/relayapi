import { useState, useCallback, useDeferredValue, useEffect, useMemo, type ComponentType } from "react";
import { useRealtimeUpdates } from "@/hooks/use-post-updates";
import { useSilentRefresh } from "@/hooks/use-silent-refresh";
import {
  AlarmClockCheck,
  ChevronLeft,
  Filter,
  Heart,
  Inbox,
  Lock,
  Search,
  Settings2,
  TriangleAlert,
  UserRound,
  Users,
} from "lucide-react";
import { usePaginatedApi } from "@/hooks/use-api";
import { useUsage } from "@/hooks/use-usage";
import { useFilter, useFilterQuery } from "@/components/dashboard/filter-context";
import { useUser } from "@/components/dashboard/user-context";
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

import type { ConversationItem } from "@/components/dashboard/inbox/shared";
import { ConversationList } from "@/components/dashboard/inbox/conversation-list";
import { ChatThread } from "@/components/dashboard/inbox/chat-thread";
import { getConversationDisplayName, getPlatformDisplayName } from "@/components/dashboard/inbox/shared";

type SidebarFilterKey =
  | "all"
  | "unassigned"
  | "assigned"
  | "reminders"
  | "favorites"
  | "team";

type SidebarItem = {
  key: SidebarFilterKey;
  label: string;
  count: number;
  icon: ComponentType<{ className?: string }>;
  accentCount?: boolean;
};

const statusOptions = [
  { value: "open", label: "Open Chats" },
  { value: "archived", label: "Archived" },
] as const;

const sortOptions = [
  { value: "newest", label: "Sort: Newest" },
  { value: "oldest", label: "Sort: Oldest" },
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
    case "reminders":
    case "favorites":
      return false;
    case "team":
      return Boolean(conversation.assigned_user_id);
    default:
      return true;
  }
}

function ToolbarSelect({
  value,
  onValueChange,
  options,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        size="sm"
        className={cn(
          "h-8 min-w-[7.5rem] rounded-md border-[#d8dce5] bg-white px-3 text-[12px] font-medium text-slate-600 shadow-none hover:bg-[#f8f9fc]",
          className,
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="border-[#d9dee8] bg-white">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ScopeFiltersPanel() {
  const { workspaceId, accountId, setWorkspaceId, setAccountId } = useFilter();

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-[12px] font-semibold text-slate-800">Filters</p>
        <p className="text-[12px] leading-5 text-slate-500">
          Limit the inbox to a workspace or a specific connected account.
        </p>
      </div>

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

      {(workspaceId || accountId) && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => {
              setWorkspaceId(null);
              setAccountId(null);
            }}
            className="text-[12px] font-medium text-slate-500 transition-colors hover:text-slate-800"
          >
            Clear filters
          </button>
        </div>
      )}
    </div>
  );
}

function SidebarSection({
  title,
  items,
  active,
  onSelect,
}: {
  title?: string;
  items: SidebarItem[];
  active: SidebarFilterKey;
  onSelect: (key: SidebarFilterKey) => void;
}) {
  return (
    <div className="space-y-0.5">
      {title && (
        <div className="px-4 pb-1 pt-3 text-[11px] font-medium text-slate-400">
          {title}
        </div>
      )}
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onSelect(item.key)}
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-4 py-2 text-left transition-colors",
              isActive ? "bg-[#eceef2] text-slate-900" : "text-slate-500 hover:bg-[#f5f6f8] hover:text-slate-800",
            )}
          >
            <item.icon className="size-3.5 shrink-0" />
            <span className="flex-1 text-[13px] font-medium">{item.label}</span>
            <span className="flex items-center gap-1 text-[12px] font-medium text-slate-400">
              {item.accentCount && item.count > 0 && <span className="size-1.5 rounded-full bg-[#2d71f8]" />}
              {item.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function InboxMessagesPage() {
  const filterQuery = useFilterQuery();
  const { workspaceId, accountId } = useFilter();
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
    if (selectedConversationId || loading || visibleConversations.length === 0) return;
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches) {
      setSelectedConversationId(visibleConversations[0]!.id);
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

  const platformOptions = useMemo(() => {
    const options = Array.from(
      new Set(conversations.map((conversation) => conversation.platform).filter(Boolean)),
    ).sort((left, right) => left.localeCompare(right));

    return [
      { value: "all", label: "All Channels" },
      ...options.map((platform) => ({
        value: platform,
        label: getPlatformDisplayName(platform),
      })),
    ];
  }, [conversations]);

  const hasScopedFilters = Boolean(workspaceId || accountId);

  const sidebarSections = useMemo<Array<{ title?: string; items: SidebarItem[] }>>(() => {
    const all = conversations.length;
    const unassigned = conversations.filter((conversation) => !conversation.assigned_user_id).length;
    const assigned = user?.id
      ? conversations.filter((conversation) => conversation.assigned_user_id === user.id).length
      : 0;
    const team = conversations.filter((conversation) => conversation.assigned_user_id).length;
    return [
      {
        items: [
          { key: "all" as const, label: "All chats", count: all, icon: Inbox },
          { key: "unassigned" as const, label: "Unassigned", count: unassigned, icon: TriangleAlert, accentCount: true },
          { key: "assigned" as const, label: "Assigned to me", count: assigned, icon: UserRound },
          { key: "reminders" as const, label: "Reminders", count: 0, icon: AlarmClockCheck },
        ],
      },
      {
        title: "Labels",
        items: [
          { key: "favorites" as const, label: "Favorites", count: 0, icon: Heart },
        ],
      },
      {
        title: "Team",
        items: [
          { key: "team" as const, label: "Everyone", count: all, icon: Users },
        ],
      },
    ];
  }, [conversations, user?.id]);

  if (!isPro && usage !== null) {
    return (
      <div className="space-y-6 p-6 md:p-8">
        <div>
          <h1 className="text-lg font-medium">Messages</h1>
        </div>
        <div className="rounded-md border border-border p-12 text-center">
          <Lock className="mx-auto mb-2 size-8 text-muted-foreground/40" />
          <p className="text-sm font-medium">Pro Feature</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            Upgrade to the Pro plan to access your unified social media inbox with comments, messages, and reviews.
          </p>
          <button className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90">
            Upgrade to Pro
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-3.25rem)] flex-col bg-sidebar text-slate-900 md:h-full md:min-h-0">
      <div className="border-b border-border bg-sidebar px-4 py-2.5 md:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 md:flex-none">
            <h1 className="text-[17px] font-semibold text-slate-900">Inbox</h1>
          </div>

          <div className="relative min-w-[14rem] flex-1 md:max-w-[20rem]">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search through Inbox conversations"
              className="h-8 w-full rounded-md border border-[#d8dce5] bg-white pl-10 pr-4 text-[13px] text-slate-700 outline-none transition focus:border-[#bfd3ff] focus:ring-2 focus:ring-[#dbe8ff] placeholder:text-slate-400"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-md border border-[#d8dce5] bg-white text-slate-500 transition-colors hover:bg-[#f8f9fc] hover:text-slate-800"
              title="Inbox settings"
            >
              <Settings2 className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div className="border-b border-[#e7e9ef] bg-white px-4 py-2.5 md:hidden">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {sidebarSections.flatMap((section) => section.items).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSidebarFilter(item.key)}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                sidebarFilter === item.key
                  ? "bg-[#eceef2] text-slate-900"
                  : "bg-white text-slate-600 border border-[#d8dce5]",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
              <span className="text-[11px] text-slate-400">
                {item.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="hidden min-h-0 flex-1 md:flex">
        <aside className="flex w-[228px] shrink-0 flex-col border-r border-border bg-sidebar px-3 py-3">
          <div className="space-y-4">
            {sidebarSections.map((section) => (
              <SidebarSection
                key={section.title || "primary"}
                title={section.title}
                items={section.items}
                active={sidebarFilter}
                onSelect={setSidebarFilter}
              />
            ))}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-[#e7e9ef] bg-white px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <ToolbarSelect
                value={activeStatus}
                onValueChange={(value) => {
                  setActiveStatus(value as "open" | "archived");
                  setSelectedConversationId(null);
                  setMobileView("list");
                }}
                options={[...statusOptions]}
                className="min-w-[9rem]"
              />

              <button
                type="button"
                onClick={() => setOnlyUnread((current) => !current)}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-md border px-3 text-[12px] font-medium transition-colors",
                  onlyUnread
                    ? "border-[#bfd3ff] bg-[#eef5ff] text-[#2d71f8]"
                    : "border-[#d9dee8] bg-white text-slate-600 hover:bg-[#f8f9fc]",
                )}
              >
                <Inbox className="size-4" />
                Unread
              </button>

              <ToolbarSelect
                value={sortOrder}
                onValueChange={(value) => setSortOrder(value as "newest" | "oldest")}
                options={[...sortOptions]}
                className="min-w-[9rem]"
              />

              <ToolbarSelect
                value={platformFilter}
                onValueChange={setPlatformFilter}
                options={platformOptions}
                className="min-w-[9rem]"
              />

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "inline-flex h-8 items-center gap-2 rounded-md border px-3 text-[12px] font-medium transition-colors",
                      hasScopedFilters
                        ? "border-[#bfd3ff] bg-[#eef5ff] text-[#2d71f8]"
                        : "border-[#d9dee8] bg-white text-slate-600 hover:bg-[#f8f9fc]",
                    )}
                  >
                    <Filter className="size-4" />
                    Filter
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={8} className="w-[22rem] border-[#d9dee8] bg-white p-4">
                  <ScopeFiltersPanel />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1">
            <div className="w-[300px] shrink-0 border-r border-[#e7e9ef] bg-white">
              <ConversationList
                conversations={visibleConversations}
                selectedId={selectedConversationId}
                onSelect={handleSelectConversation}
                loading={loading || usage === null}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={loadMore}
              />
            </div>

            <div className="min-w-0 flex-1">
              <ChatThread
                conversation={selectedConversation}
                onMessageSent={handleMessageSent}
                onStatusChange={handleConversationStatusChange}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:hidden">
        <div className="border-b border-[#e7e9ef] bg-white px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <ToolbarSelect
              value={activeStatus}
              onValueChange={(value) => {
                setActiveStatus(value as "open" | "archived");
                setSelectedConversationId(null);
                setMobileView("list");
              }}
              options={[...statusOptions]}
              className="min-w-[9rem]"
            />

            <button
              type="button"
              onClick={() => setOnlyUnread((current) => !current)}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-md border px-3 text-[12px] font-medium transition-colors",
                onlyUnread
                  ? "border-[#bfd3ff] bg-[#eef5ff] text-[#2d71f8]"
                  : "border-[#d9dee8] bg-white text-slate-600 hover:bg-[#f8f9fc]",
              )}
            >
              <Inbox className="size-4" />
              Unread
            </button>

            <ToolbarSelect
              value={sortOrder}
              onValueChange={(value) => setSortOrder(value as "newest" | "oldest")}
              options={[...sortOptions]}
              className="min-w-[9rem]"
            />

            <ToolbarSelect
              value={platformFilter}
              onValueChange={setPlatformFilter}
              options={platformOptions}
              className="min-w-[9rem]"
            />

            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-8 items-center gap-2 rounded-md border px-3 text-[12px] font-medium transition-colors",
                    hasScopedFilters
                      ? "border-[#bfd3ff] bg-[#eef5ff] text-[#2d71f8]"
                      : "border-[#d9dee8] bg-white text-slate-600 hover:bg-[#f8f9fc]",
                  )}
                >
                  <Filter className="size-4" />
                  Filter
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={8} className="w-[22rem] max-w-[calc(100vw-2rem)] border-[#d9dee8] bg-white p-4">
                <ScopeFiltersPanel />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {mobileView === "list" ? (
          <div className="min-h-0 flex-1">
            <ConversationList
              conversations={visibleConversations}
              selectedId={selectedConversationId}
              onSelect={handleSelectConversation}
              loading={loading || usage === null}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadMore={loadMore}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-[#e7e9ef] bg-white px-4 py-3">
              <button
                type="button"
                onClick={() => setMobileView("list")}
                className="inline-flex items-center gap-2 text-sm font-medium text-slate-600"
              >
                <ChevronLeft className="size-4" />
                Back to conversations
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <ChatThread
                conversation={selectedConversation}
                onMessageSent={handleMessageSent}
                onStatusChange={handleConversationStatusChange}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
