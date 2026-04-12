import { useState, useRef, useEffect } from "react";
import { Send, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function MessageComposer({
  conversationId,
  accountId,
  onSend,
  disabled,
}: {
  conversationId: string;
  accountId: string;
  onSend: (text: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [text]);

  const handleSubmit = async () => {
    if (!text.trim() || sending || disabled) return;
    const msg = text.trim();
    setText("");
    setSending(true);
    try {
      await onSend(msg);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="border-t border-border p-3 bg-background">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={2}
          disabled={disabled}
          className="flex-1 min-w-0 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground resize-none disabled:opacity-50 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        />
        <button
          onClick={handleSubmit}
          disabled={!text.trim() || sending || disabled}
          className={cn(
            "shrink-0 rounded-lg p-2 transition-all",
            text.trim() && !disabled
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted text-muted-foreground"
          )}
        >
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1.5 px-1">
        {navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Enter to send
      </p>
    </div>
  );
}
