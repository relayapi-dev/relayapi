import { useState } from "react";
import { motion } from "motion/react";
import { Plus, Loader2, FolderOpen, Trash2, Edit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePaginatedApi, useMutation } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface Workspace {
  id: string;
  name: string;
  description: string | null;
  account_ids: string[];
  created_at: string;
}

export function WorkspacesPage() {
  const {
    data: groups,
    loading,
    error,
    hasMore,
    loadMore,
    loadingMore,
    refetch,
  } = usePaginatedApi<Workspace>("workspaces");

  const createMutation = useMutation<Workspace>("workspaces", "POST");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const result = await createMutation.mutate({
      name: newName.trim(),
      description: newDescription.trim() || null,
    });
    if (result) {
      setShowCreate(false);
      setNewName("");
      setNewDescription("");
      refetch();
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) refetch();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Workspaces</h1>
        <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setShowCreate(true)}>
          <Plus className="size-3.5" />
          Create Workspace
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {showCreate && (
        <motion.div
          className="rounded-md border border-border p-4 space-y-3"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Workspace name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Marketing Team"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
            <input
              type="text"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Describe this workspace..."
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={!newName.trim() || createMutation.loading}
              onClick={handleCreate}
            >
              {createMutation.loading ? <Loader2 className="size-3 animate-spin" /> : "Create"}
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
          </div>
          {createMutation.error && (
            <p className="text-xs text-destructive">{createMutation.error}</p>
          )}
        </motion.div>
      )}

      {groups.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-12 text-center">
          <FolderOpen className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No workspaces</p>
          <p className="text-xs text-muted-foreground mt-1">
            Organize your connected accounts to post to multiple accounts at once
          </p>
        </div>
      ) : (
        <>
          <motion.div
            className="space-y-3"
            variants={stagger}
            initial="hidden"
            animate="visible"
          >
            {groups.map((group) => (
              <motion.div
                key={group.id}
                variants={fadeUp}
                className="rounded-md border border-border p-4 hover:bg-accent/20 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div className="rounded-md bg-primary/10 p-1.5 mt-0.5">
                      <FolderOpen className="size-4 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-sm font-medium">{group.name}</h3>
                      {group.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {group.description}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        {(group.account_ids || []).length} account{(group.account_ids || []).length !== 1 ? "s" : ""}
                        {" "}&middot; Created{" "}
                        {new Date(group.created_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className="rounded-lg p-1.5 hover:bg-accent/50 transition-colors"
                      title="Edit workspace"
                    >
                      <Edit2 className="size-4 text-muted-foreground" />
                    </button>
                    <button
                      className="rounded-lg p-1.5 hover:bg-red-500/10 transition-colors"
                      onClick={() => handleDelete(group.id)}
                      title="Delete workspace"
                    >
                      <Trash2 className="size-4 text-muted-foreground hover:text-red-400" />
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
          <LoadMore
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={loadMore}
            count={groups.length}
          />
        </>
      )}
    </div>
  );
}
