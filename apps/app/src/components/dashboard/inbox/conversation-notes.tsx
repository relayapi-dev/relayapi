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
