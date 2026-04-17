import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, Users, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";
import { FilterBar } from "@/components/dashboard/filter-bar";
import { useFilterQuery } from "@/components/dashboard/filter-context";
import { platformColors, platformAvatars, platformLabels } from "@/lib/platform-maps";
import { ContactCreateDialog } from "@/components/dashboard/contacts/contact-create-dialog";
import { ContactEditDialog } from "@/components/dashboard/contacts/contact-edit-dialog";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

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

export function ContactsPage() {
  const filterQuery = useFilterQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);

  const {
    data: contacts,
    loading,
    error,
    hasMore,
    loadMore,
    loadingMore,
    refetch,
  } = usePaginatedApi<Contact>("contacts", { query: filterQuery });

  const openEdit = (contact: Contact) => {
    setEditContact(contact);
    setEditOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Contacts</h1>
        <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" />
          Add Contact
        </Button>
      </div>

      <div className="flex items-end justify-between gap-x-4 border-b border-border">
        <div />
        <div className="pb-2 shrink-0">
          <FilterBar />
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
      ) : contacts.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-12 text-center">
          <Users className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No contacts yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Add contacts to manage your audience across platforms
          </p>
        </div>
      ) : (
        <>
          <motion.div
            className="rounded-md border border-border overflow-hidden"
            variants={stagger}
            initial="hidden"
            animate="visible"
          >
            {/* Table header */}
            <div className="hidden md:grid grid-cols-[1.5fr_1.2fr_1fr_1fr_0.8fr] gap-4 px-4 py-2.5 text-xs font-medium text-muted-foreground border-b border-border bg-accent/10">
              <span>Name</span>
              <span>Email / Phone</span>
              <span>Platforms</span>
              <span>Tags</span>
              <span>Created</span>
            </div>

            {contacts.map((contact, i) => (
              <motion.div
                key={contact.id}
                variants={fadeUp}
                onClick={() => openEdit(contact)}
                className={cn(
                  "grid md:grid-cols-[1.5fr_1.2fr_1fr_1fr_0.8fr] gap-3 md:gap-4 p-4 md:py-3 items-center hover:bg-accent/30 transition-colors cursor-pointer",
                  i !== contacts.length - 1 && "border-b border-border"
                )}
              >
                {/* Name */}
                <span className="text-sm font-medium truncate">
                  {contact.name || <span className="text-muted-foreground">Unknown</span>}
                </span>

                {/* Email / Phone */}
                <span className="text-xs text-muted-foreground truncate">
                  {contact.email || contact.phone || <span className="text-muted-foreground/50">--</span>}
                </span>

                {/* Platforms */}
                <div className="flex items-center gap-1 flex-wrap">
                  {(contact.channels || []).length === 0 ? (
                    <span className="text-xs text-muted-foreground/50">--</span>
                  ) : (
                    contact.channels.map((ch) => {
                      const platform = ch.platform?.toLowerCase() || "";
                      return (
                        <div
                          key={ch.id}
                          title={platformLabels[platform] || platform}
                          className={cn(
                            "flex size-5 items-center justify-center rounded-full text-[8px] font-bold text-white shrink-0",
                            platformColors[platform] || "bg-neutral-700"
                          )}
                        >
                          {platformAvatars[platform]?.slice(0, 1) || platform.slice(0, 1).toUpperCase()}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Tags */}
                <div className="flex items-center gap-1 flex-wrap">
                  {(contact.tags || []).length === 0 ? (
                    <span className="text-xs text-muted-foreground/50">--</span>
                  ) : (
                    contact.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-accent/40 text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))
                  )}
                  {(contact.tags || []).length > 3 && (
                    <span className="text-[10px] text-muted-foreground">+{contact.tags.length - 3}</span>
                  )}
                </div>

                {/* Created */}
                <span className="text-xs text-muted-foreground">
                  {new Date(contact.created_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </motion.div>
            ))}
          </motion.div>

          <LoadMore
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={loadMore}
            count={contacts.length}
          />
        </>
      )}

      <ContactCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={refetch}
      />

      <ContactEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        contact={editContact}
        onUpdated={refetch}
      />
    </div>
  );
}
