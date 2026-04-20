import { useState } from "react";
import { motion } from "motion/react";
import { BookOpen, Loader2, MoreHorizontal, Plus, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { usePaginatedApi } from "@/hooks/use-api";
import { LoadMore } from "@/components/ui/load-more";
import { AutomationTemplatePickerDialog } from "@/components/dashboard/automation/template-picker-dialog";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface AutomationTrigger {
  id: string;
  type: string;
  account_id: string | null;
  config: unknown;
  filters: unknown;
  label: string;
  order_index: number;
}

interface AutomationResponse {
  id: string;
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  channel: string;
  triggers: AutomationTrigger[];
  total_enrolled: number;
  total_completed: number;
  created_at: string;
}

function statusBadge(status: AutomationResponse["status"]) {
  const map: Record<string, { label: string; classes: string }> = {
    draft: { label: "Draft", classes: "text-neutral-400 bg-neutral-400/10" },
    active: { label: "Active", classes: "text-emerald-400 bg-emerald-400/10" },
    paused: { label: "Paused", classes: "text-amber-400 bg-amber-400/10" },
    archived: { label: "Archived", classes: "text-neutral-500 bg-neutral-500/10" },
  };
  const cfg = map[status] ?? map.draft!;
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", cfg.classes)}>
      {cfg.label}
    </span>
  );
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function humanTrigger(triggers: AutomationTrigger[]): string {
  if (!triggers || triggers.length === 0) return "—";
  if (triggers.length === 1) return triggers[0]!.type.replace(/_/g, " ");
  return `${triggers.length} triggers`;
}

export function AutomationPage() {
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AutomationResponse | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const {
    data: automations,
    loading,
    error,
    hasMore,
    loadMore,
    loadingMore,
    refetch,
    setData,
  } = usePaginatedApi<AutomationResponse>("automations");

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/automations/${deleteTarget.id}`, { method: "DELETE" });
      if (res.ok || res.status === 204) {
        setData((prev) => prev.filter((a) => a.id !== deleteTarget.id));
        setDeleteTarget(null);
      } else {
        const body = await res.json().catch(() => null);
        setDeleteError(body?.error?.message || body?.message || `Error ${res.status}`);
      }
    } catch {
      setDeleteError("Network connection lost.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-medium">Automation</h1>
          <a
            href="https://docs.relayapi.dev/guides/automations"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <BookOpen className="size-3.5" />
          </a>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 h-7 text-xs"
            onClick={() => {
              window.location.href = "/app/automation/new";
            }}
          >
            From scratch
          </Button>
          <Button
            size="sm"
            className="gap-1.5 h-7 text-xs"
            onClick={() => setTemplateDialogOpen(true)}
          >
            <Plus className="size-3.5" />
            From template
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : automations.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-12 text-center">
          <Workflow className="size-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No automations yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Start from a template or build a flow from scratch
          </p>
          <div className="flex items-center justify-center gap-2 mt-4">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 h-7 text-xs"
              onClick={() => {
                window.location.href = "/app/automation/new";
              }}
            >
              From scratch
            </Button>
            <Button
              size="sm"
              className="gap-1.5 h-7 text-xs"
              onClick={() => setTemplateDialogOpen(true)}
            >
              <Plus className="size-3.5" />
              From template
            </Button>
          </div>
        </div>
      ) : (
        <>
          <motion.div
            className="rounded-md border border-border overflow-hidden"
            variants={stagger}
            initial="hidden"
            animate="visible"
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-accent/10 text-xs font-medium text-muted-foreground">
                  <th className="px-4 py-2.5 text-left">Name</th>
                  <th className="px-4 py-2.5 text-left hidden md:table-cell">Channel</th>
                  <th className="px-4 py-2.5 text-left hidden lg:table-cell">Trigger</th>
                  <th className="px-4 py-2.5 text-left">Status</th>
                  <th className="px-4 py-2.5 text-right hidden md:table-cell">Enrolled</th>
                  <th className="px-4 py-2.5 text-right hidden md:table-cell">Completed</th>
                  <th className="px-4 py-2.5 text-right hidden sm:table-cell">Created</th>
                  <th className="px-4 py-2.5 w-8" />
                </tr>
              </thead>
              <tbody>
                {automations.map((a, i) => (
                  <motion.tr
                    key={a.id}
                    variants={fadeUp}
                    onClick={() => {
                      window.location.href = `/app/automation/${a.id}`;
                    }}
                    className={cn(
                      "cursor-pointer hover:bg-accent/30 transition-colors",
                      i !== automations.length - 1 && "border-b border-border",
                    )}
                  >
                    <td className="px-4 py-3 text-[13px] font-medium">{a.name}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground hidden md:table-cell capitalize">
                      {a.channel}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground hidden lg:table-cell">
                      {humanTrigger(a.triggers)}
                    </td>
                    <td className="px-4 py-3">{statusBadge(a.status)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden md:table-cell">
                      {a.total_enrolled}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden md:table-cell">
                      {a.total_completed}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground text-right hidden sm:table-cell">
                      {formatDate(a.created_at)}
                    </td>
                    <td
                      className="px-2 py-3 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className="rounded-md p-1.5 hover:bg-accent/50 transition-colors"
                            aria-label="Automation actions"
                          >
                            <MoreHorizontal className="size-4 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-36">
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => {
                              setDeleteError(null);
                              setDeleteTarget(a);
                            }}
                          >
                            <Trash2 className="size-3.5 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </motion.div>
          <LoadMore
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={loadMore}
            count={automations.length}
          />
        </>
      )}

      <AutomationTemplatePickerDialog
        open={templateDialogOpen}
        onOpenChange={setTemplateDialogOpen}
        onCreated={refetch}
      />

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Delete automation</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.name || "this automation"}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-sm text-destructive">{deleteError}</p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              onClick={handleDelete}
            >
              {deleting ? <Loader2 className="size-3.5 animate-spin" /> : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
