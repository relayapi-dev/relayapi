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
import { PageHeader } from "@/components/dashboard/page-header";
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
  pro: "text-foreground bg-muted border border-border",
  free: "text-muted-foreground bg-muted",
};

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
          return (
            <div className="flex items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-muted text-[10px] font-bold text-muted-foreground">
                {org.logo ? (
                  <img
                    src={org.logo}
                    alt=""
                    className="size-8 rounded-[8px] object-cover"
                  />
                ) : (
                  org.name.charAt(0).toUpperCase()
                )}
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium truncate">{org.name}</p>
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
          <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
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
                ? "text-success bg-success/10"
                : "text-muted-foreground bg-muted"
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
              <div className="h-1 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    pct > 95
                      ? "bg-destructive"
                      : pct > 80
                        ? "bg-chart-3"
                        : "bg-foreground"
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
        cell: ({ row }) => (
          <span className="text-[13px] text-muted-foreground">
            {new Date(row.original.createdAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        ),
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
    <div className="space-y-5 pb-16">
      <PageHeader
        title="Organizations"
        subtitle={
          loading ? (
            <span className="inline-block h-3.5 w-16 animate-pulse rounded bg-muted align-middle" />
          ) : (
            `${total} total`
          )
        }
      />

      <AdminNav current="admin-organizations" />

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search organizations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded-[10px] border border-border bg-card pl-9 pr-3 py-2 text-[13px] outline-none transition-colors focus:border-foreground/20 focus:ring-2 focus:ring-ring/20 placeholder:text-muted-foreground"
        />
      </div>

      {error && (
        <div className="rounded-[12px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Render the table shell (and pagination) in every state so the layout
          height stays constant from load → loaded: a tiny spinner that expands
          into a full table is what made the count/header jump on load. */}
      <div className="overflow-hidden rounded-[12px] border border-border bg-card">
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
            {loading ? (
              Array.from({ length: 10 }, (_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="size-8 shrink-0 animate-pulse rounded-[8px] bg-muted" />
                      <div className="space-y-1.5">
                        <div className="h-3 w-32 animate-pulse rounded bg-muted" />
                        <div className="h-2.5 w-20 animate-pulse rounded bg-muted" />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="h-3 w-10 animate-pulse rounded bg-muted" />
                  </TableCell>
                  <TableCell>
                    <div className="h-5 w-12 animate-pulse rounded-full bg-muted" />
                  </TableCell>
                  <TableCell>
                    <div className="h-5 w-14 animate-pulse rounded-full bg-muted" />
                  </TableCell>
                  <TableCell>
                    <div className="min-w-24 space-y-1">
                      <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                      <div className="h-1 w-full animate-pulse rounded-full bg-muted" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                  </TableCell>
                  <TableCell>
                    <div className="size-8 animate-pulse rounded bg-muted" />
                  </TableCell>
                </TableRow>
              ))
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-[13px] text-muted-foreground"
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
          {loading
            ? " "
            : total === 0
              ? "No results"
              : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={loading || page === 0}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setPage((p) => p + 1)}
            disabled={loading || (page + 1) * PAGE_SIZE >= total}
          >
            Next
          </Button>
        </div>
      </div>

      {/* Edit modal */}
      {editModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-[12px] border border-border bg-card p-6 space-y-4">
            <h3 className="text-sm font-medium">Edit Organization</h3>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="admin-org-edit-name"
                  className="text-xs text-muted-foreground"
                >
                  Name
                </label>
                <input
                  id="admin-org-edit-name"
                  type="text"
                  value={editForm.name}
                  onChange={(e) =>
                    setEditForm({ ...editForm, name: e.target.value })
                  }
                  className="w-full rounded-[10px] border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-foreground/20 focus:ring-2 focus:ring-ring/20"
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="admin-org-edit-slug"
                  className="text-xs text-muted-foreground"
                >
                  Slug
                </label>
                <input
                  id="admin-org-edit-slug"
                  type="text"
                  value={editForm.slug}
                  onChange={(e) =>
                    setEditForm({ ...editForm, slug: e.target.value })
                  }
                  className="w-full rounded-[10px] border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-foreground/20 focus:ring-2 focus:ring-ring/20"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditModal(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={actionLoading || !editForm.name.trim()}
                onClick={saveEdit}
              >
                {actionLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
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
          <div className="w-full max-w-sm rounded-[12px] border border-border bg-card p-6 space-y-4">
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
                onClick={() => setConfirmDelete(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={actionLoading}
                onClick={() => handleDelete(confirmDelete.id)}
              >
                {actionLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
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
