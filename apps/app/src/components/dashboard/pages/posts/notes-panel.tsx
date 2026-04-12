import { useState, useEffect } from "react";
import { useUser } from "@/components/dashboard/user-context";

interface NoteEntry {
  text: string;
  created_at: string;
  user_id?: string;
  user_name?: string;
  user_image?: string | null;
}

export function NotesPanel({ postId }: { postId: string }) {
  const user = useUser();
  const [note, setNote] = useState("");
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/posts/${postId}/notes`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.notes) {
          try {
            const parsed = JSON.parse(data.notes);
            if (Array.isArray(parsed)) {
              setNotes(parsed);
            } else if (typeof data.notes === "string" && data.notes.trim()) {
              setNotes([{ text: data.notes, created_at: new Date().toISOString() }]);
            }
          } catch {
            if (typeof data.notes === "string" && data.notes.trim()) {
              setNotes([{ text: data.notes, created_at: new Date().toISOString() }]);
            }
          }
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, [postId]);

  const handleSave = async () => {
    if (!note.trim()) return;
    setSaving(true);
    try {
      const newEntry: NoteEntry = {
        text: note.trim(),
        created_at: new Date().toISOString(),
        user_id: user?.id,
        user_name: user?.name,
        user_image: user?.image,
      };
      const updated = [...notes, newEntry];
      await fetch(`/api/posts/${postId}/notes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: JSON.stringify(updated) }),
      });
      setNotes(updated);
      setNote("");
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">Notes</h4>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : (
        <>
          {notes.length > 0 && (
            <div className="space-y-2.5 max-h-48 overflow-y-auto">
              {notes.map((n, i) => (
                <div key={i} className="flex items-start gap-2">
                  {/* User avatar with name tooltip */}
                  <div className="shrink-0 mt-0.5" title={n.user_name || "Unknown user"}>
                    {n.user_image ? (
                      <img
                        src={n.user_image}
                        alt={n.user_name || "User"}
                        className="size-5 rounded-full object-cover"
                      />
                    ) : (
                      <div className="size-5 rounded-full bg-muted flex items-center justify-center text-[9px] font-medium text-muted-foreground">
                        {(n.user_name || "U").charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                  {/* Note content */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-foreground/80">{n.text}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {new Date(n.created_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note..."
            rows={3}
            className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSave();
              }
            }}
          />
          <button
            onClick={handleSave}
            disabled={saving || !note.trim()}
            className="w-full rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Add Note"}
          </button>
        </>
      )}
    </div>
  );
}
