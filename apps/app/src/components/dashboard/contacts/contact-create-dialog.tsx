import { useState, useEffect } from "react";
import { Loader2, Link2 } from "lucide-react";
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
import { useMutation } from "@/hooks/use-api";
import { useFilter } from "@/components/dashboard/filter-context";
import { AccountSearchCombobox, type AccountOption } from "@/components/dashboard/account-search-combobox";

interface ContactCreateDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

function identifierPlaceholder(platform: string): string {
  const p = platform?.toLowerCase() || "";
  if (p === "whatsapp" || p === "telegram" || p === "sms") return "Phone number";
  if (p === "instagram" || p === "twitter" || p === "threads" || p === "tiktok" || p === "bluesky" || p === "mastodon") return "Username";
  return "User ID";
}

export function ContactCreateDialog({ open, onOpenChange, onCreated }: ContactCreateDialogProps) {
  const { workspaceId } = useFilter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [tags, setTags] = useState("");
  const [linkPlatform, setLinkPlatform] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [selectedAccount, setSelectedAccount] = useState<AccountOption | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation<{ id: string }>("contacts", "POST");

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setName("");
      setEmail("");
      setPhone("");
      setTags("");
      setLinkPlatform(false);
      setAccountId("");
      setSelectedAccount(null);
      setIdentifier("");
      setError(null);
    }
  }, [open]);

  const handleSubmit = async () => {
    setError(null);

    if (!workspaceId) {
      setError("Please select a workspace first.");
      return;
    }

    if (!name.trim() && !email.trim() && !phone.trim()) {
      setError("At least one of name, email, or phone is required.");
      return;
    }

    if (linkPlatform && (!accountId || !identifier.trim())) {
      setError("Account and identifier are required when linking to a platform.");
      return;
    }

    const parsedTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const body: Record<string, unknown> = { workspace_id: workspaceId };
    if (name.trim()) body.name = name.trim();
    if (email.trim()) body.email = email.trim();
    if (phone.trim()) body.phone = phone.trim();
    if (parsedTags.length > 0) body.tags = parsedTags;
    if (linkPlatform && accountId && identifier.trim()) {
      body.account_id = accountId;
      body.platform = selectedAccount?.platform || "";
      body.identifier = identifier.trim();
    }

    const result = await createMutation.mutate(body);
    if (result) {
      onCreated();
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Add Contact</DialogTitle>
          <DialogDescription className="text-xs">
            Create a new contact to manage across platforms.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Name */}
          <div>
            <label htmlFor="contact-name" className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <input
              id="contact-name"
              type="text"
              placeholder="e.g. John Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Email */}
          <div>
            <label htmlFor="contact-email" className="text-xs font-medium text-muted-foreground">
              Email
            </label>
            <input
              id="contact-email"
              type="email"
              placeholder="john@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Phone */}
          <div>
            <label htmlFor="contact-phone" className="text-xs font-medium text-muted-foreground">
              Phone
            </label>
            <input
              id="contact-phone"
              type="tel"
              placeholder="+1234567890"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Tags */}
          <div>
            <label htmlFor="contact-tags" className="text-xs font-medium text-muted-foreground">
              Tags
            </label>
            <input
              id="contact-tags"
              type="text"
              placeholder="vip, lead, newsletter (comma-separated)"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Link to platform toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox checked={linkPlatform} onCheckedChange={(c) => setLinkPlatform(!!c)} />
            <Link2 className="size-3.5 text-muted-foreground" />
            <span className="text-xs text-foreground">Link to a platform</span>
          </label>

          {linkPlatform && (
            <div className="space-y-3 rounded-md border border-border bg-accent/10 p-3">
              {/* Account */}
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Account
                </label>
                <div className="mt-1">
                  <AccountSearchCombobox
                    value={accountId || null}
                    onSelect={(id) => setAccountId(id || "")}
                    onSelectAccount={(acc) => setSelectedAccount(acc ?? null)}
                    workspaceId={workspaceId}
                    showAllOption={false}
                    placeholder="Select an account"
                    variant="input"
                  />
                </div>
              </div>

              {/* Identifier */}
              <div>
                <label htmlFor="contact-identifier" className="text-xs font-medium text-muted-foreground">
                  Identifier
                </label>
                <input
                  id="contact-identifier"
                  type="text"
                  placeholder={identifierPlaceholder(selectedAccount?.platform || "")}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
                />
              </div>
            </div>
          )}

          {/* Error */}
          {(error || createMutation.error) && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error || createMutation.error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={createMutation.loading}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleSubmit} disabled={createMutation.loading}>
            {createMutation.loading ? <Loader2 className="size-3.5 animate-spin" /> : "Create Contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
