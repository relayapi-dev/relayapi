import { useState, useCallback, useEffect } from "react";
import { motion } from "motion/react";
import {
  Plus,
  FileText,
  Loader2,
  Pencil,
  Trash2,
  Tag,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";

// --- Animation ---

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const },
  },
};

// --- Types ---

interface ContentTemplate {
  id: string;
  name: string;
  description: string | null;
  content: string;
  platform_overrides: Record<string, string> | null;
  tags: string[];
  workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

// --- Create/Edit Dialog ---

function TemplateDialog({
  open,
  onOpenChange,
  onSaved,
  editData,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  editData: ContentTemplate | null;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = !!editData;

  // Sync form fields when dialog opens or editData changes
  useEffect(() => {
    if (!open) return;
    if (editData) {
      setName(editData.name);
      setDescription(editData.description || "");
      setContent(editData.content);
      setTags((editData.tags || []).join(", "));
    } else {
      setName("");
      setDescription("");
      setContent("");
      setTags("");
    }
    setError(null);
  }, [open, editData]);

  const handleOpenChange = (v: boolean) => {
    onOpenChange(v);
  };

  const handleSubmit = async () => {
    if (!name.trim() || !content.trim()) {
      setError("Name and content are required.");
      return;
    }
    setSaving(true);
    setError(null);

    const parsedTags = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const body = {
      name: name.trim(),
      description: description.trim() || undefined,
      content: content.trim(),
      tags: parsedTags.length > 0 ? parsedTags : undefined,
    };

    try {
      const url = isEdit
        ? `/api/content-templates/${editData.id}`
        : "/api/content-templates";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setError(err?.error?.message || `Error ${res.status}`);
        return;
      }

      onSaved();
      onOpenChange(false);
      setName("");
      setDescription("");
      setContent("");
      setTags("");
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Template" : "Create Template"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-foreground/70">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly Promo"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-foreground/70">
              Description{" "}
              <span className="text-foreground/40">(optional)</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When should this template be used?"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-foreground/70">
                Content
              </label>
              <span className="text-[11px] text-foreground/40">
                {content.length.toLocaleString()} chars
              </span>
            </div>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              placeholder="Write your template content here. Use {{variable}} for dynamic parts."
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring font-mono"
            />
            <div className="mt-1.5 flex gap-1.5">
              {["{{date}}", "{{account_name}}"].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setContent((c) => c + v)}
                  className="rounded border border-border bg-accent/30 px-1.5 py-0.5 text-[11px] font-mono text-foreground/60 hover:bg-accent/50 transition-colors"
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-foreground/70">
              Tags <span className="text-foreground/40">(comma-separated)</span>
            </label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="promo, weekly, product"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={handleSubmit}>
            {saving && <Loader2 className="size-3 animate-spin mr-1" />}
            {isEdit ? "Update" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Delete Confirmation ---

function DeleteConfirmDialog({
  open,
  onOpenChange,
  templateName,
  onConfirm,
  deleting,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  templateName: string;
  onConfirm: () => void;
  deleting: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete Template</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-foreground/70">
          Are you sure you want to delete <strong>{templateName}</strong>? This
          action cannot be undone.
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={onConfirm}
          >
            {deleting && <Loader2 className="size-3 animate-spin mr-1" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Template Card ---

function TemplateCard({
  template,
  onEdit,
  onDelete,
}: {
  template: ContentTemplate;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(template.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const overrideCount = template.platform_overrides
    ? Object.keys(template.platform_overrides).length
    : 0;

  return (
    <motion.div variants={fadeUp}>
      <div className="group rounded-lg border border-border bg-background p-4 hover:border-foreground/20 transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium truncate">{template.name}</h3>
            {template.description && (
              <p className="mt-0.5 text-xs text-foreground/50 truncate">
                {template.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={handleCopy}
              className="rounded p-1 hover:bg-accent/50 transition-colors"
              title="Copy content"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-500" />
              ) : (
                <Copy className="size-3.5 text-foreground/50" />
              )}
            </button>
            <button
              onClick={onEdit}
              className="rounded p-1 hover:bg-accent/50 transition-colors"
              title="Edit"
            >
              <Pencil className="size-3.5 text-foreground/50" />
            </button>
            <button
              onClick={onDelete}
              className="rounded p-1 hover:bg-accent/50 transition-colors"
              title="Delete"
            >
              <Trash2 className="size-3.5 text-foreground/50" />
            </button>
          </div>
        </div>

        <p className="mt-2 text-xs text-foreground/60 line-clamp-2 font-mono whitespace-pre-wrap">
          {template.content}
        </p>

        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {template.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-accent/40 px-2 py-0.5 text-[11px] font-medium text-foreground/60"
            >
              <Tag className="size-2.5" />
              {tag}
            </span>
          ))}
          {overrideCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
              {overrideCount} platform override{overrideCount > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// --- Main Page ---

export function TemplatesPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editData, setEditData] = useState<ContentTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ContentTemplate | null>(null);
  const [deleting, setDeleting] = useState(false);

  const {
    data: templates,
    loading,
    error,
    hasMore,
    loadMore,
    loadingMore,
    refetch,
  } = usePaginatedApi<ContentTemplate>("content-templates");

  const handleEdit = (template: ContentTemplate) => {
    setEditData(template);
    setDialogOpen(true);
  };

  const handleNewTemplate = () => {
    setEditData(null);
    setDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/content-templates/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (res.ok || res.status === 204) {
        refetch();
        setDeleteTarget(null);
      }
    } catch {
      // ignore
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-medium">Content Templates</h1>
          <p className="text-xs text-foreground/50 mt-0.5">
            Reusable post templates with variables and platform overrides
          </p>
        </div>
        <Button
          size="sm"
          className="gap-1.5 h-7 text-xs"
          onClick={handleNewTemplate}
        >
          <Plus className="size-3.5" />
          New Template
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-foreground/30" />
        </div>
      )}

      {/* Empty State */}
      {!loading && templates.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-accent/50 p-3 mb-3">
            <FileText className="size-5 text-foreground/40" />
          </div>
          <h3 className="text-sm font-medium">No templates yet</h3>
          <p className="text-xs text-foreground/50 mt-1 max-w-xs">
            Save reusable post templates to speed up content creation across
            platforms.
          </p>
          <Button
            size="sm"
            className="mt-4 gap-1.5 text-xs"
            onClick={handleNewTemplate}
          >
            <Plus className="size-3.5" />
            Create Template
          </Button>
        </div>
      )}

      {/* Template Grid */}
      {!loading && templates.length > 0 && (
        <motion.div
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          variants={stagger}
          initial={false}
          animate="visible"
        >
          {templates.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              onEdit={() => handleEdit(t)}
              onDelete={() => setDeleteTarget(t)}
            />
          ))}
        </motion.div>
      )}

      {/* Load More */}
      <LoadMore
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={loadMore}
        count={templates.length}
      />

      {/* Dialogs */}
      <TemplateDialog
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
          if (!v) setEditData(null);
        }}
        onSaved={refetch}
        editData={editData}
      />

      <DeleteConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        templateName={deleteTarget?.name || ""}
        onConfirm={handleDelete}
        deleting={deleting}
      />
    </div>
  );
}
