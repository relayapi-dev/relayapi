import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
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
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import { ContactSearchPicker } from "@/components/dashboard/campaigns/contact-search-picker";

interface SelectedContact {
  id: string;
  phone: string;
  name: string | null;
  tags?: string[];
}

interface BroadcastsCreateDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

export function BroadcastsCreateDialog({ open, onOpenChange, onCreated }: BroadcastsCreateDialogProps) {
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [message, setMessage] = useState("");
  const [selectedContacts, setSelectedContacts] = useState<SelectedContact[]>([]);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation<{ id: string }>("broadcasts", "POST");

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setName("");
      setAccountId("");
      setMessage("");
      setSelectedContacts([]);
      setScheduleEnabled(false);
      setScheduledAt("");
      setError(null);
    }
  }, [open]);

  const buildBody = () => {
    const identifiers = selectedContacts.map((c) => c.phone);

    return {
      ...(name.trim() ? { name: name.trim() } : {}),
      account_id: accountId,
      message_text: message.trim(),
      ...(identifiers.length > 0 ? { identifiers } : {}),
      ...(scheduleEnabled && scheduledAt ? { scheduled_at: new Date(scheduledAt).toISOString() } : {}),
    };
  };

  const handleCreateDraft = async () => {
    setError(null);
    if (!accountId || !message.trim()) {
      setError("Account and message are required.");
      return;
    }
    const result = await createMutation.mutate(buildBody());
    if (result) {
      onCreated();
      onOpenChange(false);
    }
  };

  const handleCreateAndSend = async () => {
    setError(null);
    if (!accountId || !message.trim()) {
      setError("Account and message are required.");
      return;
    }
    const result = await createMutation.mutate(buildBody());
    if (!result) return;
    // Send immediately after creation
    try {
      const res = await fetch(`/api/broadcasts/${result.id}/send`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Failed to send (${res.status})`);
        return;
      }
    } catch {
      setError("Failed to send broadcast.");
      return;
    }
    onCreated();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Create Broadcast</DialogTitle>
          <DialogDescription className="text-xs">
            Send a message to multiple recipients at once.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Name */}
          <div>
            <label htmlFor="broadcast-name" className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <input
              id="broadcast-name"
              type="text"
              placeholder="e.g. Welcome campaign"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Account */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Account
            </label>
            <div className="mt-1">
              <AccountSearchCombobox
                value={accountId || null}
                onSelect={(id) => { setAccountId(id || ""); setSelectedContacts([]); }}
                showAllOption={false}
                placeholder="Select an account"
                variant="input"
              />
            </div>
          </div>

          {/* Message */}
          <div>
            <label htmlFor="broadcast-message" className="text-xs font-medium text-muted-foreground">
              Message
            </label>
            <textarea
              id="broadcast-message"
              placeholder="Type your message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Recipients */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Recipients
            </label>
            <div className="mt-1">
              <ContactSearchPicker
                accountId={accountId}
                selected={selectedContacts}
                onSelectionChange={setSelectedContacts}
              />
            </div>
          </div>

          {/* Schedule */}
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox checked={scheduleEnabled} onCheckedChange={(c) => setScheduleEnabled(!!c)} />
            <span className="text-xs text-foreground">Schedule for later</span>
          </label>
          {scheduleEnabled && (
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
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
          <Button type="button" variant="outline" size="sm" onClick={handleCreateDraft} disabled={createMutation.loading || !accountId || !message.trim()}>
            {createMutation.loading ? <Loader2 className="size-3.5 animate-spin" /> : "Create Draft"}
          </Button>
          <Button type="button" size="sm" onClick={handleCreateAndSend} disabled={createMutation.loading || !accountId || !message.trim()}>
            {createMutation.loading ? <Loader2 className="size-3.5 animate-spin" /> : "Create & Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
