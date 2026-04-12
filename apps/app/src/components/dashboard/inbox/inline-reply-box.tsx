import { useState, useEffect, useRef } from "react";
import { Loader2, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InboxComment } from "./shared";
import { AuthorAvatar } from "./shared-components";
import { EmojiPicker } from "@/components/dashboard/new-post/emoji-hashtag-toolbar";

const REPLY_MAX_CHARS = 4000;

export function InlineReplyBox({
  comment,
  platform,
  accountId,
  postId,
  onReplyAdded,
  onClose,
  draft,
  onDraftChange,
}: {
  comment: InboxComment;
  platform: string;
  accountId: string;
  postId: string;
  onReplyAdded?: (comment: InboxComment) => void;
  onClose: () => void;
  draft: string;
  onDraftChange: (text: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    if (!draft.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/inbox/comments/${encodeURIComponent(postId)}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft.trim(), account_id: accountId, comment_id: comment.id }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error?.message || "Failed to reply");
        return;
      }
      if (json?.success === false) {
        setError("Failed to reply — platform rejected the request");
        return;
      }
      onReplyAdded?.({
        id: json.comment_id || `reply-${Date.now()}`,
        platform,
        author_name: "You",
        author_avatar: null,
        text: draft.trim(),
        created_at: new Date().toISOString(),
        likes: 0,
        hidden: false,
        parent_id: comment.id,
      });
      onClose();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 overflow-hidden" onClick={(e) => e.stopPropagation()}>
      <div className="px-3 pt-2.5 pb-1">
        <p className="text-xs text-muted-foreground">Replying to <span className="font-medium text-foreground">@{comment.author_name}</span></p>
      </div>
      <div className="flex items-start gap-2.5 px-3 py-2">
        <AuthorAvatar avatar={null} name="You" size="sm" />
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            if (e.target.value.length <= REPLY_MAX_CHARS) onDraftChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type in your reply..."
          rows={3}
          className="flex-1 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground resize-none"
        />
      </div>
      {error && (
        <div className="px-3 pb-1">
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border">
        <div className="flex items-center gap-1">
          <EmojiPicker onInsert={(emoji) => {
            if ((draft + emoji).length <= REPLY_MAX_CHARS) {
              onDraftChange(draft + emoji);
            }
            textareaRef.current?.focus();
          }} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{draft.length}/{REPLY_MAX_CHARS}</span>
          <button
            onClick={handleSubmit}
            disabled={!draft.trim() || loading}
            className={cn(
              "rounded-full p-1.5 transition-all",
              draft.trim()
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground"
            )}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
