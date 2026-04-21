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
        const placeholder = placeholders[i]!;
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

  return (
    <div className="border-t border-[#e7e9ef] bg-white">
      <div className="flex items-center gap-5 border-b border-[#eef0f5] px-4 pt-3">
        <button
          type="button"
          onClick={() => setMode("reply")}
          className={cn(
            "px-0.5 pb-2 text-sm font-semibold transition-colors",
            mode === "reply"
              ? "border-b-2 border-[#2d71f8] text-slate-900"
              : "border-b-2 border-transparent text-slate-400 hover:text-slate-600",
          )}
        >
          Reply
        </button>
        <button
          type="button"
          onClick={() => setMode("note")}
          className={cn(
            "inline-flex items-center gap-1.5 px-0.5 pb-2 text-sm font-medium transition-colors",
            mode === "note"
              ? "border-b-2 border-[#d4a72c] text-[#7a5c15]"
              : "border-b-2 border-transparent text-slate-400 hover:text-slate-600",
          )}
        >
          <StickyNote className="size-4" />
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
        <div className="flex flex-wrap gap-2 border-b border-[#eef0f5] bg-[#fafbfd] px-4 py-2">
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
        placeholder={mode === "note" ? "Add a private note for your team" : "Reply here"}
        rows={3}
        disabled={disabled}
        className={cn(
          "block min-h-[96px] w-full resize-none px-4 py-3 text-[14px] leading-6 outline-none placeholder:text-slate-400 disabled:opacity-50 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          mode === "note" ? "bg-[#fff8e0] text-[#5d4511]" : "bg-white text-slate-700",
        )}
      />

      <div className="flex items-center justify-between border-t border-[#eef0f5] px-3 py-2">
        <div className="flex items-center gap-0.5">
          <EmojiPicker onInsert={insertAtCursor} />
          {mode === "reply" && (
            <>
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                title="Image"
                className="flex size-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-[#f5f6f8] hover:text-slate-800"
              >
                <ImageIcon className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Attachment"
                className="flex size-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-[#f5f6f8] hover:text-slate-800"
              >
                <Paperclip className="size-4" />
              </button>
              <AudioRecorderPopover onRecorded={handleAudioRecorded} />
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          {mode === "reply" && singleAttachmentMode && (
            <span className="hidden text-[11px] text-slate-400 md:inline">
              WhatsApp supports one attachment per message
            </span>
          )}
          <span className="hidden text-[11px] text-slate-400 sm:inline">
            {shortcutLabel}+Enter to send
          </span>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={
              mode === "note"
                ? !text.trim() || sending || disabled
                : (!text.trim() && attachments.filter((a) => !a.uploading && !a.error).length === 0)
                  || attachments.some((a) => a.uploading || a.error)
                  || sending
                  || disabled
            }
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors",
              mode === "note"
                ? text.trim() && !disabled
                  ? "bg-[#d4a72c] text-white hover:bg-[#b88e1f]"
                  : "bg-[#f3e4a8] text-white"
                : (text.trim() || attachments.some((a) => !a.uploading && !a.error))
                  && !attachments.some((a) => a.uploading || a.error)
                  && !disabled
                  ? "bg-[#2d71f8] text-white hover:bg-[#195fe7]"
                  : "bg-[#d9e7ff] text-white",
            )}
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <SendHorizonal className="size-4" />
            )}
            {mode === "note" ? "Save note" : `Send to ${platformLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
}
