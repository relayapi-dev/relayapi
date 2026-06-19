import { useState, useEffect, useRef, useMemo } from "react";
import { motion } from "motion/react";
import { Plus, Copy, Shield, Loader2, Trash2, Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { usePaginatedApi, useMutation } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";
import { PageHeader } from "@/components/dashboard/page-header";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface ApiKey {
  id: string;
  name: string | null;
  start: string;
  prefix: string | null;
  created_at: string;
  expires_at: string | null;
  enabled: boolean;
  permission: "read_write" | "read_only";
  workspace_scope: "all" | string[];
}

interface CreatedKey {
  id: string;
  key: string;
  name: string;
  prefix: string;
  created_at: string;
  expires_at: string | null;
  permission: "read_write" | "read_only";
  workspace_scope: "all" | string[];
}

interface Workspace {
  id: string;
  name: string;
}


export function ApiKeysPage() {
  const { data: keys, loading, error, refetch, hasMore, loadMore, loadingMore } = usePaginatedApi<ApiKey>("api-keys");
  const createMutation = useMutation<CreatedKey>("api-keys", "POST");
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const _deleteMutation = useMutation("", "DELETE");

  // Scope state
  const [permission, setPermission] = useState<"read_write" | "read_only">("read_write");
  const [allWorkspaces, setAllWorkspaces] = useState(true);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([]);
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [debouncedWsSearch, setDebouncedWsSearch] = useState("");
  const wsSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (wsSearchTimer.current) clearTimeout(wsSearchTimer.current);
    wsSearchTimer.current = setTimeout(() => setDebouncedWsSearch(workspaceSearch), 300);
    return () => { if (wsSearchTimer.current) clearTimeout(wsSearchTimer.current); };
  }, [workspaceSearch]);

  const wsQuery = useMemo(() => {
    const q: Record<string, string | undefined> = {};
    if (debouncedWsSearch.trim()) q.search = debouncedWsSearch.trim();
    return q;
  }, [debouncedWsSearch]);

  const {
    data: filteredWorkspaces,
    loading: workspacesLoading,
    hasMore: wsHasMore,
    loadMore: wsLoadMore,
    loadingMore: wsLoadingMore,
  } = usePaginatedApi<Workspace>(
    showCreate && !allWorkspaces ? "workspaces" : null,
    { limit: 30, query: wsQuery },
  );

  const resetForm = () => {
    setNewKeyName("");
    setPermission("read_write");
    setAllWorkspaces(true);
    setSelectedWorkspaceIds([]);
    setWorkspaceSearch("");
    setDebouncedWsSearch("");
  };

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    const result = await createMutation.mutate({
      name: newKeyName.trim(),
      permission,
      workspace_scope: allWorkspaces ? "all" : selectedWorkspaceIds,
    });
    if (result) {
      setCreatedKey(result.key);
      resetForm();
      refetch();
    }
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/api-keys/${id}`, { method: "DELETE" });
    if (res.ok || res.status === 204) {
      setDeleteId(null);
      refetch();
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleWorkspace = (wsId: string) => {
    setSelectedWorkspaceIds((prev) =>
      prev.includes(wsId) ? prev.filter((id) => id !== wsId) : [...prev, wsId],
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-16">
      <PageHeader
        title="API Keys"
        docsHref="https://docs.relayapi.dev/api-reference/api-keys"
        action={
          <Button
            size="sm"
            onClick={() => { setShowCreate(true); setCreatedKey(null); resetForm(); }}
          >
            <Plus className="size-4" />
            Create API Key
          </Button>
        }
      />

      {error && (
        <div className="rounded-[12px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <motion.div
          className="rounded-[12px] border border-border bg-card p-5 space-y-4"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
        >
          {createdKey ? (
            <div className="space-y-3">
              <p className="text-sm font-medium text-success">API key created successfully</p>
              <p className="text-xs text-muted-foreground">
                Copy this key now. It won't be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-xs font-mono break-all">
                  {createdKey}
                </code>
                <button
                  type="button"
                  onClick={() => handleCopy(createdKey, "new")}
                  className="rounded-md p-2 hover:bg-accent transition-colors shrink-0"
                >
                  {copiedId === "new" ? (
                    <Check className="size-4 text-success" />
                  ) : (
                    <Copy className="size-4 text-muted-foreground" />
                  )}
                </button>
              </div>
              <Button size="sm" variant="outline" onClick={() => setShowCreate(false)}>
                Done
              </Button>
            </div>
          ) : (
            <>
              {/* Key Name */}
              <div className="space-y-1.5">
                <label
                  htmlFor="api-key-name"
                  className="text-xs font-medium text-muted-foreground"
                >
                  Key name
                </label>
                <input
                  id="api-key-name"
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g. Production, Development"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              {/* Permission */}
              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-muted-foreground">Permission</span>
                <div className="flex gap-0 w-fit rounded-md border border-border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setPermission("read_write")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium transition-colors",
                      permission === "read_write"
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:bg-accent",
                    )}
                  >
                    Read & Write
                  </button>
                  <button
                    type="button"
                    onClick={() => setPermission("read_only")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium transition-colors border-l border-border",
                      permission === "read_only"
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:bg-accent",
                    )}
                  >
                    Read Only
                  </button>
                </div>
              </div>

              {/* Workspace Access */}
              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-muted-foreground">Workspace Access</span>
                {/* biome-ignore lint/a11y/noLabelWithoutControl: label wraps the Radix Checkbox control, which Biome cannot detect */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={allWorkspaces}
                    onCheckedChange={(checked) => {
                      setAllWorkspaces(!!checked);
                      if (checked) setSelectedWorkspaceIds([]);
                    }}
                  />
                  <span className="text-sm">Full access (all workspaces)</span>
                </label>

                {!allWorkspaces && (
                  <div className="mt-2 rounded-md border border-border overflow-hidden">
                    <div className="px-3 py-2 border-b border-border">
                      <div className="flex items-center gap-2">
                        <Search className="size-3.5 text-muted-foreground" />
                        <input
                          type="text"
                          value={workspaceSearch}
                          onChange={(e) => setWorkspaceSearch(e.target.value)}
                          placeholder="Search workspaces..."
                          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                        />
                      </div>
                    </div>
                    <div className="max-h-40 overflow-y-auto">
                      {workspacesLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : filteredWorkspaces.length === 0 ? (
                        <p className="text-xs text-muted-foreground px-3 py-3">
                          No workspaces found
                        </p>
                      ) : (
                        <>
                          {filteredWorkspaces.map((ws) => (
                            // biome-ignore lint/a11y/noLabelWithoutControl: label wraps the Radix Checkbox control, which Biome cannot detect
                            <label
                              key={ws.id}
                              className="flex items-center gap-2 px-3 py-2 hover:bg-accent transition-colors cursor-pointer"
                            >
                              <Checkbox
                                checked={selectedWorkspaceIds.includes(ws.id)}
                                onCheckedChange={() => toggleWorkspace(ws.id)}
                              />
                              <span className="text-sm">{ws.name}</span>
                            </label>
                          ))}
                          {wsLoadingMore && (
                            <div className="flex items-center justify-center py-2">
                              <Loader2 className="size-4 animate-spin text-muted-foreground" />
                            </div>
                          )}
                          {wsHasMore && !wsLoadingMore && (
                            <button
                              type="button"
                              onClick={wsLoadMore}
                              className="w-full py-2 text-[11px] text-foreground hover:bg-accent transition-colors"
                            >
                              Load more workspaces
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    {selectedWorkspaceIds.length > 0 && (
                      <div className="px-3 py-1.5 border-t border-border text-xs text-muted-foreground">
                        {selectedWorkspaceIds.length} workspace{selectedWorkspaceIds.length !== 1 ? "s" : ""} selected
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={
                    !newKeyName.trim() ||
                    createMutation.loading ||
                    (!allWorkspaces && selectedWorkspaceIds.length === 0)
                  }
                  onClick={handleCreate}
                >
                  {createMutation.loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    "Create"
                  )}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
              </div>
              {createMutation.error && (
                <p className="text-xs text-destructive">{createMutation.error}</p>
              )}
            </>
          )}
        </motion.div>
      )}

      {/* Delete Confirmation */}
      {deleteId && (
        <motion.div
          className="rounded-[12px] border border-destructive/30 bg-destructive/5 p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <p className="text-sm">Are you sure you want to delete this API key?</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => handleDelete(deleteId)}
            >
              Delete
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
          </div>
        </motion.div>
      )}

      {keys.length === 0 ? (
        <div className="rounded-[12px] border border-dashed border-border p-12 text-center">
          <Shield className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No API keys yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Create your first API key to get started
          </p>
        </div>
      ) : (
        <motion.div
          className="rounded-[12px] border border-border bg-card overflow-hidden"
          variants={stagger}
          initial="hidden"
          animate="visible"
        >
          <div className="hidden md:grid grid-cols-[1.2fr_1.5fr_0.8fr_1fr_1fr_auto] gap-4 px-4 py-3 text-xs text-muted-foreground border-b border-border bg-muted">
            <span>Name</span>
            <span>Key</span>
            <span>Type</span>
            <span>Scope</span>
            <span>Created</span>
            <span></span>
          </div>
          {keys.map((key, i) => {
            const isLive = key.prefix === "rlay_live_" || key.start?.startsWith("rlay_liv");
            const isReadOnly = key.permission === "read_only";
            const wsScope = key.workspace_scope;
            const scopeLabel = wsScope === "all"
              ? "All workspaces"
              : `${Array.isArray(wsScope) ? wsScope.length : 0} workspace${Array.isArray(wsScope) && wsScope.length !== 1 ? "s" : ""}`;
            return (
              <motion.div
                key={key.id}
                variants={fadeUp}
                className={cn(
                  "grid md:grid-cols-[1.2fr_1.5fr_0.8fr_1fr_1fr_auto] gap-3 md:gap-4 p-4 items-center hover:bg-accent transition-colors",
                  i !== keys.length - 1 && "border-b border-border"
                )}
              >
                <div className="flex items-center gap-2">
                  <Shield className="size-4 text-muted-foreground shrink-0" />
                  <span className="text-[13px] font-medium">{key.name || "Unnamed"}</span>
                </div>
                <code className="text-xs text-muted-foreground font-mono border border-border bg-muted rounded px-2 py-1 w-fit">
                  {key.start}••••••••
                </code>
                <span
                  className={cn(
                    "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                    isLive
                      ? "text-success bg-success/10"
                      : "text-muted-foreground bg-muted"
                  )}
                >
                  {isLive ? "Production" : "Test"}
                </span>
                <div className="flex flex-col gap-0.5">
                  <span
                    className={cn(
                      "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                      isReadOnly
                        ? "text-muted-foreground bg-muted"
                        : "text-foreground bg-accent",
                    )}
                  >
                    {isReadOnly ? "Read Only" : "Read & Write"}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{scopeLabel}</span>
                </div>
                <span className="text-[13px] text-muted-foreground">
                  {new Date(key.created_at).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
                <button
                  type="button"
                  className="rounded-md p-1.5 hover:bg-destructive/10 transition-colors justify-self-end group"
                  onClick={() => setDeleteId(key.id)}
                  title="Delete key"
                >
                  <Trash2 className="size-4 text-muted-foreground group-hover:text-destructive" />
                </button>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      <LoadMore
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={loadMore}
        count={keys.length}
      />

      <motion.div
        className="rounded-[12px] border border-dashed border-border p-5"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, delay: 0.15, ease: [0.32, 0.72, 0, 1] }}
      >
        <div className="flex items-start gap-3">
          <Shield className="size-4 text-muted-foreground shrink-0 mt-0.5" />
          <div>
            <h3 className="text-[13px] font-medium">API Key Security</h3>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed max-w-lg">
              Keep your keys secure. Never share them in publicly accessible areas such as GitHub or
              client-side code.
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
