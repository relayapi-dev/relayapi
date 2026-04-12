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
  admin: "text-violet-400 bg-violet-400/10",
  user: "text-muted-foreground bg-accent/50",
};

const avatarColors = [
  "bg-primary",
  "bg-violet-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-pink-600",
  "bg-blue-600",
];

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
      const query: Record<string, any> = {
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
        setUsers((result.data as any).users || []);
        setTotal((result.data as any).total || 0);
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
          const idx =
            users.findIndex((x) => x.id === u.id) % avatarColors.length;
          return (
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "flex size-8 items-center justify-center rounded-full text-[10px] font-semibold text-white shrink-0",
                  avatarColors[idx]
                )}
              >
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
                <p className="text-sm font-medium truncate">
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
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium text-red-400 bg-red-400/10">
              Banned
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium text-emerald-400 bg-emerald-400/10">
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
    <div className="space-y-6">
      <AdminNav current="admin-users" />

      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-medium">Users</h1>
        <span className="text-xs text-muted-foreground">{total} total</span>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search users..."
            className="w-full max-w-xs rounded-md border border-border bg-background pl-9 pr-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
          />
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
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg space-y-4">
            <h3 className="text-sm font-medium">Ban User</h3>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                Reason (optional)
              </label>
              <input
                type="text"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Spamming, abuse, etc."
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                autoFocus
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
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
                className="h-7 text-xs"
                disabled={actionLoading}
                onClick={() => handleBan(banModal)}
              >
                {actionLoading ? (
                  <Loader2 className="size-3 animate-spin" />
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
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg space-y-4">
            <h3 className="text-sm font-medium">Delete User</h3>
            <p className="text-sm text-muted-foreground">
              This will permanently delete this user and all their data. This
              action cannot be undone.
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
                onClick={() => handleDelete(confirmDelete)}
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
