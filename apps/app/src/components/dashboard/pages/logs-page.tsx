import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, FileText, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePagedApi } from "@/hooks/use-api";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { useFilterQuery } from "@/components/dashboard/filter-context";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.03 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.12, ease: [0.32, 0.72, 0, 1] as const } },
};

// --- Types ---

interface RequestLogEntry {
  id: string;
  method: string;
  path: string;
  status_code: number;
  response_time_ms: number;
  billable: boolean;
  created_at: string;
}

interface PostLogEntry {
  id: string;
  post_id: string;
  platform: string;
  status: string;
  platform_url: string | null;
  error: string | null;
  published_at: string | null;
  updated_at: string;
}

interface ConnectionLogEntry {
  id: string;
  platform: string;
  event: string;
  message: string | null;
  created_at: string;
}

// --- Styles ---

const levelStyles: Record<string, string> = {
  info: "text-blue-400",
  warn: "text-amber-400",
  error: "text-red-400",
};

const levelBg: Record<string, string> = {
  info: "bg-blue-400/10",
  warn: "bg-amber-400/10",
  error: "bg-red-400/10",
};

const methodColors: Record<string, string> = {
  GET: "text-blue-400 bg-blue-400/10",
  POST: "text-emerald-400 bg-emerald-400/10",
  PUT: "text-amber-400 bg-amber-400/10",
  PATCH: "text-amber-400 bg-amber-400/10",
  DELETE: "text-red-400 bg-red-400/10",
  HEAD: "text-muted-foreground bg-muted",
};

const postStatusStyles: Record<string, { text: string; bg: string }> = {
  published: { text: "text-emerald-400", bg: "bg-emerald-400/10" },
  failed: { text: "text-red-400", bg: "bg-red-400/10" },
  publishing: { text: "text-blue-400", bg: "bg-blue-400/10" },
  partial: { text: "text-amber-400", bg: "bg-amber-400/10" },
  draft: { text: "text-muted-foreground", bg: "bg-muted" },
};

const connectionEventStyles: Record<string, { text: string; bg: string }> = {
  connected: { text: "text-emerald-400", bg: "bg-emerald-400/10" },
  disconnected: { text: "text-amber-400", bg: "bg-amber-400/10" },
  token_refreshed: { text: "text-blue-400", bg: "bg-blue-400/10" },
  error: { text: "text-red-400", bg: "bg-red-400/10" },
};

// --- Helpers ---

function statusLevel(code: number): string {
  if (code >= 500) return "error";
  if (code >= 400) return "warn";
  return "info";
}

function postLevel(status: string): string {
  if (status === "failed") return "error";
  if (status === "partial") return "warn";
  return "info";
}

function connectionLevel(event: string): string {
  if (event === "error") return "error";
  if (event === "disconnected") return "warn";
  return "info";
}

function formatTime(ts: string | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// --- Config ---

const tabs = [
  { key: "api", label: "API Requests" },
  { key: "posts", label: "Posts" },
  { key: "connections", label: "Connections" },
] as const;

const levelFilters = ["All", "Info", "Warn", "Error"] as const;

const endpointMap: Record<string, string> = {
  api: "usage/logs",
  posts: "posts/logs",
  connections: "connections/logs",
};

// --- Main component ---

export function LogsPage({
  initialTab = "api",
}: {
  initialTab?: "api" | "posts" | "connections";
} = {}) {
  const filterQuery = useFilterQuery();
  const [activeTab, setActiveTab] = useState(initialTab);
  const [levelFilter, setLevelFilter] = useState<string>("All");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  const switchTab = (tab: typeof initialTab) => {
    setActiveTab(tab);
    setLevelFilter("All");
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  };

  const dateQuery: Record<string, string | undefined> = {
    from: dateFrom ? new Date(dateFrom).toISOString() : undefined,
    to: dateTo ? new Date(dateTo).toISOString() : undefined,
  };

  const {
    data: logs,
    loading,
    error,
    page,
    totalPages,
    goToPage,
  } = usePagedApi<RequestLogEntry | PostLogEntry | ConnectionLogEntry>(
    endpointMap[activeTab] || null,
    { query: { ...dateQuery, ...filterQuery } },
  );

  const filtered = levelFilter === "All"
    ? logs
    : logs.filter((l) => {
        if (activeTab === "api") return statusLevel((l as RequestLogEntry).status_code) === levelFilter.toLowerCase();
        if (activeTab === "posts") return postLevel((l as PostLogEntry).status) === levelFilter.toLowerCase();
        return connectionLevel((l as ConnectionLogEntry).event) === levelFilter.toLowerCase();
      });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-medium">Logs</h1>
        <a href="https://docs.relayapi.dev/api-reference/usage/listRequestLogs" target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground transition-colors"><BookOpen className="size-3.5" /></a>
      </div>

      <div className="flex items-end justify-between gap-x-4 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        <div className="flex gap-4 shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => switchTab(tab.key)}
              className={cn(
                "pb-2 text-[13px] font-medium transition-colors whitespace-nowrap border-b-2 -mb-px",
                activeTab === tab.key
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="pb-2 shrink-0">
          <FilterBar />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex gap-3">
          {levelFilters.map((f) => (
            <button
              key={f}
              onClick={() => setLevelFilter(f)}
              className={cn(
                "text-[13px] font-medium transition-colors",
                levelFilter === f
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-[13px] text-muted-foreground shrink-0">From</label>
          <input
            type="datetime-local"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="text-[13px] bg-transparent border border-border rounded-md px-2 py-1 text-foreground [&::-webkit-calendar-picker-indicator]:dark:invert"
          />
          <label className="text-[13px] text-muted-foreground shrink-0">To</label>
          <input
            type="datetime-local"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="text-[13px] bg-transparent border border-border rounded-md px-2 py-1 text-foreground [&::-webkit-calendar-picker-indicator]:dark:invert"
          />
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(""); setDateTo(""); }}
              className="text-[13px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-12 text-center">
          <FileText className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No logs found</p>
          <p className="text-xs text-muted-foreground mt-1">
            Logs will appear here as your API processes requests
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-md border border-border overflow-hidden font-mono text-[11px]">
            <motion.div
              className="divide-y divide-border"
              variants={stagger}
              initial={false}
              animate="visible"
              key={`${activeTab}-${levelFilter}`}
            >
              {filtered.map((log) => {
                if (activeTab === "api") return <RequestLogRow key={log.id} log={log as RequestLogEntry} />;
                if (activeTab === "posts") return <PostLogRow key={log.id} log={log as PostLogEntry} />;
                return <ConnectionLogRow key={log.id} log={log as ConnectionLogEntry} />;
              })}
            </motion.div>
          </div>
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} goToPage={goToPage} />
          )}
        </>
      )}
    </div>
  );
}

// --- Row components ---

function RequestLogRow({ log }: { log: RequestLogEntry }) {
  const level = statusLevel(log.status_code);
  return (
    <motion.div
      variants={fadeUp}
      className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 hover:bg-accent/30 transition-colors"
    >
      <span className="text-muted-foreground shrink-0 w-14 tabular-nums hidden sm:block">
        {formatTime(log.created_at)}
      </span>
      <span
        className={cn(
          "shrink-0 w-11 rounded px-1 py-0.5 text-center text-[10px] font-semibold uppercase",
          methodColors[log.method] || "text-blue-400 bg-blue-400/10"
        )}
      >
        {log.method}
      </span>
      <span
        className={cn(
          "shrink-0 w-9 rounded px-1 py-0.5 text-center text-[10px] font-semibold",
          levelStyles[level],
          levelBg[level]
        )}
      >
        {log.status_code}
      </span>
      <span className="text-foreground/70 flex-1 min-w-0 truncate">
        {log.path}
      </span>
      <span className="text-muted-foreground shrink-0 tabular-nums">
        {log.response_time_ms}ms
      </span>
      {log.billable && (
        <span className="shrink-0 text-[10px] text-amber-400/70">$</span>
      )}
    </motion.div>
  );
}

function PostLogRow({ log }: { log: PostLogEntry }) {
  const style = postStatusStyles[log.status] ?? postStatusStyles.draft!;
  return (
    <motion.div
      variants={fadeUp}
      className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 hover:bg-accent/30 transition-colors"
    >
      <span className="text-muted-foreground shrink-0 w-14 tabular-nums hidden sm:block">
        {formatTime(log.updated_at)}
      </span>
      <span
        className={cn(
          "shrink-0 w-18 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase",
          style.text,
          style.bg
        )}
      >
        {log.status}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground w-16 truncate">
        {log.platform}
      </span>
      <span className="text-foreground/70 flex-1 min-w-0 truncate">
        {log.error || log.platform_url || log.post_id}
      </span>
    </motion.div>
  );
}

function ConnectionLogRow({ log }: { log: ConnectionLogEntry }) {
  const style = connectionEventStyles[log.event] ?? connectionEventStyles.error!;
  return (
    <motion.div
      variants={fadeUp}
      className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2 hover:bg-accent/30 transition-colors"
    >
      <span className="text-muted-foreground shrink-0 w-14 tabular-nums hidden sm:block">
        {formatTime(log.created_at)}
      </span>
      <span
        className={cn(
          "shrink-0 w-24 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase",
          style.text,
          style.bg
        )}
      >
        {log.event}
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground w-16 truncate">
        {log.platform}
      </span>
      <span className="text-foreground/70 flex-1 min-w-0 truncate">
        {log.message || ""}
      </span>
    </motion.div>
  );
}

// --- Pagination ---

function getPageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const pages: (number | "...")[] = [];
  // Always show first page
  pages.push(0);
  if (current > 2) pages.push("...");
  // Pages around current
  for (let i = Math.max(1, current - 1); i <= Math.min(total - 2, current + 1); i++) {
    pages.push(i);
  }
  if (current < total - 3) pages.push("...");
  // Always show last page
  pages.push(total - 1);
  return pages;
}

function Pagination({ page, totalPages, goToPage }: { page: number; totalPages: number; goToPage: (p: number) => void }) {
  const pages = getPageNumbers(page, totalPages);
  return (
    <div className="flex items-center justify-center gap-1">
      <button
        onClick={() => goToPage(page - 1)}
        disabled={page === 0}
        className={cn(
          "text-[13px] font-medium px-2.5 py-1.5 rounded-md transition-colors",
          page > 0
            ? "text-foreground hover:bg-accent"
            : "text-muted-foreground/40 cursor-not-allowed"
        )}
      >
        Prev
      </button>
      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`ellipsis-${i}`} className="text-[13px] text-muted-foreground px-1.5">
            ...
          </span>
        ) : (
          <button
            key={p}
            onClick={() => goToPage(p)}
            className={cn(
              "text-[13px] font-medium size-8 rounded-md transition-colors tabular-nums",
              p === page
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {p + 1}
          </button>
        )
      )}
      <button
        onClick={() => goToPage(page + 1)}
        disabled={page >= totalPages - 1}
        className={cn(
          "text-[13px] font-medium px-2.5 py-1.5 rounded-md transition-colors",
          page < totalPages - 1
            ? "text-foreground hover:bg-accent"
            : "text-muted-foreground/40 cursor-not-allowed"
        )}
      >
        Next
      </button>
    </div>
  );
}
