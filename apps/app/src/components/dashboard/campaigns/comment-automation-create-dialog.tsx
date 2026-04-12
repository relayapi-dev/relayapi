import { useState, useEffect } from "react";
import { Loader2, ChevronDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMutation } from "@/hooks/use-api";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import type { AccountOption } from "@/components/dashboard/account-search-combobox";
import { WorkspaceSearchCombobox } from "@/components/dashboard/workspace-search-combobox";
import { PostSearchCombobox } from "@/components/dashboard/post-search-combobox";

interface CommentAutomationCreateDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

export function CommentAutomationCreateDialog({ open, onOpenChange, onCreated }: CommentAutomationCreateDialogProps) {
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<AccountOption | null>(null);
  const [postId, setPostId] = useState<string | null>(null);
  const [keywords, setKeywords] = useState("");
  const [matchMode, setMatchMode] = useState<"contains" | "exact">("contains");
  const [dmMessage, setDmMessage] = useState("");
  const [showPublicReply, setShowPublicReply] = useState(false);
  const [publicReply, setPublicReply] = useState("");
  const [oncePerUser, setOncePerUser] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation<{ id: string }>("comment-automations", "POST");

  // Reset form when dialog closes
  useEffect(() => {
    if (!open) {
      setName("");
      setWorkspaceId(null);
      setAccountId(null);
      setSelectedAccount(null);
      setPostId(null);
      setKeywords("");
      setMatchMode("contains");
      setDmMessage("");
      setShowPublicReply(false);
      setPublicReply("");
      setOncePerUser(true);
      setError(null);
    }
  }, [open]);

  const handleWorkspaceChange = (id: string | null) => {
    setWorkspaceId(id);
    setAccountId(null);
    setSelectedAccount(null);
  };

  const handleCreate = async () => {
    setError(null);

    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!accountId) {
      setError("Please select an account.");
      return;
    }

    const platform = selectedAccount?.platform;
    if (!platform || (platform !== "instagram" && platform !== "facebook")) {
      setError("Selected account must be Instagram or Facebook.");
      return;
    }

    if (!dmMessage.trim()) {
      setError("DM message is required.");
      return;
    }

    const keywordList = keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    const result = await createMutation.mutate({
      name: name.trim(),
      account_id: accountId,
      platform,
      ...(postId ? { post_id: postId } : {}),
      keywords: keywordList,
      match_mode: matchMode,
      dm_message: dmMessage.trim(),
      ...(showPublicReply && publicReply.trim() ? { public_reply: publicReply.trim() } : {}),
      once_per_user: oncePerUser,
    });

    if (result) {
      onCreated();
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[85vh] grid-rows-[auto_1fr_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-base">Create Comment Automation</DialogTitle>
          <DialogDescription className="text-xs">
            Automatically send a DM when someone comments with specific keywords.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 -mr-6">
        <div className="space-y-3 py-2 pl-0.5 pr-6">
          {/* Name */}
          <div>
            <label htmlFor="ca-name" className="text-xs font-medium text-muted-foreground">
              Name <span className="text-destructive">*</span>
            </label>
            <input
              id="ca-name"
              type="text"
              placeholder="e.g. Free guide giveaway"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Workspace (optional filter) */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Workspace
            </label>
            <WorkspaceSearchCombobox
              value={workspaceId}
              onSelect={handleWorkspaceChange}
              showAllOption
              placeholder="All workspaces"
              variant="input"
              className="mt-1"
            />
          </div>

          {/* Account */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Account <span className="text-destructive">*</span>
            </label>
            <AccountSearchCombobox
              value={accountId}
              onSelect={setAccountId}
              onSelectAccount={setSelectedAccount}
              workspaceId={workspaceId}
              platforms={["instagram", "facebook"]}
              showAllOption={false}
              placeholder="Search accounts..."
              variant="input"
              className="mt-1"
            />
          </div>

          {/* Post */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Post
            </label>
            <PostSearchCombobox
              value={postId}
              onSelect={setPostId}
              accountId={accountId}
              showAllOption
              placeholder="All posts"
              variant="input"
              className="mt-1"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Leave as "All posts" to monitor every post on this account.
            </p>
          </div>

          {/* Keywords */}
          <div>
            <label htmlFor="ca-keywords" className="text-xs font-medium text-muted-foreground">
              Keywords
            </label>
            <input
              id="ca-keywords"
              type="text"
              placeholder="e.g. free, guide, link (comma-separated)"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Match Mode */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Match Mode</label>
            <div className="mt-1 flex rounded-md border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setMatchMode("contains")}
                className={cn(
                  "flex-1 px-3 py-1.5 text-xs font-medium transition-colors",
                  matchMode === "contains"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Contains
              </button>
              <button
                type="button"
                onClick={() => setMatchMode("exact")}
                className={cn(
                  "flex-1 px-3 py-1.5 text-xs font-medium transition-colors border-l border-border",
                  matchMode === "exact"
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Exact
              </button>
            </div>
          </div>

          {/* DM Message */}
          <div>
            <label htmlFor="ca-dm-message" className="text-xs font-medium text-muted-foreground">
              DM Message <span className="text-destructive">*</span>
            </label>
            <textarea
              id="ca-dm-message"
              placeholder="The message to send as a DM..."
              value={dmMessage}
              onChange={(e) => setDmMessage(e.target.value)}
              rows={3}
              className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            />
          </div>

          {/* Public Reply (collapsible) */}
          <div>
            <button
              type="button"
              onClick={() => setShowPublicReply(!showPublicReply)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  showPublicReply && "rotate-180"
                )}
              />
              Add public reply
            </button>
            {showPublicReply && (
              <textarea
                placeholder="Optional public reply to the comment..."
                value={publicReply}
                onChange={(e) => setPublicReply(e.target.value)}
                rows={2}
                className="mt-2 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
              />
            )}
          </div>

          {/* Once per user toggle */}
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <div>
              <label htmlFor="ca-once-per-user" className="text-xs font-medium text-muted-foreground">
                Once per user
              </label>
              <p className="text-[10px] text-muted-foreground/70">Each user triggers the automation only once</p>
            </div>
            <button
              id="ca-once-per-user"
              type="button"
              role="switch"
              aria-checked={oncePerUser}
              onClick={() => setOncePerUser(!oncePerUser)}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                oncePerUser ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600"
              )}
            >
              <span
                className={cn(
                  "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                  oncePerUser ? "translate-x-4" : "translate-x-0"
                )}
              />
            </button>
          </div>

          {/* Error */}
          {(error || createMutation.error) && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error || createMutation.error}
            </div>
          )}
        </div>
        </ScrollArea>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={createMutation.loading}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleCreate} disabled={createMutation.loading || !name.trim() || !accountId || !dmMessage.trim()}>
            {createMutation.loading ? <Loader2 className="size-3.5 animate-spin" /> : "Create Automation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
