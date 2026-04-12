import { useState, useEffect, useRef, useCallback } from "react";
import { Search, Loader2, Check, X, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AdAccountOption {
  id: string;
  platform: string;
  platform_ad_account_id: string;
  name: string | null;
  currency: string | null;
  social_account_id: string;
}

interface AdAccountComboboxProps {
  value: string;
  onSelect: (id: string) => void;
  workspaceId?: string | null;
  showAllOption?: boolean;
  placeholder?: string;
  className?: string;
}

const platformLabels: Record<string, string> = {
  meta: "Meta", google: "Google", tiktok: "TikTok",
  linkedin: "LinkedIn", pinterest: "Pinterest", twitter: "X",
};

const platformColors: Record<string, string> = {
  meta: "bg-blue-600", google: "bg-emerald-600", tiktok: "bg-pink-600",
  linkedin: "bg-sky-600", pinterest: "bg-red-600", twitter: "bg-neutral-600",
};

export function AdAccountCombobox({
  value,
  onSelect,
  workspaceId,
  showAllOption = false,
  placeholder = "Select ad account...",
  className,
}: AdAccountComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [accounts, setAccounts] = useState<AdAccountOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedAccount = value ? accounts.find((a) => a.id === value) : null;

  const fetchAccounts = useCallback(async (query?: string, cursor?: string | null) => {
    const isLoadMore = !!cursor;
    if (isLoadMore) setLoadingMore(true);
    else setLoading(true);
    try {
      const url = new URL("/api/ads/accounts", window.location.origin);
      if (workspaceId) url.searchParams.set("workspace_id", workspaceId);
      if (query) url.searchParams.set("q", query);
      if (cursor) url.searchParams.set("cursor", cursor);
      url.searchParams.set("limit", "20");
      const res = await fetch(url.toString());
      if (res.ok) {
        const json = await res.json();
        if (isLoadMore) {
          setAccounts((prev) => [...prev, ...(json.data || [])]);
        } else {
          setAccounts(json.data || []);
        }
        cursorRef.current = json.next_cursor ?? null;
        setHasMore(json.has_more ?? false);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [workspaceId]);

  const loadMore = useCallback(() => {
    if (cursorRef.current && !loadingMore) {
      fetchAccounts(search || undefined, cursorRef.current);
    }
  }, [fetchAccounts, search, loadingMore]);

  useEffect(() => {
    if (open) fetchAccounts(search || undefined);
  }, [open, workspaceId, fetchAccounts]);

  useEffect(() => {
    if (value && accounts.length === 0) fetchAccounts();
  }, [value, accounts.length, fetchAccounts]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    cursorRef.current = null;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchAccounts(val || undefined), 300);
  };

  const handleSelect = (id: string) => {
    onSelect(id);
    setOpen(false);
    setSearch("");
  };

  const label = selectedAccount
    ? (selectedAccount.name || selectedAccount.platform_ad_account_id)
    : placeholder;

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => { setOpen(!open); setTimeout(() => inputRef.current?.focus(), 50); }}
        className="flex items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors w-full text-left h-9"
      >
        <Building2 className="size-3.5 shrink-0" />
        <span className="truncate flex-1">
          {label}
          {selectedAccount && (
            <span className="text-muted-foreground/60 ml-1">({platformLabels[selectedAccount.platform] || selectedAccount.platform})</span>
          )}
        </span>
        {value ? (
          <X
            className="size-3 hover:text-foreground shrink-0"
            onClick={(e) => { e.stopPropagation(); onSelect(""); }}
          />
        ) : (
          <Search className="size-3 shrink-0 opacity-50" />
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-50 w-full min-w-[260px] rounded-lg border border-border bg-background shadow-lg">
          <div className="px-2.5 pt-2.5 pb-2">
            <div className="flex items-center gap-1.5 rounded-md bg-accent/40 px-2.5 py-1.5">
              <Search className="size-3.5 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search ad accounts..."
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
              />
              {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            </div>
          </div>

          <div className="max-h-48 overflow-y-auto py-1">
            {showAllOption && (
              <button
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/30 transition-colors",
                  !value && "bg-accent/20 font-medium",
                )}
                onClick={() => { onSelect(""); setOpen(false); }}
              >
                <Check className={cn("size-3 shrink-0", !value ? "opacity-100" : "opacity-0")} />
                All ad accounts
              </button>
            )}

            {accounts.map((acc) => (
              <button
                key={acc.id}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/30 transition-colors",
                  value === acc.id && "bg-accent/20 font-medium",
                )}
                onClick={() => handleSelect(acc.id)}
              >
                <Check className={cn("size-3 shrink-0", value === acc.id ? "opacity-100" : "opacity-0")} />
                <div
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full text-[8px] font-bold text-white shrink-0",
                    platformColors[acc.platform] || "bg-neutral-700",
                  )}
                >
                  {(platformLabels[acc.platform] || acc.platform).slice(0, 1)}
                </div>
                <div className="flex-1 text-left truncate">
                  <span>{acc.name || acc.platform_ad_account_id}</span>
                  {acc.name && (
                    <span className="text-muted-foreground/60 ml-1 text-[10px]">{acc.platform_ad_account_id}</span>
                  )}
                </div>
              </button>
            ))}

            {!loading && accounts.length === 0 && (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">
                {search ? "No matching ad accounts" : "No ad accounts found"}
              </div>
            )}

            {hasMore && (
              <button
                className="w-full px-3 py-1.5 text-xs text-primary hover:bg-accent/30 transition-colors text-center font-medium"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <Loader2 className="size-3 animate-spin mx-auto" />
                ) : (
                  "Load more..."
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
