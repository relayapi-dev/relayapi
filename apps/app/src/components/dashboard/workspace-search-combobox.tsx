import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Search, FolderOpen, Plus, X, Loader2, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface WorkspaceOption {
  id: string;
  name: string;
  account_count?: number;
}

interface WorkspaceSearchComboboxProps {
  value: string | null;
  onSelect: (workspaceId: string | null, workspaceName?: string) => void;
  allowCreate?: boolean;
  showAllOption?: boolean;
  showUnassignedOption?: boolean;
  placeholder?: string;
  className?: string;
  variant?: "default" | "input";
  align?: "left" | "right";
}

export function WorkspaceSearchCombobox({
  value,
  onSelect,
  allowCreate = false,
  showAllOption = false,
  showUnassignedOption = false,
  placeholder = "Search workspaces...",
  className,
  variant = "default",
  align = "left",
}: WorkspaceSearchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const newWorkspaceInputRef = useRef<HTMLInputElement>(null);

  // Position the portal dropdown below the trigger button
  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setDropdownPos({
      top: rect.bottom + 6 + window.scrollY,
      left: align === "right" ? rect.right - Math.max(rect.width, 220) + window.scrollX : rect.left + window.scrollX,
      width: Math.max(rect.width, 220),
    });
  }, [open, align]);

  const selectedName = value === "__ungrouped"
    ? "Unassigned"
    : value
      ? workspaces.find((w) => w.id === value)?.name || ""
      : "";

  const fetchWorkspaces = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const url = new URL("/api/workspaces", window.location.origin);
      if (query) url.searchParams.set("search", query);
      url.searchParams.set("limit", "20");
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (res.ok) {
        const json = await res.json();
        setWorkspaces(json.data || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    fetchWorkspaces(search);
  }, [open]);

  // Fetch workspaces on mount when a value is pre-selected so the button label resolves
  useEffect(() => {
    if (value && value !== "__ungrouped" && workspaces.length === 0) {
      fetchWorkspaces("");
    }
  }, [value]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchWorkspaces(val), 300);
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

  const handleCreate = async () => {
    if (!newWorkspaceName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newWorkspaceName.trim() }),
      });
      if (res.ok) {
        const workspace = await res.json();
        setWorkspaces(prev => [{ id: workspace.id, name: workspace.name, account_count: 0 }, ...prev]);
        onSelect(workspace.id, workspace.name);
        setCreateDialogOpen(false);
        setOpen(false);
        setSearch("");
        setNewWorkspaceName("");
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  };

  const handleSelect = (id: string | null, name?: string) => {
    onSelect(id, name);
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
        <FolderOpen className="size-3.5 shrink-0" />
        <span className="truncate flex-1">
          {value === null && showAllOption ? "All workspaces" : selectedName || placeholder}
        </span>
        {value && value !== "__all" ? (
          <X
            className="size-3 hover:text-foreground shrink-0"
            onClick={(e) => { e.stopPropagation(); handleSelect(null); }}
          />
        ) : (
          <Search className="size-3 shrink-0 opacity-50" />
        )}
      </button>

      {open && dropdownPos && createPortal(
        <div ref={dropdownRef} data-combobox-dropdown className="fixed z-50 min-w-[220px] rounded-lg border border-border bg-background shadow-lg" style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width, position: "absolute" }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="px-2.5 pt-2.5 pb-2">
            <div className="flex items-center gap-1.5 rounded-md bg-accent/40 px-2.5 py-1.5">
              <Search className="size-3.5 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder={placeholder}
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
                All workspaces
              </button>
            )}

            {showUnassignedOption && (
              <button
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/30 transition-colors",
                  value === "__ungrouped" && "bg-accent/20 font-medium text-foreground"
                )}
                onClick={() => handleSelect("__ungrouped", "Unassigned")}
              >
                <Check className={cn("size-3 shrink-0", value === "__ungrouped" ? "opacity-100" : "opacity-0")} />
                Unassigned
              </button>
            )}

            {(showAllOption || showUnassignedOption) && workspaces.length > 0 && (
              <div className="border-t border-border my-1" />
            )}

            {workspaces.map((w) => (
              <button
                key={w.id}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/30 transition-colors",
                  value === w.id && "bg-accent/20 font-medium"
                )}
                onClick={() => handleSelect(w.id, w.name)}
              >
                <Check className={cn("size-3 shrink-0", value === w.id ? "opacity-100" : "opacity-0")} />
                <span className="truncate flex-1 text-left">{w.name}</span>
                {w.account_count !== undefined && (
                  <span className="text-[10px] text-muted-foreground shrink-0">{w.account_count}</span>
                )}
              </button>
            ))}

            {!loading && workspaces.length === 0 && !search && !allowCreate && (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">No workspaces yet</div>
            )}

            {!loading && workspaces.length === 0 && search && !allowCreate && (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">No workspaces found</div>
            )}

            {allowCreate && (
              <>
                <div className="border-t border-border my-1" />
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/30 transition-colors text-primary font-medium"
                  onClick={() => {
                    setNewWorkspaceName(search.trim());
                    setCreateDialogOpen(true);
                  }}
                >
                  <Plus className="size-3 shrink-0" />
                  New workspace
                </button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}

      {allowCreate && (
        <Dialog open={createDialogOpen} onOpenChange={(v) => { setCreateDialogOpen(v); if (!v) setNewWorkspaceName(""); }}>
          <DialogContent className="sm:max-w-sm" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="text-base">Create new workspace</DialogTitle>
              <DialogDescription>
                Enter a name for the new workspace.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleCreate();
              }}
            >
              <input
                ref={newWorkspaceInputRef}
                type="text"
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value)}
                placeholder="Workspace name"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                autoFocus
              />
              <DialogFooter className="mt-4">
                <button
                  type="button"
                  className="rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent/30 transition-colors"
                  onClick={() => setCreateDialogOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!newWorkspaceName.trim() || creating}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none flex items-center gap-1.5"
                >
                  {creating && <Loader2 className="size-3 animate-spin" />}
                  Create
                </button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// Backward-compatible alias
