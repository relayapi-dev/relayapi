import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { ImageIcon, Loader2, Mic, Paperclip, SendHorizonal, Smile, StickyNote } from "lucide-react";
import { cn } from "@/lib/utils";

export function MessageComposer({
  onSend,
  disabled,
  platformLabel,
}: {
  onSend: (text: string) => Promise<void>;
  disabled?: boolean;
  platformLabel: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const shortcutLabel =
    typeof navigator !== "undefined" && navigator.platform?.includes("Mac")
      ? "Cmd"
      : "Ctrl";

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  const handleSubmit = async () => {
    if (!text.trim() || sending || disabled) return;
    const message = text.trim();
    setText("");
    setSending(true);
    try {
      await onSend(message);
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div className="border-t border-[#e7e9ef] bg-white">
      <div className="flex items-center gap-5 border-b border-[#eef0f5] px-4 pt-3">
        <button
          type="button"
          className="border-b-2 border-[#2d71f8] px-0.5 pb-2 text-sm font-semibold text-slate-900"
        >
          Reply
        </button>
        <button
          type="button"
          disabled
          className="inline-flex items-center gap-1.5 border-b-2 border-transparent px-0.5 pb-2 text-sm font-medium text-slate-400"
        >
          <StickyNote className="size-4" />
          Note
        </button>
      </div>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Reply here"
        rows={3}
        disabled={disabled}
        className="min-h-[96px] w-full resize-none bg-white px-4 py-3 text-[14px] leading-6 text-slate-700 outline-none placeholder:text-slate-400 disabled:opacity-50 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      />

      <div className="flex items-center justify-between border-t border-[#eef0f5] px-3 py-2">
        <div className="flex items-center gap-0.5">
          {[
            { label: "Emoji", icon: Smile },
            { label: "Image", icon: ImageIcon },
            { label: "Attachment", icon: Paperclip },
            { label: "Voice", icon: Mic },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              disabled
              title={item.label}
              className="flex size-8 items-center justify-center rounded-md text-slate-400 transition-colors disabled:cursor-default disabled:opacity-100"
            >
              <item.icon className="size-4" />
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden text-[11px] text-slate-400 sm:inline">
            {shortcutLabel}+Enter to send
          </span>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!text.trim() || sending || disabled}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors",
              text.trim() && !disabled
                ? "bg-[#2d71f8] text-white hover:bg-[#195fe7]"
                : "bg-[#d9e7ff] text-white",
            )}
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <SendHorizonal className="size-4" />
            )}
            Send to {platformLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
