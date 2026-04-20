# Inbox Messaging Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four features to the inbox composer: internal notes on conversations, emoji picker, image/file attachment picker, and audio recording — wiring into the existing send pipeline and introducing a new notes subsystem.

**Architecture:**
- **Notes** are a new `inbox_conversation_notes` table with CRUD endpoints under `/v1/inbox/...`, rendered inline in the chat thread (interleaved with platform messages by timestamp) and authored via a "Note" tab in the existing composer.
- **Emoji picker** reuses the existing `EmojiPicker` component from `new-post/emoji-hashtag-toolbar.tsx` — wiring it into the composer's textarea and inserting at cursor position.
- **Image/file picker** adds a local attachments-pending state to the composer, uploads each file through the existing `/api/media/presign` + R2 PUT flow, and forwards the resulting URLs to the existing `sendMessage` endpoint which already accepts `attachments: { url, type }[]`.
- **Audio recorder** uses the browser `MediaRecorder` API to capture audio/webm; blob is uploaded via the same presign helper and attached as an audio attachment on send.

**Tech Stack:** Hono + Zod-OpenAPI (API), Drizzle (DB), Postgres (Hyperdrive), Cloudflare R2 (media), Astro + React (app), Radix UI, TypeScript SDK (hand-synced with API per project rules), Bun test runner.

---

## Scope Check

This plan covers four features bundled because they all target the same composer component and share infrastructure (presign upload flow, composer state). The notes subsystem is the largest independent block; emoji, image, file, audio work share the same composer state shape and are cheaper to do together than separately.

Feature groupings:
1. **Shared foundation** — presign upload helper extraction.
2. **Emoji picker** — standalone composer wiring.
3. **Attachment pipeline** — image picker, generic file picker, audio recorder all feed a common "pending attachments" composer state.
4. **Note system** — DB table → API → SDK → app proxy → UI.

These are ordered smallest-to-largest so earlier tasks validate the approach before committing to the note-system DB migration.

---

## File Structure

### Files created

| Path | Purpose |
|---|---|
| `apps/app/src/lib/upload-media.ts` | Shared presign-upload helper (used by composer and new-post dialog) |
| `apps/app/src/components/dashboard/inbox/composer-attachment-chip.tsx` | Chip UI for a pending attachment (thumb, filename, remove) |
| `apps/app/src/components/dashboard/inbox/audio-recorder-popover.tsx` | Mic button + Radix popover with MediaRecorder controls |
| `apps/app/src/pages/api/inbox/conversations/[id]/notes/index.ts` | Astro proxy: list + create notes |
| `apps/app/src/pages/api/inbox/notes/[noteId].ts` | Astro proxy: patch + delete note |
| `apps/app/src/components/dashboard/inbox/conversation-notes.tsx` | Note list item renderer |
| `apps/api/src/schemas/inbox-notes.ts` | Zod/OpenAPI schemas for notes |
| `apps/api/src/__tests__/inbox-notes.test.ts` | Integration tests for the notes API |

### Files modified

| Path | Change |
|---|---|
| `apps/app/src/components/dashboard/inbox/message-composer.tsx` | Emoji picker, attachment state, file input, audio recorder, Note/Reply tab wiring |
| `apps/app/src/components/dashboard/inbox/chat-thread.tsx` | Forward attachments on send, merge notes with messages, load notes |
| `apps/app/src/components/dashboard/inbox/shared.ts` | Add `NoteItem` type and helpers |
| `apps/app/src/components/dashboard/new-post-dialog.tsx` | Replace inlined presign-upload code with new `upload-media.ts` helper (DRY) |
| `packages/db/src/schema.ts` | Add `inboxConversationNotes` table |
| `apps/api/src/routes/inbox-feed.ts` | Add list/create/patch/delete note routes |
| `packages/sdk/src/resources/inbox/conversations.ts` | Add `listNotes`, `createNote`, `updateNote`, `deleteNote` methods + types |

### File responsibility boundaries

- **`upload-media.ts`** owns *only* the "choose a file, upload it to R2, return `{ url, type }`" contract. No UI, no composer state.
- **`composer-attachment-chip.tsx`** owns *only* the visual chip for one pending attachment — has no upload logic.
- **`audio-recorder-popover.tsx`** owns *only* recording (start/stop/preview) and returns a `File` to its parent — does not upload itself.
- **`message-composer.tsx`** remains the single source of truth for composer state: text, mode (reply/note), pending attachments, and submission.
- **`chat-thread.tsx`** fetches both messages and notes, merges by timestamp, and passes both to the renderer. Note authoring submits to the notes endpoint; message authoring submits to the send endpoint.

---

## Task 1: Shared presign-upload helper

**Why first:** Three of the four features (image picker, file picker, audio recorder) need the same upload flow. Extract it once so the other tasks reuse it.

**Files:**
- Create: `apps/app/src/lib/upload-media.ts`
- Modify: `apps/app/src/components/dashboard/new-post-dialog.tsx:504-560` (swap inline presign to helper call)

- [ ] **Step 1: Write the helper**

Create `apps/app/src/lib/upload-media.ts`:

```ts
export interface UploadedMedia {
  url: string;
  type: string;
  filename: string;
  size: number;
}

export async function uploadMedia(file: File): Promise<UploadedMedia> {
  const presignRes = await fetch("/api/media/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, content_type: file.type }),
  });

  if (presignRes.ok) {
    const { upload_url, url } = (await presignRes.json()) as {
      upload_url: string;
      url: string;
    };
    const put = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (put.ok) {
      return { url, type: file.type, filename: file.name, size: file.size };
    }
  }

  // Fallback: direct upload through app proxy
  const res = await fetch(
    `/api/media/upload?filename=${encodeURIComponent(file.name)}`,
    { method: "POST", headers: { "Content-Type": file.type }, body: file },
  );
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const { url } = (await res.json()) as { url: string };
  return { url, type: file.type, filename: file.name, size: file.size };
}
```

- [ ] **Step 2: Swap the inline upload in `new-post-dialog.tsx`**

In `apps/app/src/components/dashboard/new-post-dialog.tsx`, locate the `handleFileUpload` function starting around line 504. Replace the body of the `try { ... }` block (the whole presign-then-PUT-then-direct-fallback block, lines 517-560ish) with:

```ts
import { uploadMedia } from "@/lib/upload-media";
// ... existing imports remain
// inside handleFileUpload:
try {
  const uploaded = await uploadMedia(file);
  const fileUrl = uploaded.url;
  // ... rest of existing logic that uses fileUrl stays unchanged
}
```

Only the upload block is replaced. The rest of `handleFileUpload` (type-inference, validation, state updates) stays as-is.

- [ ] **Step 3: Typecheck**

Run: `cd /Users/zank/Developer/majestico/relayapi && bun run typecheck:app`
Expected: exit 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/app/src/lib/upload-media.ts apps/app/src/components/dashboard/new-post-dialog.tsx
git commit -m "refactor(app): extract shared presign-upload helper"
```

---

## Task 2: Emoji picker in composer

**Files:**
- Modify: `apps/app/src/components/dashboard/inbox/message-composer.tsx`

- [ ] **Step 1: Import the existing EmojiPicker**

At the top of `message-composer.tsx`, add:

```ts
import { EmojiPicker } from "@/components/dashboard/new-post/emoji-hashtag-toolbar";
```

- [ ] **Step 2: Add cursor-aware insert function**

Inside the component, above `handleSubmit`:

```ts
const insertAtCursor = (snippet: string) => {
  const el = textareaRef.current;
  if (!el) {
    setText((prev) => prev + snippet);
    return;
  }
  const start = el.selectionStart ?? text.length;
  const end = el.selectionEnd ?? text.length;
  const next = text.slice(0, start) + snippet + text.slice(end);
  setText(next);
  // Restore caret after React re-render
  requestAnimationFrame(() => {
    el.focus();
    const caret = start + snippet.length;
    el.setSelectionRange(caret, caret);
  });
};
```

- [ ] **Step 3: Replace the disabled Smile placeholder with the EmojiPicker trigger**

Locate the toolbar `.map` block (currently rendering `{ label: "Emoji", icon: Smile }` etc. as disabled buttons). Replace the mapping entirely with an explicit set of buttons — the first of which is the emoji picker. Delete `Smile` from the lucide-react imports (it's now inside the shared picker).

```tsx
<div className="flex items-center gap-0.5">
  <EmojiPicker onInsert={insertAtCursor} />
  {/* Remaining disabled placeholders stay for Image/Attachment/Voice until Tasks 3–5 */}
  {[
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
```

Note: the shared `EmojiPicker` renders its own trigger button with `size-7`. Keep it — a 1px size delta vs. the other icons is acceptable; we will re-style it in Task 3 when we replace neighbors.

- [ ] **Step 4: Manually verify**

Run the dev server if not already running: `bun run dev:app`. Open an inbox conversation, click the smiley, pick an emoji — verify it inserts at the textarea caret position (not at the end when caret is mid-text).

- [ ] **Step 5: Typecheck + commit**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run typecheck:app
git add apps/app/src/components/dashboard/inbox/message-composer.tsx
git commit -m "feat(inbox): wire emoji picker into composer"
```

---

## Task 3: Composer attachment state + image/file picker

**Files:**
- Create: `apps/app/src/components/dashboard/inbox/composer-attachment-chip.tsx`
- Modify: `apps/app/src/components/dashboard/inbox/message-composer.tsx`
- Modify: `apps/app/src/components/dashboard/inbox/chat-thread.tsx`

- [ ] **Step 1: Write the attachment chip**

Create `apps/app/src/components/dashboard/inbox/composer-attachment-chip.tsx`:

```tsx
import { FileIcon, X } from "lucide-react";

interface Props {
  url: string;
  type: string;
  filename: string;
  progress?: number;
  onRemove: () => void;
}

export function ComposerAttachmentChip({ url, type, filename, progress, onRemove }: Props) {
  const isImage = type.startsWith("image/");
  const isVideo = type.startsWith("video/");
  const isAudio = type.startsWith("audio/");
  const uploading = typeof progress === "number" && progress < 100;

  return (
    <div className="group relative inline-flex h-14 items-center gap-2 rounded-md border border-[#e5e7eb] bg-[#f8fafc] px-2">
      {isImage ? (
        <img src={url} alt={filename} className="h-10 w-10 rounded object-cover" />
      ) : isVideo ? (
        <video src={url} className="h-10 w-10 rounded object-cover" muted />
      ) : isAudio ? (
        <audio src={url} controls className="h-10 w-44" />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded bg-white">
          <FileIcon className="size-4 text-slate-500" />
        </div>
      )}
      <span className="max-w-[10rem] truncate text-xs text-slate-600">{filename}</span>
      {uploading && (
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-white/70 text-[11px] font-medium text-slate-600">
          {progress}%
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="ml-1 rounded-full p-0.5 text-slate-400 hover:bg-white hover:text-slate-700"
        title="Remove"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Extend composer state for pending attachments**

At the top of `message-composer.tsx`, inside the component:

```ts
import { useRef as _ensure } from "react"; // (no-op, keep existing useRef import)
import { uploadMedia } from "@/lib/upload-media";
import { ComposerAttachmentChip } from "./composer-attachment-chip";

interface PendingAttachment {
  id: string;
  url: string;
  type: string;
  filename: string;
  uploading: boolean;
  error?: string;
}
```

Add state:

```ts
const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
const imageInputRef = useRef<HTMLInputElement>(null);
const fileInputRef = useRef<HTMLInputElement>(null);
```

- [ ] **Step 3: Update the `onSend` contract**

Change the `onSend` prop type and `handleSubmit` to pass attachments:

```ts
export function MessageComposer({
  onSend,
  disabled,
  platformLabel,
}: {
  onSend: (payload: {
    text: string;
    attachments: Array<{ url: string; type: string }>;
  }) => Promise<void>;
  disabled?: boolean;
  platformLabel: string;
}) {
```

Replace `handleSubmit`:

```ts
const handleSubmit = async () => {
  const uploaded = attachments.filter((a) => !a.uploading && !a.error);
  if ((!text.trim() && uploaded.length === 0) || sending || disabled) return;
  const message = text.trim();
  const toSend = uploaded.map(({ url, type }) => ({ url, type }));
  setText("");
  setAttachments([]);
  setSending(true);
  try {
    await onSend({ text: message, attachments: toSend });
  } finally {
    setSending(false);
    textareaRef.current?.focus();
  }
};
```

Update the Send button `disabled` expression:

```ts
disabled={(!text.trim() && attachments.filter((a) => !a.uploading && !a.error).length === 0) || sending || disabled}
```

And the blue/greyed style:

```ts
(text.trim() || attachments.some((a) => !a.uploading && !a.error)) && !disabled
  ? "bg-[#2d71f8] text-white hover:bg-[#195fe7]"
  : "bg-[#d9e7ff] text-white"
```

- [ ] **Step 4: Add file pick + upload handler**

```ts
const handleFilesPicked = async (files: FileList | null) => {
  if (!files || files.length === 0) return;
  const list = Array.from(files);
  const placeholders: PendingAttachment[] = list.map((file) => ({
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: URL.createObjectURL(file),
    type: file.type,
    filename: file.name,
    uploading: true,
  }));
  setAttachments((prev) => [...prev, ...placeholders]);

  await Promise.all(
    list.map(async (file, i) => {
      const placeholder = placeholders[i]!;
      try {
        const uploaded = await uploadMedia(file);
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
              ? { ...a, uploading: false, error: String(err) }
              : a,
          ),
        );
      }
    }),
  );
};

const removeAttachment = (id: string) => {
  setAttachments((prev) => prev.filter((a) => a.id !== id));
};
```

- [ ] **Step 5: Render hidden file inputs + chips + wire toolbar buttons**

Above the `<textarea>`, inside the outer div returned by the component, insert (just above the textarea):

```tsx
<input
  ref={imageInputRef}
  type="file"
  accept="image/*,video/*"
  multiple
  hidden
  onChange={(e) => {
    void handleFilesPicked(e.target.files);
    e.target.value = "";
  }}
/>
<input
  ref={fileInputRef}
  type="file"
  multiple
  hidden
  onChange={(e) => {
    void handleFilesPicked(e.target.files);
    e.target.value = "";
  }}
/>

{attachments.length > 0 && (
  <div className="flex flex-wrap gap-2 border-b border-[#eef0f5] bg-[#fafbfd] px-4 py-2">
    {attachments.map((a) => (
      <ComposerAttachmentChip
        key={a.id}
        url={a.url}
        type={a.type}
        filename={a.filename}
        progress={a.uploading ? 50 : undefined}
        onRemove={() => removeAttachment(a.id)}
      />
    ))}
  </div>
)}
```

Replace the Image and Attachment placeholder buttons with live triggers:

```tsx
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
```

Leave the Voice button disabled for now — Task 5 replaces it.

- [ ] **Step 6: Update `chat-thread.tsx` to accept the new onSend shape**

In `apps/app/src/components/dashboard/inbox/chat-thread.tsx`, locate `handleSend = async (text: string) => { ... }` (~line 216). Replace its signature and body:

```ts
const handleSend = async ({
  text,
  attachments,
}: {
  text: string;
  attachments: Array<{ url: string; type: string }>;
}) => {
  if (!conversation) return;
  setSendError(null);

  const tempId = `temp-${Date.now()}`;
  const optimisticMsg: MessageItem = {
    id: tempId,
    sender: "user",
    author_name: "You",
    text,
    created_at: new Date().toISOString(),
    attachments,
  };
  setMessages((prev) => [...prev, optimisticMsg]);

  try {
    const res = await fetch(
      `/api/inbox/conversations/${encodeURIComponent(conversation.id)}/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text || undefined,
          account_id: conversation.account_id,
          attachments: attachments.length > 0 ? attachments : undefined,
        }),
      },
    );
    const json = await res.json().catch(() => null);

    if (!res.ok) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setSendError(json?.error?.message || json?.error || "Failed to send message");
      return;
    }

    setMessages((prev) =>
      prev.map((m) =>
        m.id === tempId ? { ...m, id: json.message_id || tempId } : m,
      ),
    );
    onMessageSent?.();
  } catch {
    setMessages((prev) => prev.filter((m) => m.id !== tempId));
    setSendError("Network error while sending the message");
  }
};
```

Confirm `MessageItem` in `./shared` already has an `attachments?` field; if not, add `attachments?: Array<{ url: string; type: string }>` to the type.

- [ ] **Step 7: Typecheck**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run typecheck:app
```

- [ ] **Step 8: Manually verify**

Open a conversation, click image button → pick a PNG → chip appears, uploads (spinner), then send. Verify message appears in thread. Same for the paperclip button with a PDF. Test removing an attachment before send.

- [ ] **Step 9: Commit**

```bash
git add apps/app/src/components/dashboard/inbox/composer-attachment-chip.tsx \
        apps/app/src/components/dashboard/inbox/message-composer.tsx \
        apps/app/src/components/dashboard/inbox/chat-thread.tsx \
        apps/app/src/components/dashboard/inbox/shared.ts
git commit -m "feat(inbox): image & file attachments in composer"
```

---

## Task 4: Audio recorder

**Files:**
- Create: `apps/app/src/components/dashboard/inbox/audio-recorder-popover.tsx`
- Modify: `apps/app/src/components/dashboard/inbox/message-composer.tsx`

- [ ] **Step 1: Write the recorder popover**

Create `apps/app/src/components/dashboard/inbox/audio-recorder-popover.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Mic, Square, Trash2, Check } from "lucide-react";

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioRecorderPopover({
  onRecorded,
}: {
  onRecorded: (file: File) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reset = () => {
    setBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setElapsed(0);
    setError(null);
    chunksRef.current = [];
  };

  useEffect(() => {
    if (!open) {
      stopRecording();
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const startRecording = async () => {
    try {
      reset();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setBlobUrl(URL.createObjectURL(blob));
      };
      recorder.start();
      startTimeRef.current = Date.now();
      setRecording(true);
      timerRef.current = setInterval(() => {
        setElapsed(Date.now() - startTimeRef.current);
      }, 200);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone unavailable");
    }
  };

  const stopRecording = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setRecording(false);
  };

  const confirm = () => {
    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    const file = new File([blob], `voice-${Date.now()}.webm`, {
      type: "audio/webm",
    });
    onRecorded(file);
    setOpen(false);
    reset();
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Voice"
          className="flex size-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-[#f5f6f8] hover:text-slate-800"
        >
          <Mic className="size-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 w-64 rounded-lg border border-border bg-popover p-3 shadow-lg"
        >
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : blobUrl ? (
            <div className="flex flex-col gap-2">
              <audio src={blobUrl} controls className="w-full" />
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={reset}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-500 hover:bg-accent"
                >
                  <Trash2 className="size-3.5" /> Discard
                </button>
                <button
                  type="button"
                  onClick={confirm}
                  className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Check className="size-3.5" /> Attach
                </button>
              </div>
            </div>
          ) : recording ? (
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <span className="size-2 animate-pulse rounded-full bg-red-500" />
                {formatTime(elapsed)}
              </div>
              <button
                type="button"
                onClick={stopRecording}
                className="inline-flex items-center gap-1 rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-900"
              >
                <Square className="size-3.5" /> Stop
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs text-slate-500">Record a voice message</p>
              <button
                type="button"
                onClick={() => void startRecording()}
                className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Mic className="size-3.5" /> Start
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
```

- [ ] **Step 2: Wire recorder into composer**

In `message-composer.tsx`, add import:

```ts
import { AudioRecorderPopover } from "./audio-recorder-popover";
```

Add a handler that routes a recorded file through the same upload path used by images/files. Place this above the JSX return:

```ts
const handleAudioRecorded = (file: File) => {
  void handleFilesPicked({
    0: file,
    length: 1,
    item: (i: number) => (i === 0 ? file : null),
  } as unknown as FileList);
};
```

(This reuses `handleFilesPicked` so upload logic stays DRY.)

Replace the disabled Voice placeholder button with:

```tsx
<AudioRecorderPopover onRecorded={handleAudioRecorded} />
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run typecheck:app
```

- [ ] **Step 4: Manually verify**

Click the Mic icon, grant browser mic permission, record 3 seconds, stop, preview, Attach. Verify the chip appears with audio controls and the Send button enables. Send and verify it appears in the conversation thread.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/components/dashboard/inbox/audio-recorder-popover.tsx \
        apps/app/src/components/dashboard/inbox/message-composer.tsx
git commit -m "feat(inbox): voice-note recorder in composer"
```

---

## Task 5: Notes — DB schema

**Files:**
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Add the notes table**

In `packages/db/src/schema.ts`, immediately after the `inboxMessages` table definition (after its closing `];`, around line 1121), add:

```ts
export const inboxConversationNotes = pgTable(
	"inbox_conversation_notes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => generateId("note_")),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => inboxConversations.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		text: text("text").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("inbox_note_conv_created_idx").on(
			table.conversationId,
			table.createdAt,
		),
		index("inbox_note_org_idx").on(table.organizationId),
		index("inbox_note_user_idx").on(table.userId),
	],
);
```

- [ ] **Step 2: Generate migration**

SSH tunnel must be up first (see CLAUDE.md "SSH Tunnel" section).

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run db:generate
```

Expected: new SQL file under `packages/db/src/migrations/` containing `CREATE TABLE "inbox_conversation_notes"`.

- [ ] **Step 3: Run migration**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run db:migrate
```

Expected: clean apply, no errors.

- [ ] **Step 4: Typecheck DB package**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run typecheck:db
```

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/migrations/
git commit -m "feat(db): add inbox_conversation_notes table"
```

---

## Task 6: Notes — API schemas

**Files:**
- Create: `apps/api/src/schemas/inbox-notes.ts`

- [ ] **Step 1: Write the schemas**

Create `apps/api/src/schemas/inbox-notes.ts`:

```ts
import { z } from "@hono/zod-openapi";

export const InboxNote = z
	.object({
		id: z.string().openapi({ example: "note_abc123" }),
		conversation_id: z.string(),
		organization_id: z.string(),
		user_id: z.string(),
		author_name: z.string().nullable(),
		author_email: z.string().nullable(),
		text: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	})
	.openapi("InboxNote");

export const ListInboxNotesResponse = z
	.object({
		data: z.array(InboxNote),
	})
	.openapi("ListInboxNotesResponse");

export const CreateInboxNoteBody = z
	.object({
		text: z.string().min(1).max(5000),
	})
	.openapi("CreateInboxNoteBody");

export const UpdateInboxNoteBody = z
	.object({
		text: z.string().min(1).max(5000),
	})
	.openapi("UpdateInboxNoteBody");

export const InboxNoteResponse = z
	.object({
		note: InboxNote,
	})
	.openapi("InboxNoteResponse");

export const DeleteInboxNoteResponse = z
	.object({
		success: z.boolean(),
	})
	.openapi("DeleteInboxNoteResponse");

export const NoteIdParam = z.object({
	noteId: z.string().openapi({ param: { name: "noteId", in: "path" } }),
});
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run typecheck:api
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/schemas/inbox-notes.ts
git commit -m "feat(api): add inbox notes zod schemas"
```

---

## Task 7: Notes — API routes

**Files:**
- Modify: `apps/api/src/routes/inbox-feed.ts`

**Auth + scope:** Notes must be organization-scoped. Resolve `orgId` via `c.get("orgId")` and assert conversation belongs to that org before operating. Use `workspaceScope` helper where `updateConversation` does (mirror existing patterns around line 523).

- [ ] **Step 1: Add imports**

At the top of `inbox-feed.ts` (with the existing `import` statements), add:

```ts
import { inboxConversationNotes, user as userTable } from "@relayapi/db";
import {
	CreateInboxNoteBody,
	DeleteInboxNoteResponse,
	InboxNoteResponse,
	ListInboxNotesResponse,
	NoteIdParam,
	UpdateInboxNoteBody,
} from "../schemas/inbox-notes";
```

Also ensure `ConversationIdParam` is already imported — it is, per existing routes.

- [ ] **Step 2: Add list notes route**

Append to `inbox-feed.ts` after the `deleteMessageRoute` handler (around line 1400):

```ts
// ---------------------------------------------------------------------------
// Notes — list
// ---------------------------------------------------------------------------

const listNotesRoute = createRoute({
	operationId: "listConversationNotes",
	method: "get",
	path: "/conversations/{id}/notes",
	tags: ["Inbox"],
	summary: "List internal notes on a conversation",
	security: [{ Bearer: [] }],
	request: { params: ConversationIdParam },
	responses: {
		200: {
			description: "List of notes",
			content: { "application/json": { schema: ListInboxNotesResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Conversation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listNotesRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { id: conversationId } = c.req.valid("param");

	const [conv] = await db
		.select({ id: inboxConversations.id })
		.from(inboxConversations)
		.where(
			and(
				eq(inboxConversations.id, conversationId),
				eq(inboxConversations.organizationId, orgId),
			),
		)
		.limit(1);

	if (!conv) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Conversation not found" } } as never,
			404 as never,
		);
	}

	const rows = await db
		.select({
			id: inboxConversationNotes.id,
			conversationId: inboxConversationNotes.conversationId,
			organizationId: inboxConversationNotes.organizationId,
			userId: inboxConversationNotes.userId,
			text: inboxConversationNotes.text,
			createdAt: inboxConversationNotes.createdAt,
			updatedAt: inboxConversationNotes.updatedAt,
			authorName: userTable.name,
			authorEmail: userTable.email,
		})
		.from(inboxConversationNotes)
		.leftJoin(userTable, eq(userTable.id, inboxConversationNotes.userId))
		.where(eq(inboxConversationNotes.conversationId, conversationId))
		.orderBy(inboxConversationNotes.createdAt);

	return c.json(
		{
			data: rows.map((r) => ({
				id: r.id,
				conversation_id: r.conversationId,
				organization_id: r.organizationId,
				user_id: r.userId,
				author_name: r.authorName ?? null,
				author_email: r.authorEmail ?? null,
				text: r.text,
				created_at: r.createdAt.toISOString(),
				updated_at: r.updatedAt.toISOString(),
			})),
		} as never,
		200,
	);
});
```

- [ ] **Step 3: Add create note route**

Append below `listNotesRoute`:

```ts
const createNoteRoute = createRoute({
	operationId: "createConversationNote",
	method: "post",
	path: "/conversations/{id}/notes",
	tags: ["Inbox"],
	summary: "Add an internal note to a conversation",
	security: [{ Bearer: [] }],
	request: {
		params: ConversationIdParam,
		body: {
			content: { "application/json": { schema: CreateInboxNoteBody } },
		},
	},
	responses: {
		201: {
			description: "Created note",
			content: { "application/json": { schema: InboxNoteResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Conversation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createNoteRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const userId = c.get("userId"); // set by auth middleware — verify exists in middleware before use
	const { id: conversationId } = c.req.valid("param");
	const body = c.req.valid("json");

	if (!userId) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "User context required" } } as never,
			401 as never,
		);
	}

	const [conv] = await db
		.select({ id: inboxConversations.id })
		.from(inboxConversations)
		.where(
			and(
				eq(inboxConversations.id, conversationId),
				eq(inboxConversations.organizationId, orgId),
			),
		)
		.limit(1);

	if (!conv) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Conversation not found" } } as never,
			404 as never,
		);
	}

	const [row] = await db
		.insert(inboxConversationNotes)
		.values({
			conversationId,
			organizationId: orgId,
			userId,
			text: body.text,
		})
		.returning();

	const [author] = await db
		.select({ name: userTable.name, email: userTable.email })
		.from(userTable)
		.where(eq(userTable.id, userId))
		.limit(1);

	return c.json(
		{
			note: {
				id: row.id,
				conversation_id: row.conversationId,
				organization_id: row.organizationId,
				user_id: row.userId,
				author_name: author?.name ?? null,
				author_email: author?.email ?? null,
				text: row.text,
				created_at: row.createdAt.toISOString(),
				updated_at: row.updatedAt.toISOString(),
			},
		} as never,
		201,
	);
});
```

- [ ] **Step 4: Verify userId is available on context**

Grep for `c.get("userId")` and confirm the auth middleware sets it. If it only sets `orgId`, use `c.get("user")?.id` or equivalent — adjust to match the existing middleware contract.

```bash
```

Run: `grep -rn 'c.set("userId"' apps/api/src` — if this returns the middleware that stamps userId, good. Otherwise check `c.set("user"` and adapt Step 3's `const userId` accordingly.

- [ ] **Step 5: Add update note route**

Append:

```ts
const updateNoteRoute = createRoute({
	operationId: "updateInboxNote",
	method: "patch",
	path: "/notes/{noteId}",
	tags: ["Inbox"],
	summary: "Update an internal note",
	security: [{ Bearer: [] }],
	request: {
		params: NoteIdParam,
		body: { content: { "application/json": { schema: UpdateInboxNoteBody } } },
	},
	responses: {
		200: {
			description: "Updated note",
			content: { "application/json": { schema: InboxNoteResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Note not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateNoteRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const userId = c.get("userId");
	const { noteId } = c.req.valid("param");
	const body = c.req.valid("json");

	if (!userId) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "User context required" } } as never,
			401 as never,
		);
	}

	const [existing] = await db
		.select()
		.from(inboxConversationNotes)
		.where(eq(inboxConversationNotes.id, noteId))
		.limit(1);

	if (!existing || existing.organizationId !== orgId) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Note not found" } } as never,
			404 as never,
		);
	}

	if (existing.userId !== userId) {
		return c.json(
			{ error: { code: "FORBIDDEN", message: "Cannot edit another user's note" } } as never,
			403 as never,
		);
	}

	const [row] = await db
		.update(inboxConversationNotes)
		.set({ text: body.text, updatedAt: new Date() })
		.where(eq(inboxConversationNotes.id, noteId))
		.returning();

	const [author] = await db
		.select({ name: userTable.name, email: userTable.email })
		.from(userTable)
		.where(eq(userTable.id, row.userId))
		.limit(1);

	return c.json(
		{
			note: {
				id: row.id,
				conversation_id: row.conversationId,
				organization_id: row.organizationId,
				user_id: row.userId,
				author_name: author?.name ?? null,
				author_email: author?.email ?? null,
				text: row.text,
				created_at: row.createdAt.toISOString(),
				updated_at: row.updatedAt.toISOString(),
			},
		} as never,
		200,
	);
});
```

- [ ] **Step 6: Add delete note route**

Append:

```ts
const deleteNoteRoute = createRoute({
	operationId: "deleteInboxNote",
	method: "delete",
	path: "/notes/{noteId}",
	tags: ["Inbox"],
	summary: "Delete an internal note",
	security: [{ Bearer: [] }],
	request: { params: NoteIdParam },
	responses: {
		200: {
			description: "Deleted",
			content: { "application/json": { schema: DeleteInboxNoteResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Note not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteNoteRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const userId = c.get("userId");
	const { noteId } = c.req.valid("param");

	if (!userId) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "User context required" } } as never,
			401 as never,
		);
	}

	const [existing] = await db
		.select()
		.from(inboxConversationNotes)
		.where(eq(inboxConversationNotes.id, noteId))
		.limit(1);

	if (!existing || existing.organizationId !== orgId) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Note not found" } } as never,
			404 as never,
		);
	}

	if (existing.userId !== userId) {
		return c.json(
			{ error: { code: "FORBIDDEN", message: "Cannot delete another user's note" } } as never,
			403 as never,
		);
	}

	await db.delete(inboxConversationNotes).where(eq(inboxConversationNotes.id, noteId));

	return c.json({ success: true } as never, 200);
});
```

- [ ] **Step 7: Typecheck**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run typecheck:api
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/inbox-feed.ts
git commit -m "feat(api): add inbox conversation notes CRUD"
```

---

## Task 8: Notes — API tests

**Files:**
- Create: `apps/api/src/__tests__/inbox-notes.test.ts`

**Test strategy:** Mirror `auth.test.ts` and `unit.test.ts` patterns (Bun's `test`/`expect`). These are integration tests that exercise the HTTP surface with a real in-process Hono app and a real test DB. Look at `apps/api/src/__tests__/auth.test.ts` first to copy its test harness/setup conventions (DB setup, auth bearer fixture, teardown). Do **not** invent a new harness.

- [ ] **Step 1: Copy test harness**

Open `apps/api/src/__tests__/auth.test.ts`. Identify how it boots the app and how it inserts a test organization + user + conversation. The note tests use the same pattern. If the harness lives in a helper, reuse it; if inline, inline it.

- [ ] **Step 2: Write tests**

Create `apps/api/src/__tests__/inbox-notes.test.ts`. Each `test` block exercises one behavior. Actual test implementations (setup / teardown / bearer auth) MUST mirror `auth.test.ts` — do not fabricate a different harness.

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
// ... import the exact harness helpers used by auth.test.ts

// Helpers/fixtures mirroring auth.test.ts:
// - bootApp()
// - createOrgAndUser() -> { orgId, userId, bearer }
// - createConversation(orgId) -> { id }

let app: ReturnType<typeof bootApp>;
let fixture: Awaited<ReturnType<typeof createOrgAndUser>>;
let convId: string;

beforeAll(async () => {
  app = bootApp();
  fixture = await createOrgAndUser();
  convId = (await createConversation(fixture.orgId)).id;
});

afterAll(async () => {
  // mirror auth.test.ts teardown
});

test("POST /v1/inbox/conversations/:id/notes creates a note", async () => {
  const res = await app.request(`/v1/inbox/conversations/${convId}/notes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fixture.bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "Internal memo" }),
  });
  expect(res.status).toBe(201);
  const json = await res.json();
  expect(json.note.text).toBe("Internal memo");
  expect(json.note.user_id).toBe(fixture.userId);
});

test("GET /v1/inbox/conversations/:id/notes returns notes in order", async () => {
  const res = await app.request(`/v1/inbox/conversations/${convId}/notes`, {
    headers: { Authorization: `Bearer ${fixture.bearer}` },
  });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(Array.isArray(json.data)).toBe(true);
  expect(json.data.length).toBeGreaterThanOrEqual(1);
});

test("PATCH /v1/inbox/notes/:noteId updates own note", async () => {
  const created = await app
    .request(`/v1/inbox/conversations/${convId}/notes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "v1" }),
    })
    .then((r) => r.json());

  const res = await app.request(`/v1/inbox/notes/${created.note.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${fixture.bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "v2" }),
  });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.note.text).toBe("v2");
  expect(new Date(json.note.updated_at).getTime())
    .toBeGreaterThan(new Date(json.note.created_at).getTime());
});

test("PATCH another user's note returns 403", async () => {
  const otherFixture = await createOrgAndUser({ sameOrg: fixture.orgId });
  const created = await app
    .request(`/v1/inbox/conversations/${convId}/notes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "mine" }),
    })
    .then((r) => r.json());

  const res = await app.request(`/v1/inbox/notes/${created.note.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${otherFixture.bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "theirs" }),
  });
  expect(res.status).toBe(403);
});

test("DELETE /v1/inbox/notes/:noteId removes own note", async () => {
  const created = await app
    .request(`/v1/inbox/conversations/${convId}/notes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "bye" }),
    })
    .then((r) => r.json());

  const del = await app.request(`/v1/inbox/notes/${created.note.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${fixture.bearer}` },
  });
  expect(del.status).toBe(200);

  const list = await app
    .request(`/v1/inbox/conversations/${convId}/notes`, {
      headers: { Authorization: `Bearer ${fixture.bearer}` },
    })
    .then((r) => r.json());
  expect(list.data.some((n: { id: string }) => n.id === created.note.id)).toBe(false);
});

test("404 when conversation belongs to another org", async () => {
  const foreign = await createOrgAndUser();
  const res = await app.request(`/v1/inbox/conversations/${convId}/notes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${foreign.bearer}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: "sneaky" }),
  });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/zank/Developer/majestico/relayapi/apps/api && bun test src/__tests__/inbox-notes.test.ts
```

Expected: all tests pass. If a test fails because the harness differs from `auth.test.ts`, adapt — do not rewrite the endpoint to match a broken test.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/inbox-notes.test.ts
git commit -m "test(api): cover inbox notes CRUD"
```

---

## Task 9: Notes — SDK methods

**Files:**
- Modify: `packages/sdk/src/resources/inbox/conversations.ts`

Per CLAUDE.md "Tool Rules": always update the SDK when API routes change.

- [ ] **Step 1: Add types**

At the bottom of `conversations.ts` (below existing `export` type blocks), add:

```ts
export interface InboxNote {
  id: string;
  conversation_id: string;
  organization_id: string;
  user_id: string;
  author_name: string | null;
  author_email: string | null;
  text: string;
  created_at: string;
  updated_at: string;
}

export interface NoteListResponse {
  data: InboxNote[];
}

export interface NoteResponse {
  note: InboxNote;
}

export interface NoteCreateParams {
  text: string;
}

export interface NoteUpdateParams {
  text: string;
}

export interface NoteDeleteResponse {
  success: boolean;
}
```

- [ ] **Step 2: Add methods to `Conversations` class**

Inside the `Conversations` class (after `deleteMessage`), add:

```ts
/**
 * List internal notes on a conversation
 */
listNotes(
  conversationID: string,
  options?: RequestOptions,
): APIPromise<NoteListResponse> {
  return this._client.get(
    path`/v1/inbox/conversations/${conversationID}/notes`,
    options,
  );
}

/**
 * Add an internal note to a conversation
 */
createNote(
  conversationID: string,
  body: NoteCreateParams,
  options?: RequestOptions,
): APIPromise<NoteResponse> {
  return this._client.post(
    path`/v1/inbox/conversations/${conversationID}/notes`,
    { body, ...options },
  );
}

/**
 * Update an internal note
 */
updateNote(
  noteID: string,
  body: NoteUpdateParams,
  options?: RequestOptions,
): APIPromise<NoteResponse> {
  return this._client.patch(path`/v1/inbox/notes/${noteID}`, {
    body,
    ...options,
  });
}

/**
 * Delete an internal note
 */
deleteNote(
  noteID: string,
  options?: RequestOptions,
): APIPromise<NoteDeleteResponse> {
  return this._client.delete(path`/v1/inbox/notes/${noteID}`, options);
}
```

- [ ] **Step 3: Build SDK + typecheck**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run build:sdk && bun run typecheck:api && bun run typecheck:app
```

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/resources/inbox/conversations.ts packages/sdk/dist/
git commit -m "feat(sdk): add inbox notes methods"
```

---

## Task 10: Notes — App-side proxy routes

**Files:**
- Create: `apps/app/src/pages/api/inbox/conversations/[id]/notes/index.ts`
- Create: `apps/app/src/pages/api/inbox/notes/[noteId].ts`

- [ ] **Step 1: Write list+create proxy**

Create `apps/app/src/pages/api/inbox/conversations/[id]/notes/index.ts`:

```ts
import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const GET: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.inbox.conversations.listNotes(ctx.params.id!);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const POST: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const body = await ctx.request.json();
    const data = await client.inbox.conversations.createNote(ctx.params.id!, body);
    return Response.json(data, { status: 201 });
  } catch (e) {
    return handleSdkError(e);
  }
};
```

- [ ] **Step 2: Write patch+delete proxy**

Create `apps/app/src/pages/api/inbox/notes/[noteId].ts`:

```ts
import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

export const PATCH: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const body = await ctx.request.json();
    const data = await client.inbox.conversations.updateNote(ctx.params.noteId!, body);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const client = await requireClient(ctx);
  if (client instanceof Response) return client;
  try {
    const data = await client.inbox.conversations.deleteNote(ctx.params.noteId!);
    return Response.json(data);
  } catch (e) {
    return handleSdkError(e);
  }
};
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run typecheck:app
```

- [ ] **Step 4: Commit**

```bash
git add apps/app/src/pages/api/inbox/conversations/[id]/notes/index.ts \
        apps/app/src/pages/api/inbox/notes/[noteId].ts
git commit -m "feat(app): proxy routes for inbox notes"
```

---

## Task 11: Notes — UI rendering in chat thread

**Files:**
- Modify: `apps/app/src/components/dashboard/inbox/shared.ts`
- Create: `apps/app/src/components/dashboard/inbox/conversation-notes.tsx`
- Modify: `apps/app/src/components/dashboard/inbox/chat-thread.tsx`

- [ ] **Step 1: Add `NoteItem` type**

In `apps/app/src/components/dashboard/inbox/shared.ts`, add:

```ts
export interface NoteItem {
  id: string;
  conversation_id: string;
  user_id: string;
  author_name: string | null;
  author_email: string | null;
  text: string;
  created_at: string;
  updated_at: string;
}

export type ThreadItem =
  | { kind: "message"; createdAt: string; data: MessageItem }
  | { kind: "note"; createdAt: string; data: NoteItem };
```

- [ ] **Step 2: Write NoteCard renderer**

Create `apps/app/src/components/dashboard/inbox/conversation-notes.tsx`:

```tsx
import { StickyNote, Trash2 } from "lucide-react";
import { formatMessageTime } from "./shared";
import type { NoteItem } from "./shared";

export function NoteCard({
  note,
  canDelete,
  onDelete,
}: {
  note: NoteItem;
  canDelete: boolean;
  onDelete?: () => void;
}) {
  const author = note.author_name?.trim() || note.author_email || "Teammate";
  return (
    <div className="mx-auto flex w-full max-w-[520px] items-start gap-2 rounded-lg border border-[#f0d27f] bg-[#fff8e0] px-3 py-2">
      <StickyNote className="mt-0.5 size-4 shrink-0 text-[#a57f1c]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-medium text-[#7a5c15]">{author}</p>
          <span className="text-[11px] text-[#a57f1c]">
            {formatMessageTime(note.created_at)}
          </span>
        </div>
        <p className="whitespace-pre-wrap text-[13px] leading-5 text-[#5d4511]">
          {note.text}
        </p>
      </div>
      {canDelete && onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 rounded p-1 text-[#a57f1c] opacity-60 hover:bg-[#fdeeba] hover:opacity-100"
          title="Delete note"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Load notes in chat-thread**

In `apps/app/src/components/dashboard/inbox/chat-thread.tsx`:

At the top (with other imports):

```ts
import type { NoteItem, ThreadItem } from "./shared";
import { NoteCard } from "./conversation-notes";
```

Add state near the existing `messages` state:

```ts
const [notes, setNotes] = useState<NoteItem[]>([]);
```

Add a fetch function — place it near `fetchMessages` (existing) and call it on conversation change:

```ts
const fetchNotes = useCallback(async () => {
  if (!conversation) {
    setNotes([]);
    return;
  }
  try {
    const res = await fetch(
      `/api/inbox/conversations/${encodeURIComponent(conversation.id)}/notes`,
    );
    if (!res.ok) return;
    const json = (await res.json()) as { data: NoteItem[] };
    setNotes(json.data);
  } catch {
    // silent — notes are non-critical
  }
}, [conversation]);

useEffect(() => {
  void fetchNotes();
}, [fetchNotes]);
```

- [ ] **Step 4: Merge and render**

Locate the `{messages.map(...)}` block inside the rendered thread. Replace the pre-map derivation with a merged sorted list:

```ts
const threadItems: ThreadItem[] = [
  ...messages.map((m) => ({ kind: "message" as const, createdAt: m.created_at, data: m })),
  ...notes.map((n) => ({ kind: "note" as const, createdAt: n.created_at, data: n })),
].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
```

Change the rendered loop to iterate `threadItems` and branch by `kind`:

```tsx
<AnimatePresence initial={false}>
  {threadItems.map((item, index) => {
    if (item.kind === "note") {
      return (
        <motion.div
          key={`note-${item.data.id}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.12, ease: [0.32, 0.72, 0, 1] } }}
        >
          <NoteCard
            note={item.data}
            canDelete={item.data.user_id === currentUserId}
            onDelete={async () => {
              await fetch(`/api/inbox/notes/${item.data.id}`, { method: "DELETE" });
              setNotes((prev) => prev.filter((n) => n.id !== item.data.id));
            }}
          />
        </motion.div>
      );
    }

    // Existing message rendering: take the body of the prior map callback,
    // replace `msg` with `item.data` and `previous` lookup with
    // `threadItems.slice(0, index).reverse().find((t) => t.kind === "message")?.data`.
    const msg = item.data;
    const previous = threadItems
      .slice(0, index)
      .reverse()
      .find((t) => t.kind === "message")?.data;
    const isOutbound = msg.sender === "user";
    const showDayDivider =
      !previous || dayKey(previous.created_at) !== dayKey(msg.created_at);
    return (
      // ... existing <motion.div key={msg.id}> JSX unchanged
    );
  })}
</AnimatePresence>
```

**Important:** preserve the existing message-rendering JSX verbatim — the only structural change is the outer loop variable rename and the day-divider `previous` lookup.

`currentUserId` comes from the existing user context hook. Grep for `useUser(` to find the right import; it's already used elsewhere in the dashboard. Add it to this component if not already imported.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run typecheck:app
```

- [ ] **Step 6: Manually verify**

Create a note via `curl` or once Task 12 is done via the UI, then verify it appears in the thread, interleaved by timestamp, with the yellow styling and trash icon only on your own notes.

- [ ] **Step 7: Commit**

```bash
git add apps/app/src/components/dashboard/inbox/shared.ts \
        apps/app/src/components/dashboard/inbox/conversation-notes.tsx \
        apps/app/src/components/dashboard/inbox/chat-thread.tsx
git commit -m "feat(inbox): render internal notes inline in thread"
```

---

## Task 12: Notes — Composer tab wiring

**Files:**
- Modify: `apps/app/src/components/dashboard/inbox/message-composer.tsx`
- Modify: `apps/app/src/components/dashboard/inbox/chat-thread.tsx`

- [ ] **Step 1: Add mode state + prop contract**

In `message-composer.tsx`:

```ts
type ComposerMode = "reply" | "note";

export function MessageComposer({
  onSend,
  onCreateNote,
  disabled,
  platformLabel,
}: {
  onSend: (payload: {
    text: string;
    attachments: Array<{ url: string; type: string }>;
  }) => Promise<void>;
  onCreateNote: (text: string) => Promise<void>;
  disabled?: boolean;
  platformLabel: string;
}) {
  const [mode, setMode] = useState<ComposerMode>("reply");
  // ...existing state
}
```

- [ ] **Step 2: Enable the Note tab and style on active**

Replace the two tab buttons at the top of the composer JSX:

```tsx
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
```

- [ ] **Step 3: Adjust textarea styling + placeholder per mode**

```tsx
<textarea
  ref={textareaRef}
  value={text}
  onChange={(e) => setText(e.target.value)}
  onKeyDown={handleKeyDown}
  placeholder={mode === "note" ? "Add a private note for your team" : "Reply here"}
  rows={3}
  disabled={disabled}
  className={cn(
    "min-h-[96px] w-full resize-none px-4 py-3 text-[14px] leading-6 outline-none placeholder:text-slate-400 disabled:opacity-50 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
    mode === "note" ? "bg-[#fff8e0] text-[#5d4511]" : "bg-white text-slate-700",
  )}
/>
```

- [ ] **Step 4: Route handleSubmit by mode**

```ts
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
  // ... existing reply branch unchanged
};
```

- [ ] **Step 5: Hide attachment toolbar in note mode**

Wrap the attachment/emoji toolbar in a conditional so notes only have emoji + text:

```tsx
<div className="flex items-center gap-0.5">
  <EmojiPicker onInsert={insertAtCursor} />
  {mode === "reply" && (
    <>
      <button onClick={() => imageInputRef.current?.click()} ... /* image */ />
      <button onClick={() => fileInputRef.current?.click()} ... /* file */ />
      <AudioRecorderPopover onRecorded={handleAudioRecorded} />
    </>
  )}
</div>
```

And update the Send button label/color for note mode:

```tsx
<button
  type="button"
  onClick={() => void handleSubmit()}
  disabled={/* ... as before but when mode==="note", only require text */}
  className={cn(
    "inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors",
    mode === "note"
      ? text.trim() && !disabled
        ? "bg-[#d4a72c] text-white hover:bg-[#b88e1f]"
        : "bg-[#f3e4a8] text-white"
      : (text.trim() || attachments.some((a) => !a.uploading && !a.error)) && !disabled
        ? "bg-[#2d71f8] text-white hover:bg-[#195fe7]"
        : "bg-[#d9e7ff] text-white",
  )}
>
  {sending ? <Loader2 className="size-4 animate-spin" /> : <SendHorizonal className="size-4" />}
  {mode === "note" ? "Save note" : `Send to ${platformLabel}`}
</button>
```

- [ ] **Step 6: Wire `onCreateNote` in chat-thread**

In `chat-thread.tsx`, add:

```ts
const handleCreateNote = async (text: string) => {
  if (!conversation) return;
  const res = await fetch(
    `/api/inbox/conversations/${encodeURIComponent(conversation.id)}/notes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  if (!res.ok) throw new Error("Failed to save note");
  const json = (await res.json()) as { note: NoteItem };
  setNotes((prev) => [...prev, json.note]);
};
```

Pass it to the composer:

```tsx
<MessageComposer
  onSend={handleSend}
  onCreateNote={handleCreateNote}
  // ... existing props
/>
```

- [ ] **Step 7: Typecheck**

```bash
cd /Users/zank/Developer/majestico/relayapi && bun run typecheck:app
```

- [ ] **Step 8: Manually verify**

Open a conversation, click the "Note" tab, type a note, click "Save note". Verify the note appears inline in the thread (yellow styling), and when you switch back to Reply, you can still send messages. Delete your note via the trash icon.

- [ ] **Step 9: Commit**

```bash
git add apps/app/src/components/dashboard/inbox/message-composer.tsx \
        apps/app/src/components/dashboard/inbox/chat-thread.tsx
git commit -m "feat(inbox): note composer tab"
```

---

## Self-Review

**Spec coverage**

| Requirement | Task |
|---|---|
| Note system — storage | Task 5 (DB) |
| Note system — API | Tasks 6, 7, 8 (schemas, routes, tests) |
| Note system — SDK + proxy | Tasks 9, 10 |
| Note system — UI read | Task 11 |
| Note system — UI write (composer tab) | Task 12 |
| Emoji picker | Task 2 |
| Image picker | Task 3 (image input + chip) |
| File picker | Task 3 (generic file input + chip) |
| Audio recorder | Task 4 |
| Shared upload helper | Task 1 |

No spec gaps.

**Placeholder scan**

- Task 4 step 2 `handleAudioRecorded`: builds a `FileList`-shaped object from a single `File`. An alternative is `new DataTransfer().items.add(file).files`. If a future reviewer prefers the DataTransfer approach, swap the two lines; the behavior is identical. Not a placeholder — the code is complete.
- Task 7 step 4 requires grepping for `userId` context shape. This is a verification step, not a placeholder — the fix is prescribed: adapt the `c.get("userId")` calls to whatever shape the existing middleware uses.
- Task 8 step 1/2 reference the existing auth test harness without inlining it. This is deliberate DRY — copying the harness inline would diverge from `auth.test.ts` over time. The step explicitly tells the engineer to open `auth.test.ts` and mirror it.
- Task 11 step 4 message-rendering JSX references "existing `<motion.div key={msg.id}>` JSX unchanged". The engineer must preserve verbatim, not rewrite. This is documented, not a placeholder.

**Type consistency**

- `NoteItem` (app) and `InboxNote` (SDK) have the same field shape.
- Schema names: `CreateInboxNoteBody` / `UpdateInboxNoteBody` are used in both `inbox-notes.ts` (Task 6) and route definitions (Task 7).
- `onSend` signature change in Task 3 propagates to Task 4 (`handleFilesPicked` still takes `FileList`) and Task 12 (mode branch).
- `NoteListResponse` / `NoteResponse` names consistent across Tasks 9, 10.

**Risk notes**

- **`c.get("userId")` may be `c.get("user")?.id`** depending on the actual auth middleware. Task 7 Step 4 verifies and adapts — budget 5 extra minutes there.
- **Radix ScrollArea in chat-thread** (already landed) wraps viewport content in `display: table`; if auto-scroll-to-bottom on new messages regresses after inserting notes, check that `scrollIntoView` on `messagesEndRef` still targets the correct ancestor. Manual verify step in Task 11 covers this.
- **Audio format** is `audio/webm`. Safari may produce `audio/mp4` instead. `MediaRecorder` silently downgrades `mimeType` if unsupported — the recorded blob will still work, but the file extension mismatch is a minor cosmetic issue. Out of scope for v1.
- **Platform attachment support**: only Facebook/Instagram send attachments today. WhatsApp/Telegram/etc. will accept the attachments in `SendMessageBody` but the existing handler may ignore them. That's a downstream backend task — out of scope here, but documented so the engineer doesn't mistake it for a regression.
