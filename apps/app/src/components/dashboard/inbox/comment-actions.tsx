import { useState } from "react";
import { Loader2, MoreHorizontal, Reply, Eye, EyeOff, Trash2, Send, MessageSquareText, Heart } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { InboxComment } from "./shared";
import { commentCapabilities } from "./shared";

export function LikeButton({ comment }: { comment: InboxComment }) {
  const [liked, setLiked] = useState(false);
  const platform = comment.platform?.toLowerCase() || "";
  const caps = commentCapabilities[platform] || { hide: false, like: false, privateReply: false };

  if (!caps.like) return null;

  const handleLike = async () => {
    const newLiked = !liked;
    setLiked(newLiked);
    try {
      const res = await fetch(`/api/inbox/comments/${encodeURIComponent(comment.id)}/like`, {
        method: newLiked ? "POST" : "DELETE",
      });
      if (res.ok) {
        const json = await res.json().catch(() => null);
        if (json && json.success === false) setLiked(!newLiked);
      } else {
        setLiked(!newLiked);
      }
    } catch {
      setLiked(!newLiked);
    }
  };

  return (
    <button
      onClick={handleLike}
      className={cn(
        "rounded p-1 transition-all hover:bg-accent/50",
        liked ? "text-red-500" : "text-muted-foreground/40 hover:text-muted-foreground"
      )}
      title={liked ? "Unlike" : "Like"}
    >
      <Heart className={cn("size-3.5", liked && "fill-red-500")} />
    </button>
  );
}

export function CommentActions({
  comment,
  platform,
  accountId,
  postId,
  onDelete,
  onHideToggle,
  onRequestReply,
}: {
  comment: InboxComment;
  platform: string;
  accountId: string;
  postId: string;
  onDelete: (commentId: string) => void;
  onHideToggle: (commentId: string, hidden: boolean) => void;
  onRequestReply?: () => void;
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showPrivateReply, setShowPrivateReply] = useState(false);
  const [privateReplyText, setPrivateReplyText] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);

  const caps = commentCapabilities[platform] || { hide: false, like: false, privateReply: false };

  const handleDelete = async () => {
    setActionLoading("delete");
    setDialogError(null);
    try {
      const res = await fetch(`/api/inbox/comments/${encodeURIComponent(comment.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setDialogError(err?.error?.message || "Failed to delete");
        return;
      }
      onDelete(comment.id);
      setShowDeleteConfirm(false);
    } catch {
      setDialogError("Network error");
    } finally {
      setActionLoading(null);
    }
  };

  const handleHideToggle = async () => {
    const isHidden = !!comment.hidden;
    onHideToggle(comment.id, !isHidden);
    try {
      const res = await fetch(`/api/inbox/comments/${encodeURIComponent(comment.id)}/hide`, {
        method: isHidden ? "DELETE" : "POST",
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || json?.success === false) {
        onHideToggle(comment.id, isHidden);
      }
    } catch {
      onHideToggle(comment.id, isHidden);
    }
  };

  const handlePrivateReply = async () => {
    if (!privateReplyText.trim()) return;
    setActionLoading("private-reply");
    setDialogError(null);
    try {
      const res = await fetch(`/api/inbox/comments/${encodeURIComponent(comment.id)}/private-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: privateReplyText.trim(), account_id: accountId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setDialogError(err?.error?.message || "Failed to send private reply");
        return;
      }
      setPrivateReplyText("");
      setShowPrivateReply(false);
    } catch {
      setDialogError("Network error");
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-accent/50 transition-all focus:opacity-100">
            <MoreHorizontal className="size-3.5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={() => onRequestReply?.()}>
            <Reply className="size-3.5 mr-2" />
            Reply
          </DropdownMenuItem>
          {caps.hide && (
            <DropdownMenuItem onClick={handleHideToggle}>
              {comment.hidden ? <Eye className="size-3.5 mr-2" /> : <EyeOff className="size-3.5 mr-2" />}
              {comment.hidden ? "Unhide" : "Hide"}
            </DropdownMenuItem>
          )}
          {caps.privateReply && (
            <DropdownMenuItem onClick={() => { setShowPrivateReply(true); setDialogError(null); }}>
              <MessageSquareText className="size-3.5 mr-2" />
              Private Reply
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => { setShowDeleteConfirm(true); setDialogError(null); }}
          >
            <Trash2 className="size-3.5 mr-2" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={showDeleteConfirm} onOpenChange={(open) => { setShowDeleteConfirm(open); if (!open) setDialogError(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete comment</DialogTitle>
            <DialogDescription>
              This will permanently delete this comment. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {dialogError && (
            <p className="text-xs text-destructive">{dialogError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={actionLoading === "delete"}>
              {actionLoading === "delete" ? <Loader2 className="size-3 animate-spin mr-1" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPrivateReply} onOpenChange={(open) => { setShowPrivateReply(open); if (!open) { setPrivateReplyText(""); setDialogError(null); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Private reply</DialogTitle>
            <DialogDescription>
              Send a private message to {comment.author_name}. They will receive it in their inbox.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={privateReplyText}
            onChange={(e) => setPrivateReplyText(e.target.value)}
            placeholder="Write a private message..."
            rows={3}
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground resize-none"
          />
          {dialogError && (
            <p className="text-xs text-destructive">{dialogError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button size="sm" onClick={handlePrivateReply} disabled={actionLoading === "private-reply" || !privateReplyText.trim()}>
              {actionLoading === "private-reply" ? <Loader2 className="size-3 animate-spin mr-1" /> : <Send className="size-3 mr-1" />}
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
