import { useState, useEffect, useCallback } from "react";
import { Loader2, Trash2, X, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useFilter } from "@/components/dashboard/filter-context";
import { AccountSearchCombobox, type AccountOption } from "@/components/dashboard/account-search-combobox";
import { platformColors, platformLabels, platformAvatars } from "@/lib/platform-maps";

interface Channel {
  id: string;
  social_account_id: string;
  platform: string;
  identifier: string;
  created_at: string;
}

interface Contact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  opted_in: boolean;
  channels: Channel[];
  created_at: string;
}

interface ContactEditDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contact: Contact | null;
  onUpdated: () => void;
}

function identifierPlaceholder(platform: string): string {
  const p = platform?.toLowerCase() || "";
  if (p === "whatsapp" || p === "telegram" || p === "sms") return "Phone number";
  if (p === "instagram" || p === "twitter" || p === "threads" || p === "tiktok" || p === "bluesky" || p === "mastodon") return "Username";
  return "User ID";
}

export function ContactEditDialog({
  open,
  onOpenChange,
  contact,
  onUpdated,
}: ContactEditDialogProps) {
  const { workspaceId } = useFilter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [tags, setTags] = useState("");
  const [optedIn, setOptedIn] = useState(true);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Add channel inline form
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [newAccountId, setNewAccountId] = useState("");
  const [newSelectedAccount, setNewSelectedAccount] = useState<AccountOption | null>(null);
  const [newIdentifier, setNewIdentifier] = useState("");
  const [addingChannel, setAddingChannel] = useState(false);
  const [deletingChannelId, setDeletingChannelId] = useState<string | null>(null);

  // Fetch full contact detail when opened
  useEffect(() => {
    if (!contact || !open) return;
    setName(contact.name ?? "");
    setEmail(contact.email ?? "");
    setPhone(contact.phone ?? "");
    setTags((contact.tags || []).join(", "));
    setOptedIn(contact.opted_in ?? true);
    setChannels(contact.channels || []);
    setError(null);
    setConfirmDelete(false);
    setShowAddChannel(false);
    setNewAccountId("");
    setNewSelectedAccount(null);
    setNewIdentifier("");
    setLoadingDetail(true);

    fetch(`/api/contacts/${contact.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Error ${res.status}`);
        return res.json();
      })
      .then((data: Contact) => {
        setName(data.name ?? "");
        setEmail(data.email ?? "");
        setPhone(data.phone ?? "");
        setTags((data.tags || []).join(", "));
        setOptedIn(data.opted_in ?? true);
        setChannels(data.channels || []);
      })
      .catch(() => {
        // Use data from list as fallback
      })
      .finally(() => setLoadingDetail(false));
  }, [contact, open]);

  useEffect(() => {
    if (!open) setConfirmDelete(false);
  }, [open]);

  const handleSave = useCallback(async () => {
    if (!contact) return;
    setError(null);
    setSaving(true);

    const parsedTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          tags: parsedTags,
          opted_in: optedIn,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Error ${res.status}`);
        return;
      }

      onUpdated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }, [contact, name, email, phone, tags, optedIn, onUpdated, onOpenChange]);

  const handleDelete = useCallback(async () => {
    if (!contact) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}`, {
        method: "DELETE",
      });
      if (res.ok || res.status === 204) {
        onUpdated();
        onOpenChange(false);
      } else {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Delete failed: ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setDeleting(false);
    }
  }, [contact, onUpdated, onOpenChange]);

  const handleAddChannel = useCallback(async () => {
    if (!contact || !newAccountId || !newIdentifier.trim()) return;
    setAddingChannel(true);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: newAccountId,
          platform: newSelectedAccount?.platform || "",
          identifier: newIdentifier.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Error ${res.status}`);
        return;
      }
      const newChannel = await res.json();
      setChannels((prev) => [...prev, newChannel]);
      setNewAccountId("");
      setNewSelectedAccount(null);
      setNewIdentifier("");
      setShowAddChannel(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setAddingChannel(false);
    }
  }, [contact, newAccountId, newSelectedAccount, newIdentifier]);

  const handleDeleteChannel = useCallback(async (channelId: string) => {
    if (!contact) return;
    setDeletingChannelId(channelId);
    setError(null);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/channels/${channelId}`, {
        method: "DELETE",
      });
      if (res.ok || res.status === 204) {
        setChannels((prev) => prev.filter((c) => c.id !== channelId));
      } else {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Delete failed: ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setDeletingChannelId(null);
    }
  }, [contact]);

  if (!contact) return null;

  const busy = saving || deleting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Edit Contact</DialogTitle>
          <DialogDescription className="text-xs">
            Update contact information and manage platform channels.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
          <div className="space-y-3 py-2 pl-0.5 pr-6">
            {loadingDetail ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* Name */}
                <div>
                  <label htmlFor="contact-edit-name" className="text-xs font-medium text-muted-foreground">
                    Name
                  </label>
                  <input
                    id="contact-edit-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. John Doe"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                  />
                </div>

                {/* Email */}
                <div>
                  <label htmlFor="contact-edit-email" className="text-xs font-medium text-muted-foreground">
                    Email
                  </label>
                  <input
                    id="contact-edit-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="john@example.com"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                  />
                </div>

                {/* Phone */}
                <div>
                  <label htmlFor="contact-edit-phone" className="text-xs font-medium text-muted-foreground">
                    Phone
                  </label>
                  <input
                    id="contact-edit-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1234567890"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                  />
                </div>

                {/* Tags */}
                <div>
                  <label htmlFor="contact-edit-tags" className="text-xs font-medium text-muted-foreground">
                    Tags
                  </label>
                  <input
                    id="contact-edit-tags"
                    type="text"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="vip, lead, newsletter (comma-separated)"
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                  />
                </div>

                {/* Opted in */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={optedIn} onCheckedChange={(c) => setOptedIn(!!c)} />
                  <span className="text-xs text-foreground">Opted in to communications</span>
                </label>

                {/* Channels */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-muted-foreground">Channels</label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 text-xs px-2"
                      onClick={() => setShowAddChannel(!showAddChannel)}
                    >
                      <Plus className="size-3" />
                      Add channel
                    </Button>
                  </div>

                  {channels.length === 0 && !showAddChannel && (
                    <div className="rounded-md border border-dashed border-border px-3 py-3 text-center">
                      <p className="text-xs text-muted-foreground">No channels linked</p>
                    </div>
                  )}

                  {channels.length > 0 && (
                    <div className="space-y-1.5">
                      {channels.map((ch) => {
                        const platform = ch.platform?.toLowerCase() || "";
                        return (
                          <div
                            key={ch.id}
                            className="flex items-center gap-2 rounded-md border border-border bg-accent/10 px-3 py-2"
                          >
                            <div
                              className={cn(
                                "flex size-5 items-center justify-center rounded-full text-[8px] font-bold text-white shrink-0",
                                platformColors[platform] || "bg-neutral-700"
                              )}
                            >
                              {platformAvatars[platform]?.slice(0, 1) || platform.slice(0, 1).toUpperCase()}
                            </div>
                            <span className="text-xs font-medium">
                              {platformLabels[platform] || platform}
                            </span>
                            <span className="text-xs text-muted-foreground truncate flex-1">
                              {ch.identifier}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleDeleteChannel(ch.id)}
                              disabled={deletingChannelId === ch.id}
                              className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                              title="Remove channel"
                            >
                              {deletingChannelId === ch.id ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <X className="size-3" />
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {showAddChannel && (
                    <div className="mt-2 space-y-2 rounded-md border border-border bg-accent/10 p-3">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Account</label>
                        <div className="mt-1">
                          <AccountSearchCombobox
                            value={newAccountId || null}
                            onSelect={(id) => setNewAccountId(id || "")}
                            onSelectAccount={(acc) => setNewSelectedAccount(acc ?? null)}
                            workspaceId={workspaceId}
                            showAllOption={false}
                            placeholder="Select an account"
                            variant="input"
                          />
                        </div>
                      </div>
                      <div>
                        <label htmlFor="channel-identifier" className="text-xs font-medium text-muted-foreground">
                          Identifier
                        </label>
                        <input
                          id="channel-identifier"
                          type="text"
                          value={newIdentifier}
                          onChange={(e) => setNewIdentifier(e.target.value)}
                          placeholder={identifierPlaceholder(newSelectedAccount?.platform || "")}
                          className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            setShowAddChannel(false);
                            setNewAccountId("");
                            setNewSelectedAccount(null);
                            setNewIdentifier("");
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={handleAddChannel}
                          disabled={addingChannel || !newAccountId || !newIdentifier.trim()}
                        >
                          {addingChannel ? <Loader2 className="size-3 animate-spin" /> : "Add"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Error */}
                {error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="flex-row justify-between sm:justify-between">
          <div>
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sure?</span>
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  No
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={handleDelete} disabled={busy}>
                  {deleting ? <Loader2 className="size-3.5 animate-spin" /> : "Yes"}
                </Button>
              </div>
            ) : (
              <Button type="button" variant="ghost" size="icon" className="size-8 text-muted-foreground" onClick={() => setConfirmDelete(true)} disabled={busy} title="Delete">
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              disabled={busy || loadingDetail}
            >
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : "Save Changes"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
