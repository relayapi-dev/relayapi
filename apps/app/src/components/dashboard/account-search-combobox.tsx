import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Search, User, Loader2, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { platformColors, platformAvatars, platformLabels } from "@/lib/platform-maps";

export interface AccountOption {
  id: string;
  display_name: string | null;
  username: string | null;
  platform: string;
  avatar_url: string | null;
}

interface AccountSearchComboboxProps {
  value: string | null;
  onSelect: (accountId: string | null) => void;
  onSelectAccount?: (account: AccountOption | null) => void;
  workspaceId?: string | null;
  platforms?: string[];
  showAllOption?: boolean;
  placeholder?: string;
  className?: string;
  variant?: "default" | "input";
}

export function AccountSearchCombobox({
  value,
  onSelect,
  onSelectAccount,
  workspaceId,
  platforms,
  showAllOption = true,
  placeholder = "All accounts",
  className,
  variant = "default",
}: AccountSearchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Position the portal dropdown below the trigger button
  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setDropdownPos({
      top: rect.bottom + 6 + window.scrollY,
      left: rect.right - Math.max(rect.width, 220) + window.scrollX,
      width: Math.max(rect.width, 220),
    });
  }, [open]);

  const selectedAccount = value ? accounts.find((a) => a.id === value) : null;

  // Parents that recompute `platforms` every render (e.g. `[channel]`) would
  // otherwise break `fetchAccounts`'s identity on every parent render. Collapse
  // the array into a stable comma-joined key so we only recompute when the
  // actual contents change.
  const platformsKey = platforms?.length ? platforms.slice().sort().join(",") : "";

  const fetchAccounts = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const url = new URL("/api/accounts", window.location.origin);
      if (query) url.searchParams.set("search", query);
      if (workspaceId) url.searchParams.set("workspace_id", workspaceId);
      if (platformsKey) url.searchParams.set("platforms", platformsKey);
      url.searchParams.set("limit", "20");
      const res = await fetch(url.toString());
      if (res.ok) {
        const json = await res.json();
        setAccounts(json.data || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [workspaceId, platformsKey]);

  // Fetch accounts when dropdown opens or workspace changes
  useEffect(() => {
    if (!open) return;
    fetchAccounts(search);
  }, [open, workspaceId]);

  // Fetch accounts on mount when a value is pre-selected so the button label resolves
  useEffect(() => {
    if (value && accounts.length === 0) {
      fetchAccounts("");
    }
  }, [value]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchAccounts(val), 300);
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleSelect = (id: string | null) => {
    onSelect(id);
    const account = id ? accounts.find((a) => a.id === id) ?? null : null;
    onSelectAccount?.(account);
    setOpen(false);
    setSearch("");
  };

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => { setOpen(!open); setTimeout(() => inputRef.current?.focus(), 50); }}
        className={cn(
          "flex items-center gap-1.5 rounded-md text-muted-foreground transition-colors w-full text-left",
          variant === "input"
            ? "border border-border bg-background px-3 py-2 text-sm hover:border-ring"
            : "px-2.5 py-1.5 text-xs font-medium hover:bg-accent/50 hover:text-foreground"
        )}
      >
        <User className="size-3.5 shrink-0" />
        <span className="truncate flex-1">
          {selectedAccount
            ? `${selectedAccount.display_name || selectedAccount.username || "Account"} (${platformLabels[selectedAccount.platform?.toLowerCase()] || selectedAccount.platform})`
            : placeholder}
        </span>
        {value ? (
          <X
            className="size-3 hover:text-foreground shrink-0"
            onClick={(e) => { e.stopPropagation(); handleSelect(null); }}
          />
        ) : (
          <Search className="size-3 shrink-0 opacity-50" />
        )}
      </button>

      {open && dropdownPos && createPortal(
        <div ref={dropdownRef} data-combobox-dropdown className="fixed z-50 min-w-[220px] rounded-lg border border-border bg-background shadow-lg" style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width, position: "absolute", pointerEvents: "auto" }}>
          <div className="px-2.5 pt-2.5 pb-2">
            <div className="flex items-center gap-1.5 rounded-md bg-accent/40 px-2.5 py-1.5">
              <Search className="size-3.5 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search accounts..."
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                }}
              />
              {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            </div>
          </div>

          <div className="max-h-48 overflow-y-auto py-1">
            {showAllOption && (
              <button
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/30 transition-colors",
                  value === null && "bg-accent/20 font-medium"
                )}
                onClick={() => handleSelect(null)}
              >
                <Check className={cn("size-3 shrink-0", value === null ? "opacity-100" : "opacity-0")} />
                All accounts
              </button>
            )}

            {accounts.map((acc) => {
              const platform = acc.platform?.toLowerCase() || "";
              return (
                <button
                  key={acc.id}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/30 transition-colors",
                    value === acc.id && "bg-accent/20 font-medium"
                  )}
                  onClick={() => handleSelect(acc.id)}
                >
                  <Check className={cn("size-3 shrink-0", value === acc.id ? "opacity-100" : "opacity-0")} />
                  {acc.avatar_url ? (
                    <img src={acc.avatar_url} alt="" className="size-5 rounded-full object-cover shrink-0" />
                  ) : (
                    <div
                      className={cn(
                        "flex size-5 items-center justify-center rounded-full text-[8px] font-bold text-white shrink-0",
                        platformColors[platform] || "bg-neutral-700"
                      )}
                    >
                      {platformAvatars[platform]?.slice(0, 1) || platform.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <span className="truncate flex-1 text-left">
                    {acc.display_name || acc.username || "Account"}{" "}
                    <span className="text-muted-foreground">({platformLabels[platform] || acc.platform})</span>
                  </span>
                </button>
              );
            })}

            {!loading && accounts.length === 0 && search && (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">No accounts found</div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
