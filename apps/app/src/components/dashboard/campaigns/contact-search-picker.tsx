import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Search, Loader2, X, Users, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface Contact {
  id: string;
  phone: string;
  name: string | null;
  tags?: string[];
}

interface ContactSearchPickerProps {
  accountId: string;
  selected: Contact[];
  onSelectionChange: (contacts: Contact[]) => void;
}

export function ContactSearchPicker({ accountId, selected, onSelectionChange }: ContactSearchPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!open || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setDropdownPos({
      top: rect.bottom + 4 + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
    });
  }, [open]);

  const fetchContacts = useCallback(async (query: string) => {
    if (!accountId) return;
    setLoading(true);
    try {
      const url = new URL("/api/contacts", window.location.origin);
      url.searchParams.set("account_id", accountId);
      if (query) url.searchParams.set("search", query);
      url.searchParams.set("limit", "50");
      const res = await fetch(url.toString());
      if (res.ok) {
        const json = await res.json();
        setContacts(json.data || []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  // Fetch contacts when dropdown opens or account changes
  useEffect(() => {
    if (!open || !accountId) return;
    fetchContacts(search);
  }, [open, accountId]);

  // Reset when account changes
  useEffect(() => {
    setContacts([]);
    setSearch("");
  }, [accountId]);

  const handleSearchChange = (val: string) => {
    setSearch(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchContacts(val), 300);
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

  const selectedIds = new Set(selected.map((c) => c.id));

  const toggleContact = (contact: Contact) => {
    if (selectedIds.has(contact.id)) {
      onSelectionChange(selected.filter((c) => c.id !== contact.id));
    } else {
      onSelectionChange([...selected, contact]);
    }
  };

  const removeContact = (id: string) => {
    onSelectionChange(selected.filter((c) => c.id !== id));
  };

  const selectAll = () => {
    const newSelected = [...selected];
    for (const c of contacts) {
      if (!selectedIds.has(c.id)) {
        newSelected.push(c);
      }
    }
    onSelectionChange(newSelected);
  };

  const deselectAll = () => {
    const visibleIds = new Set(contacts.map((c) => c.id));
    onSelectionChange(selected.filter((c) => !visibleIds.has(c.id)));
  };

  const allVisible = contacts.length > 0 && contacts.every((c) => selectedIds.has(c.id));

  const contactLabel = (c: Contact) => c.name || c.phone;

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger area */}
      <div
        className={cn(
          "min-h-[38px] w-full rounded-md border bg-background px-2 py-1.5 text-sm cursor-pointer transition-colors",
          open ? "border-ring ring-1 ring-ring" : "border-border hover:border-ring/50",
          !accountId && "opacity-50 pointer-events-none"
        )}
        onClick={() => { setOpen(!open); setTimeout(() => inputRef.current?.focus(), 50); }}
      >
        {selected.length === 0 ? (
          <span className="text-muted-foreground px-1 py-0.5 text-sm">
            {accountId ? "Click to select contacts..." : "Select an account first"}
          </span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {selected.map((c) => (
              <span
                key={c.id}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 text-xs"
              >
                <span className="truncate max-w-[140px]">{contactLabel(c)}</span>
                <X
                  className="size-3 text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
                  onClick={(e) => { e.stopPropagation(); removeContact(c.id); }}
                />
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Selected count */}
      {selected.length > 0 && (
        <div className="flex items-center justify-between mt-1">
          <span className="text-[11px] text-muted-foreground">
            {selected.length} contact{selected.length !== 1 ? "s" : ""} selected
          </span>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => onSelectionChange([])}
          >
            Clear all
          </button>
        </div>
      )}

      {/* Dropdown */}
      {open && dropdownPos && accountId && createPortal(
        <div
          ref={dropdownRef}
          data-combobox-dropdown
          className="fixed z-50 rounded-lg border border-border bg-background shadow-lg"
          style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width, position: "absolute" }}
        >
          {/* Search input */}
          <div className="px-2.5 pt-2.5 pb-2">
            <div className="flex items-center gap-1.5 rounded-md bg-accent/40 px-2.5 py-1.5">
              <Search className="size-3.5 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Search by name or phone..."
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                }}
              />
              {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            </div>
          </div>

          {/* Select all / deselect all */}
          {contacts.length > 0 && (
            <div className="px-3 pb-1 flex items-center justify-between">
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                onClick={allVisible ? deselectAll : selectAll}
              >
                {allVisible ? "Deselect all" : "Select all"}
              </button>
              <span className="text-[11px] text-muted-foreground">
                {contacts.length} contact{contacts.length !== 1 ? "s" : ""}
              </span>
            </div>
          )}

          {/* Contact list */}
          <div className="max-h-52 overflow-y-auto py-1">
            {contacts.map((contact) => {
              const isSelected = selectedIds.has(contact.id);
              return (
                <button
                  key={contact.id}
                  type="button"
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-1.5 text-xs hover:bg-accent/30 transition-colors text-left",
                    isSelected && "bg-accent/20"
                  )}
                  onClick={() => toggleContact(contact)}
                >
                  <div className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                    isSelected ? "border-foreground bg-foreground" : "border-border"
                  )}>
                    {isSelected && <Check className="size-3 text-background" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">
                      {contact.name || contact.phone}
                    </div>
                    {contact.name && (
                      <div className="truncate text-muted-foreground text-[11px]">
                        {contact.phone}
                      </div>
                    )}
                  </div>
                  {contact.tags && contact.tags.length > 0 && (
                    <span className="text-[10px] text-muted-foreground truncate max-w-[80px]">
                      {contact.tags[0]}
                      {contact.tags.length > 1 && ` +${contact.tags.length - 1}`}
                    </span>
                  )}
                </button>
              );
            })}

            {!loading && contacts.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center flex flex-col items-center gap-1">
                <Users className="size-4 opacity-50" />
                {search ? "No contacts found" : "No contacts for this account"}
              </div>
            )}

            {loading && contacts.length === 0 && (
              <div className="px-3 py-4 flex justify-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
