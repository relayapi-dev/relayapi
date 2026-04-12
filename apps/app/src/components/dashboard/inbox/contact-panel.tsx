import { useState, useEffect } from "react";
import { Archive, ArchiveRestore, ExternalLink, Loader2, X, Link2, Unlink, Tag, Phone, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConversationItem } from "./shared";
import { formatTimeAgo, platformLabels, platformColors } from "./shared";
import { Button } from "@/components/ui/button";

interface LinkedContact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  opted_in: boolean;
  channels: Array<{
    id: string;
    platform: string;
    identifier: string;
  }>;
}

export function ContactPanel({
  conversation,
  onArchive,
  onRestore,
  onClose,
}: {
  conversation: ConversationItem;
  onArchive: () => void;
  onRestore?: () => void;
  onClose?: () => void;
}) {
  const [updating, setUpdating] = useState(false);
  const [linkedContact, setLinkedContact] = useState<LinkedContact | null>(null);
  const [contactLoading, setContactLoading] = useState(false);
  const platform = conversation.platform?.toLowerCase() || "";
  const isArchived = conversation.status === "archived";

  // Fetch linked contact if conversation has contact_id
  useEffect(() => {
    const contactId = conversation.contact_id;
    if (!contactId) {
      setLinkedContact(null);
      return;
    }
    setContactLoading(true);
    fetch(`/api/contacts/${encodeURIComponent(contactId)}`)
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          setLinkedContact(data);
        } else {
          setLinkedContact(null);
        }
      })
      .catch(() => setLinkedContact(null))
      .finally(() => setContactLoading(false));
  }, [conversation.contact_id]);

  const platformInboxUrls: Record<string, string> = {
    instagram: "https://www.instagram.com/direct/inbox/",
    facebook: "https://www.facebook.com/messages/",
    twitter: "https://x.com/messages",
    whatsapp: "https://web.whatsapp.com/",
    telegram: "https://web.telegram.org/",
    linkedin: "https://www.linkedin.com/messaging/",
    threads: "https://www.threads.net/",
  };
  const platformUrl = platformInboxUrls[platform];

  const handleStatusChange = async () => {
    setUpdating(true);
    try {
      const newStatus = isArchived ? "open" : "archived";
      const res = await fetch(`/api/inbox/conversations/${encodeURIComponent(conversation.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        if (isArchived) {
          onRestore?.();
        } else {
          onArchive();
        }
      }
    } catch {
      // silent
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-14 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground">Contact Details</span>
        {onClose && (
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Avatar & name */}
        <div className="flex flex-col items-center text-center">
          {conversation.participant_avatar ? (
            <img
              src={conversation.participant_avatar}
              alt={conversation.participant_name || ""}
              className="size-16 rounded-full border-2 border-border object-cover"
            />
          ) : (
            <div className="size-16 rounded-full border-2 border-border bg-muted flex items-center justify-center text-xl font-medium text-muted-foreground">
              {(conversation.participant_name || "?").charAt(0).toUpperCase()}
            </div>
          )}
          <p className="text-sm font-medium mt-3">{conversation.participant_name || "Unknown"}</p>
          <div className="flex items-center gap-1.5 mt-1">
            <div
              className={cn(
                "size-4 rounded flex items-center justify-center text-[7px] font-bold text-white",
                platformColors[platform] || "bg-neutral-700"
              )}
            >
              {(platformLabels[platform] || platform.slice(0, 1)).charAt(0)}
            </div>
            <span className="text-xs text-muted-foreground capitalize">
              {platformLabels[platform] || platform}
            </span>
          </div>
        </div>

        {/* Metadata */}
        <div className="space-y-3">
          <div className="text-xs">
            <span className="text-muted-foreground">Platform</span>
            <p className="font-medium capitalize mt-0.5">{platformLabels[platform] || platform}</p>
          </div>
          <div className="text-xs">
            <span className="text-muted-foreground">Last active</span>
            <p className="font-medium mt-0.5">{formatTimeAgo(conversation.updated_at)}</p>
          </div>
          {(conversation.unread_count ?? 0) > 0 && (
            <div className="text-xs">
              <span className="text-muted-foreground">Unread messages</span>
              <p className="font-medium mt-0.5">{conversation.unread_count}</p>
            </div>
          )}
        </div>

        {/* Linked Contact */}
        {contactLoading ? (
          <div className="flex justify-center py-3">
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          </div>
        ) : linkedContact ? (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Link2 className="size-3 text-muted-foreground" />
                <span className="text-[11px] font-medium text-muted-foreground">Linked Contact</span>
              </div>
            </div>
            <div className="text-xs space-y-1.5">
              <p className="font-medium">{linkedContact.name || "Unknown"}</p>
              {linkedContact.email && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Mail className="size-3" />
                  <span>{linkedContact.email}</span>
                </div>
              )}
              {linkedContact.phone && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Phone className="size-3" />
                  <span>{linkedContact.phone}</span>
                </div>
              )}
              {linkedContact.tags.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap mt-1">
                  <Tag className="size-3 text-muted-foreground" />
                  {linkedContact.tags.map((tag) => (
                    <span key={tag} className="inline-flex items-center rounded bg-accent px-1.5 py-0.5 text-[10px]">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {linkedContact.channels.length > 0 && (
                <div className="mt-2 space-y-1">
                  {linkedContact.channels.map((ch) => (
                    <div key={ch.id} className="flex items-center gap-1.5 text-muted-foreground">
                      <div className={cn("size-2 rounded-full", platformColors[ch.platform] || "bg-neutral-500")} />
                      <span className="capitalize text-[10px]">{ch.platform}</span>
                      <span className="text-[10px] font-mono">{ch.identifier}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="text-center py-2">
            <p className="text-[11px] text-muted-foreground">No linked contact</p>
          </div>
        )}

        {/* Actions */}
        <div className="space-y-2">
          {platformUrl && (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start gap-2 text-xs"
              asChild
            >
              <a href={platformUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-3" />
                View on {
                  { instagram: "Instagram", facebook: "Facebook", twitter: "X", whatsapp: "WhatsApp", telegram: "Telegram", linkedin: "LinkedIn", threads: "Threads" }[platform] || platform
                }
              </a>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 text-xs"
            onClick={handleStatusChange}
            disabled={updating}
          >
            {updating ? (
              <Loader2 className="size-3 animate-spin" />
            ) : isArchived ? (
              <ArchiveRestore className="size-3" />
            ) : (
              <Archive className="size-3" />
            )}
            {isArchived ? "Restore conversation" : "Archive conversation"}
          </Button>
        </div>
      </div>
    </div>
  );
}
