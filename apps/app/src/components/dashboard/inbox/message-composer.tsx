import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { ImageIcon, Loader2, Paperclip, SendHorizonal, StickyNote } from "lucide-react";
import { EmojiPicker } from "@/components/dashboard/new-post/emoji-hashtag-toolbar";
import { uploadMedia } from "@/lib/upload-media";
import { cn } from "@/lib/utils";
import { ComposerAttachmentChip } from "./composer-attachment-chip";
import { AudioRecorderPopover } from "./audio-recorder-popover";

interface PendingAttachment {
  id: string;
  url: string;
  type: string;
  filename: string;
  uploading: boolean;
  error?: string;
}

type ComposerMode = "reply" | "note";

export function MessageComposer({
  onSend,
  onCreateNote,
  disabled,
  platform,
  platformLabel,
}: {
  onSend: (payload: {
    text: string;
    attachments: Array<{ url: string; type: string }>;
  }) => Promise<void>;
  onCreateNote: (text: string) => Promise<void>;
  disabled?: boolean;
  platform: string;
  platformLabel: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [mode, setMode] = useState<ComposerMode>("reply");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const blobUrlsRef = useRef<Set<string>>(new Set());
  const singleAttachmentMode = platform === "whatsapp";
  const isNote = mode === "note";
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

  useEffect(() => {
    const set = blobUrlsRef.current;
    return () => {
      for (const url of set) URL.revokeObjectURL(url);
      set.clear();
    };
  }, []);

  const insertAtCursor = (snippet: string) => {
    if (disabled) return;
    const el = textareaRef.current;
    if (!el) {
      setText((prev) => prev + snippet);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + snippet + el.value.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + snippet.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const revokeBlobUrl = (url: string) => {
    if (!url.startsWith("blob:")) return;
    URL.revokeObjectURL(url);
    blobUrlsRef.current.delete(url);
  };

  const clearAttachmentPreviews = (items: PendingAttachment[]) => {
    for (const item of items) {
      revokeBlobUrl(item.url);
    }
  };

  const handleFilesPicked = async (files: FileList | null) => {
    if (!files || files.length === 0 || disabled) return;
    const list = singleAttachmentMode
      ? Array.from(files).slice(0, 1)
      : Array.from(files);
    if (list.length === 0) return;
    const placeholders: PendingAttachment[] = list.map((file) => ({
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url: URL.createObjectURL(file),
      type: file.type,
      filename: file.name,
      uploading: true,
    }));
    for (const placeholder of placeholders) {
      blobUrlsRef.current.add(placeholder.url);
    }
    setAttachments((prev) => {
      if (!singleAttachmentMode) {
        return [...prev, ...placeholders];
      }
      clearAttachmentPreviews(prev);
      return placeholders;
    });

    await Promise.all(
      list.map(async (file, i) => {
        const placeholder = placeholders[i];
        if (!placeholder) return;
        try {
          const uploaded = await uploadMedia(file);
          URL.revokeObjectURL(placeholder.url);
          blobUrlsRef.current.delete(placeholder.url);
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === placeholder.id
                ? { ...a, url: uploaded.url, uploading: false }
                : a,
            ),
          );
        } catch (err) {
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === placeholder.id
                ? { ...a, uploading: false, error: err instanceof Error ? err.message : String(err) }
                : a,
            ),
          );
        }
      }),
    );
  };

  const handleAudioRecorded = (file: File) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    void handleFilesPicked(dt.files);
  };

  const removeAttachment = (id: string) => {
    const target = attachments.find((x) => x.id === id);
    if (target) {
      revokeBlobUrl(target.url);
    }
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleSubmit = async () => {
    if (mode === "note") {
      const body = text.trim();
      if (!body || sending || disabled) return;
      setText("");
      setSending(true);
      try {
        await onCreateNote(body);
      } finally {
        setSending(false);
        textareaRef.current?.focus();
      }
      return;
    }
    const hasBlockedAttachments = attachments.some((a) => a.uploading || a.error);
    const uploaded = attachments.filter((a) => !a.uploading && !a.error);
    if ((!text.trim() && uploaded.length === 0) || hasBlockedAttachments || sending || disabled) return;
    const message = text.trim();
    const toSend = uploaded.map(({ url, type }) => ({ url, type }));
    setText("");
    setSending(true);
    try {
      await onSend({ text: message, attachments: toSend });
      clearAttachmentPreviews(attachments);
      setAttachments([]);
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

  const canSubmit =
    mode === "note"
      ? Boolean(text.trim()) && !sending && !disabled
      : (Boolean(text.trim()) || attachments.some((a) => !a.uploading && !a.error))
        && !attachments.some((a) => a.uploading || a.error)
        && !sending
        && !disabled;

  return (
    <div className="px-3 pb-3 sm:px-4 sm:pb-4">
      <div
        className={cn(
          "overflow-hidden rounded-2xl border shadow-xs transition-colors focus-within:border-ring/60",
          isNote ? "border-amber-300 bg-amber-50/70" : "border-border bg-card",
          disabled && "opacity-60",
        )}
      >
        {/* Mode toggle */}
        <div className="flex items-center gap-1 px-2 pt-2">
          <button
            type="button"
            onClick={() => setMode("reply")}
            className={cn(
              "rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
              !isNote ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
            )}
          >
            Reply
          </button>
          <button
            type="button"
            onClick={() => setMode("note")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
              isNote ? "bg-amber-500 text-white" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <StickyNote className="size-3.5" />
            Note
          </button>
        </div>

        <input
          ref={imageInputRef}
          type="file"
          accept="image/*,video/*"
          multiple={!singleAttachmentMode}
          hidden
          onChange={(e) => {
            void handleFilesPicked(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple={!singleAttachmentMode}
          hidden
          onChange={(e) => {
            void handleFilesPicked(e.target.files);
            e.target.value = "";
          }}
        />

        {mode === "reply" && attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {attachments.map((a) => (
              <ComposerAttachmentChip
                key={a.id}
                url={a.url}
                type={a.type}
                filename={a.filename}
                progress={a.uploading ? 50 : undefined}
                error={a.error}
                onRemove={() => removeAttachment(a.id)}
              />
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isNote ? "Add a private note for your team" : "Write a reply"}
          rows={2}
          disabled={disabled}
          className={cn(
            "block min-h-[52px] w-full resize-none bg-transparent px-3.5 py-2.5 text-[14px] leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            isNote ? "text-amber-900 placeholder:text-amber-700/60" : "text-foreground",
          )}
        />

        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-0.5">
            <EmojiPicker onInsert={insertAtCursor} />
            {mode === "reply" && (
              <>
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  title="Add image or video"
                  className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ImageIcon className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach a file"
                  className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Paperclip className="size-4" />
                </button>
                <AudioRecorderPopover onRecorded={handleAudioRecorded} />
              </>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              {shortcutLabel}+Enter
            </span>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              title={isNote ? "Save note" : `Send to ${platformLabel}`}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-full px-4 text-[13px] font-semibold transition-colors",
                isNote
                  ? canSubmit
                    ? "bg-amber-500 text-white hover:bg-amber-600"
                    : "bg-amber-500/40 text-white"
                  : canSubmit
                    ? "bg-foreground text-background hover:bg-foreground/90"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {sending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <SendHorizonal className="size-4" />
              )}
              {isNote ? "Save note" : "Send"}
            </button>
          </div>
        </div>
      </div>

      {mode === "reply" && singleAttachmentMode && (
        <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
          WhatsApp supports one attachment per message.
        </p>
      )}
    </div>
  );
}
