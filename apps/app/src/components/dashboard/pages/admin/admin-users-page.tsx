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
  Search,
  ShieldCheck,
  Ban,
  Trash2,
  UserCog,
  LogIn,
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
import { authClient } from "@/lib/auth-client";
import { PageHeader } from "@/components/dashboard/page-header";
import { AdminNav } from "./admin-nav";

interface AdminUser {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string | null;
  banned: boolean | null;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
}

const roleColors: Record<string, string> = {
  admin: "text-foreground bg-muted border border-border",
  user: "text-muted-foreground bg-muted",
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [banModal, setBanModal] = useState<string | null>(null);
  const [banReason, setBanReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const pageSize = 20;

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPageIndex(0); // Reset to first page on search
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      setError(null);
      const query: Record<string, string | number> = {
        limit: pageSize,
        offset: pageIndex * pageSize,
        sortBy: "createdAt",
        sortDirection: "desc",
      };
      if (debouncedSearch) {
        query.searchValue = debouncedSearch;
        query.searchField = "name";
        query.searchOperator = "contains";
      }
      const result = await authClient.admin.listUsers({ query });
      if (result.data) {
        const data = result.data as unknown as { users?: AdminUser[]; total?: number };
        setUsers(data.users || []);
        setTotal(data.total || 0);
      }
    } catch {
      setError("Failed to load users");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [pageIndex, debouncedSearch]);

  const handleSetRole = async (userId: string, role: "user" | "admin") => {
    setActionLoading(true);
    try {
      await authClient.admin.setRole({ userId, role });
      fetchUsers();
    } catch {
      setError("Failed to update role");
    } finally {
      setActionLoading(false);
    }
  };

  const handleBan = async (userId: string) => {
    setActionLoading(true);
    try {
      await authClient.admin.banUser({
        userId,
        banReason: banReason || undefined,
      });
      setBanModal(null);
      setBanReason("");
      fetchUsers();
    } catch {
      setError("Failed to ban user");
    } finally {
      setActionLoading(false);
    }
  };

  const handleUnban = async (userId: string) => {
    setActionLoading(true);
    try {
      await authClient.admin.unbanUser({ userId });
      fetchUsers();
    } catch {
      setError("Failed to unban user");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async (userId: string) => {
    setActionLoading(true);
    try {
      await authClient.admin.removeUser({ userId });
      setConfirmDelete(null);
      fetchUsers();
    } catch {
      setError("Failed to delete user");
    } finally {
      setActionLoading(false);
    }
  };

  const handleImpersonate = async (userId: string) => {
    setActionLoading(true);
    try {
      const result = await authClient.admin.impersonateUser({ userId });
      if (result.error) {
        setError(result.error.message || "Failed to impersonate user");
        setActionLoading(false);
        return;
      }
      // Full reload to pick up the new impersonated session
      window.location.href = "/app";
    } catch {
      setError("Failed to impersonate user");
      setActionLoading(false);
    }
  };

  const columns: ColumnDef<AdminUser>[] = useMemo(
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
            User
            <ArrowUpDown className="ml-1.5 size-3" />
          </Button>
        ),
        cell: ({ row }) => {
          const u = row.original;
          return (
            <div className="flex items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                {u.image ? (
                  <img
                    src={u.image}
                    alt=""
                    className="size-8 rounded-full object-cover"
                  />
                ) : (
                  getInitials(u.name || u.email)
                )}
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-medium truncate">
                  {u.name || "Unnamed"}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {u.email}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "role",
        header: "Role",
        cell: ({ row }) => {
          const role = row.original.role || "user";
          return (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize",
                roleColors[role] || roleColors.user
              )}
            >
              {role}
            </span>
          );
        },
      },
      {
        accessorKey: "banned",
        header: "Status",
        cell: ({ row }) =>
          row.original.banned ? (
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium text-destructive bg-destructive/10">
              Banned
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium text-success bg-success/10">
              Active
            </span>
          ),
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
          const u = row.original;
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
                {u.role === "admin" ? (
                  <DropdownMenuItem
                    onClick={() => handleSetRole(u.id, "user")}
                    disabled={actionLoading}
                  >
                    <UserCog className="size-4" />
                    Remove admin
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => handleSetRole(u.id, "admin")}
                    disabled={actionLoading}
                  >
                    <ShieldCheck className="size-4" />
                    Make admin
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => handleImpersonate(u.id)}
                  disabled={actionLoading}
                >
                  <LogIn className="size-4" />
                  Impersonate
                </DropdownMenuItem>
                {u.banned ? (
                  <DropdownMenuItem
                    onClick={() => handleUnban(u.id)}
                    disabled={actionLoading}
                  >
                    <Ban className="size-4" />
                    Unban
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    onClick={() => setBanModal(u.id)}
                    disabled={actionLoading}
                  >
                    <Ban className="size-4" />
                    Ban user
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setConfirmDelete(u.id)}
                  disabled={actionLoading}
                >
                  <Trash2 className="size-4" />
                  Delete user
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [users, actionLoading]
  );

  const table = useReactTable({
    data: users,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    manualPagination: true,
    pageCount: Math.ceil(total / pageSize),
    onSortingChange: setSorting,
    onPaginationChange: (updater) => {
      const newState =
        typeof updater === "function"
          ? updater({ pageIndex, pageSize })
          : updater;
      setPageIndex(newState.pageIndex);
    },
    state: {
      sorting,
      pagination: { pageIndex, pageSize },
    },
  });

  return (
    <div className="space-y-5 pb-16">
      <PageHeader title="Users" subtitle={`${total} total`} />

      <AdminNav current="admin-users" />

      {/* Search */}
      <div className="relative max-w-xs">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search users..."
          className="w-full rounded-[10px] border border-border bg-card pl-9 pr-3 py-2 text-[13px] outline-none transition-colors focus:border-foreground/20 focus:ring-2 focus:ring-ring/20 placeholder:text-muted-foreground"
        />
      </div>

      {error && (
        <div className="rounded-[12px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center rounded-[12px] border border-border py-20">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
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
                      className="h-24 text-center text-[13px] text-muted-foreground"
                    >
                      No users found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Page {pageIndex + 1} of {Math.max(1, Math.ceil(total / pageSize))}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                disabled={pageIndex === 0}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setPageIndex((p) => p + 1)}
                disabled={pageIndex >= Math.ceil(total / pageSize) - 1}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Ban modal */}
      {banModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-[12px] border border-border bg-card p-6 space-y-4">
            <h3 className="text-sm font-medium">Ban User</h3>
            <div className="space-y-1.5">
              <label
                htmlFor="admin-user-ban-reason"
                className="text-xs text-muted-foreground"
              >
                Reason (optional)
              </label>
              <input
                id="admin-user-ban-reason"
                type="text"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Spamming, abuse, etc."
                className="w-full rounded-[10px] border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-foreground/20 focus:ring-2 focus:ring-ring/20"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setBanModal(null);
                  setBanReason("");
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={actionLoading}
                onClick={() => handleBan(banModal)}
              >
                {actionLoading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  "Ban User"
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
            <h3 className="text-sm font-medium">Delete User</h3>
            <p className="text-sm text-muted-foreground">
              This will permanently delete this user and all their data. This
              action cannot be undone.
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
                onClick={() => handleDelete(confirmDelete)}
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
