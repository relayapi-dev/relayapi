import { useState, useEffect, useMemo } from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowUpDown,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { AdminNav } from "./admin-nav";

interface AdminOrg {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: string;
  memberCount: number;
  plan: string;
  subscriptionStatus: string | null;
  monthlyPriceCents: number;
  apiCallsUsed: number;
  apiCallsIncluded: number;
  aiEnabled: boolean;
}

const planColors: Record<string, string> = {
  pro: "text-primary bg-primary/10",
  free: "text-muted-foreground bg-accent/50",
};

const orgColors = [
  "bg-indigo-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-cyan-600",
  "bg-violet-600",
];

const PAGE_SIZE = 50;

export function AdminOrganizationsPage() {
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [actionLoading, setActionLoading] = useState(false);
  const [editModal, setEditModal] = useState<AdminOrg | null>(null);
  const [editForm, setEditForm] = useState({ name: "", slug: "" });
  const [confirmDelete, setConfirmDelete] = useState<AdminOrg | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounced(searchQuery);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchOrgs = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (searchDebounced) params.set("search", searchDebounced);
      const res = await fetch(`/api/admin/organizations?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setOrgs(data.organizations || []);
      setTotal(data.total ?? 0);
    } catch {
      setError("Failed to load organizations");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrgs();
  }, [page, searchDebounced]);

  const handleToggleAi = async (orgId: string, enabled: boolean) => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/organizations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, aiEnabled: enabled }),
      });
      if (!res.ok) throw new Error("Failed");
      fetchOrgs();
    } catch {
      setError("Failed to toggle AI");
    } finally {
      setActionLoading(false);
    }
  };

  const handleChangePlan = async (orgId: string, plan: "free" | "pro") => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/organizations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId, plan }),
      });
      if (!res.ok) throw new Error("Failed");
      fetchOrgs();
    } catch {
      setError("Failed to change plan");
    } finally {
      setActionLoading(false);
    }
  };

  const openEdit = (org: AdminOrg) => {
    setEditModal(org);
    setEditForm({ name: org.name, slug: org.slug });
  };

  const saveEdit = async () => {
    if (!editModal) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/organizations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: editModal.id,
          name: editForm.name,
          slug: editForm.slug,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      setEditModal(null);
      fetchOrgs();
    } catch {
      setError("Failed to update organization");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async (orgId: string) => {
    setActionLoading(true);
    try {
      const res = await fetch("/api/admin/organizations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: orgId }),
      });
      if (!res.ok) throw new Error("Failed");
      setConfirmDelete(null);
      fetchOrgs();
    } catch {
      setError("Failed to delete organization");
    } finally {
      setActionLoading(false);
    }
  };

  const columns: ColumnDef<AdminOrg>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-3 h-8 text-xs"
            onClick={() =>
              column.toggleSorting(column.getIsSorted() === "asc")
            }
          >
            Organization
            <ArrowUpDown className="ml-1.5 size-3" />
          </Button>
        ),
        cell: ({ row }) => {
          const org = row.original;
          const idx = orgs.findIndex((o) => o.id === org.id) % orgColors.length;
          return (
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "flex size-8 items-center justify-center rounded text-[10px] font-bold text-white shrink-0",
                  orgColors[idx]
                )}
              >
                {org.logo ? (
                  <img
                    src={org.logo}
                    alt=""
                    className="size-8 rounded object-cover"
                  />
                ) : (
                  org.name.charAt(0).toUpperCase()
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{org.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {org.slug}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "memberCount",
        header: "Members",
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Users className="size-3.5" />
            {row.original.memberCount}
          </div>
        ),
      },
      {
        accessorKey: "plan",
        header: "Plan",
        cell: ({ row }) => (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize",
              planColors[row.original.plan] || planColors.free
            )}
          >
            {row.original.plan}
          </span>
        ),
      },
      {
        accessorKey: "aiEnabled",
        header: "AI",
        cell: ({ row }) => (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium",
              row.original.aiEnabled
                ? "text-emerald-700 bg-emerald-100"
                : "text-muted-foreground bg-accent/50"
            )}
          >
            {row.original.aiEnabled ? "Enabled" : "Off"}
          </span>
        ),
      },
      {
        accessorKey: "apiCallsUsed",
        header: "API Calls",
        cell: ({ row }) => {
          const org = row.original;
          const pct =
            org.apiCallsIncluded > 0
              ? Math.round((org.apiCallsUsed / org.apiCallsIncluded) * 100)
              : 0;
          return (
            <div className="space-y-1 min-w-24">
              <span className="text-xs text-muted-foreground">
                {org.apiCallsUsed.toLocaleString()} /{" "}
                {org.apiCallsIncluded.toLocaleString()}
              </span>
              <div className="h-1 rounded-full bg-accent/40 overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    pct > 95
                      ? "bg-red-400"
                      : pct > 80
                        ? "bg-amber-400"
                        : "bg-primary"
                  )}
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-3 h-8 text-xs"
            onClick={() =>
              column.toggleSorting(column.getIsSorted() === "asc")
            }
          >
            Created
            <ArrowUpDown className="ml-1.5 size-3" />
          </Button>
        ),
        cell: ({ row }) =>
          new Date(row.original.createdAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          }),
      },
      {
        id: "actions",
        cell: ({ row }) => {
          const org = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {org.plan === "free" ? (
                  <DropdownMenuItem
                    onClick={() => handleChangePlan(org.id, "pro")}
                    disabled={actionLoading}
                  >
                    <Zap className="size-4" />
                    Upgrade to Pro
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => handleChangePlan(org.id, "free")}
                    disabled={actionLoading}
                  >
                    <Zap className="size-4" />
                    Downgrade to Free
                  </DropdownMenuItem>
                )}
                {org.aiEnabled ? (
                  <DropdownMenuItem
                    onClick={() => handleToggleAi(org.id, false)}
                    disabled={actionLoading}
                  >
                    <Zap className="size-4" />
                    Disable AI
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => handleToggleAi(org.id, true)}
                    disabled={actionLoading}
                  >
                    <Zap className="size-4" />
                    Enable AI
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => openEdit(org)}>
                  <Pencil className="size-4" />
                  Edit organization
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setConfirmDelete(org)}
                  disabled={actionLoading}
                >
                  <Trash2 className="size-4" />
                  Delete organization
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [orgs, actionLoading]
  );

  const table = useReactTable({
    data: orgs,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
    manualPagination: true,
    pageCount: Math.ceil(total / PAGE_SIZE),
  });

  return (
    <div className="space-y-6">
      <AdminNav current="admin-organizations" />

      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-medium">Organizations</h1>
        <span className="text-xs text-muted-foreground">
          {total} total
        </span>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search organizations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
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
      ) : (
        <>
          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext()
                            )}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows?.length ? (
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext()
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={columns.length}
                      className="h-24 text-center"
                    >
                      No organizations found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {total === 0 ? "No results" : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setPage((p) => p + 1)}
                disabled={(page + 1) * PAGE_SIZE >= total}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Edit modal */}
      {editModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg space-y-4">
            <h3 className="text-sm font-medium">Edit Organization</h3>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Name</label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={(e) =>
                    setEditForm({ ...editForm, name: e.target.value })
                  }
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Slug</label>
                <input
                  type="text"
                  value={editForm.slug}
                  onChange={(e) =>
                    setEditForm({ ...editForm, slug: e.target.value })
                  }
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setEditModal(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={actionLoading || !editForm.name.trim()}
                onClick={saveEdit}
              >
                {actionLoading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg space-y-4">
            <h3 className="text-sm font-medium">Delete Organization</h3>
            <p className="text-sm text-muted-foreground">
              This will permanently delete <strong>{confirmDelete.name}</strong>{" "}
              and all its members and subscriptions. This action cannot be
              undone.
            </p>
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                disabled={actionLoading}
                onClick={() => handleDelete(confirmDelete.id)}
              >
                {actionLoading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  "Delete"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
