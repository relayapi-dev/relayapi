import { useState, useEffect, useMemo } from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowUpDown,
  Check,
  Loader2,
  MoreHorizontal,
  Pencil,
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

const planTiers = [
  {
    name: "Free",
    price: "$0/mo",
    features: [
      "200 API calls/month (hard limit)",
      "All 21 platforms",
      "Unlimited profiles",
      "Media uploads",
      "Webhooks",
      "10 req/min rate limit",
    ],
  },
  {
    name: "Pro",
    price: "$5/mo",
    features: [
      "10,000 API calls included",
      "$1 per 1,000 extra calls",
      "All 21 platforms",
      "Unlimited profiles",
      "Comments API",
      "Analytics API",
      "1,000 req/min rate limit",
    ],
  },
];

interface Subscription {
  id: string;
  organizationId: string;
  orgName: string | null;
  orgSlug: string | null;
  status: string;
  monthlyPriceCents: number;
  postsIncluded: number;
  pricePerPostCents: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  createdAt: string;
  apiCallsUsed: number;
  apiCallsIncluded: number;
  overageCalls: number;
  overageCostCents: number;
}

const statusColors: Record<string, string> = {
  active: "text-emerald-400 bg-emerald-400/10",
  trialing: "text-amber-400 bg-amber-400/10",
  past_due: "text-red-400 bg-red-400/10",
  cancelled: "text-muted-foreground bg-accent/50",
};

export function AdminPlansPage() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [editModal, setEditModal] = useState<Subscription | null>(null);
  const [editForm, setEditForm] = useState({
    status: "",
    monthlyPriceCents: 0,
  });
  const [saving, setSaving] = useState(false);

  const fetchSubs = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/admin/subscriptions");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setSubs(data.subscriptions || []);
    } catch {
      setError("Failed to load subscriptions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSubs();
  }, []);

  const openEdit = (sub: Subscription) => {
    setEditModal(sub);
    setEditForm({
      status: sub.status,
      monthlyPriceCents: sub.monthlyPriceCents,
    });
  };

  const saveEdit = async () => {
    if (!editModal) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/subscriptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editModal.id, ...editForm }),
      });
      if (!res.ok) throw new Error("Failed to update");
      setEditModal(null);
      fetchSubs();
    } catch {
      setError("Failed to update subscription");
    } finally {
      setSaving(false);
    }
  };

  const totalOrgs = subs.length;
  const activeCount = subs.filter((s) => s.status === "active").length;
  const totalApiCalls = subs.reduce((sum, s) => sum + s.apiCallsUsed, 0);
  const totalRevenue = subs
    .filter((s) => s.status === "active")
    .reduce((sum, s) => sum + s.monthlyPriceCents, 0);

  const columns: ColumnDef<Subscription>[] = useMemo(
    () => [
      {
        accessorKey: "orgName",
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
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {row.original.orgName || "Unknown"}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {row.original.orgSlug}
            </p>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize",
              statusColors[row.original.status] || statusColors.cancelled
            )}
          >
            {row.original.status}
          </span>
        ),
      },
      {
        accessorKey: "monthlyPriceCents",
        header: "Price",
        cell: ({ row }) => (
          <span className="text-sm">
            ${(row.original.monthlyPriceCents / 100).toFixed(2)}/mo
          </span>
        ),
      },
      {
        accessorKey: "apiCallsUsed",
        header: "API Calls",
        cell: ({ row }) => {
          const sub = row.original;
          return (
            <div className="min-w-24">
              <span className="text-xs text-muted-foreground">
                {sub.apiCallsUsed.toLocaleString()} /{" "}
                {sub.apiCallsIncluded.toLocaleString()}
              </span>
              {sub.overageCalls > 0 && (
                <p className="text-[10px] text-amber-400">
                  +{sub.overageCalls.toLocaleString()} overage ($
                  {(sub.overageCostCents / 100).toFixed(2)})
                </p>
              )}
            </div>
          );
        },
      },
      {
        id: "actions",
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 w-8 p-0">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => openEdit(row.original)}>
                <Pencil className="size-4" />
                Edit subscription
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    []
  );

  const table = useReactTable({
    data: subs,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
    initialState: { pagination: { pageSize: 20 } },
  });

  return (
    <div className="space-y-6">
      <AdminNav current="admin-plans" />

      <h1 className="text-lg font-medium">Plans & Subscriptions</h1>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Plan Tiers */}
      <div>
        <h2 className="text-[13px] font-medium text-muted-foreground mb-3">
          Plan Tiers
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {planTiers.map((plan) => (
            <div
              key={plan.name}
              className="rounded-md border border-border overflow-hidden"
            >
              <div className="px-4 py-3 border-b border-border bg-accent/10 flex items-center justify-between">
                <h3 className="text-[13px] font-medium">{plan.name}</h3>
                <span className="text-sm font-semibold">{plan.price}</span>
              </div>
              <div className="p-4 space-y-2">
                {plan.features.map((f) => (
                  <div
                    key={f}
                    className="flex items-center gap-2 text-[13px] text-muted-foreground"
                  >
                    <Check className="size-3.5 shrink-0 text-primary" />
                    {f}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Overview Stats */}
      <div>
        <h2 className="text-[13px] font-medium text-muted-foreground mb-3">
          Overview
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: "Subscriptions", value: totalOrgs },
            { label: "Active (Pro)", value: activeCount },
            {
              label: "API Calls (period)",
              value: totalApiCalls.toLocaleString(),
            },
            {
              label: "Monthly Revenue",
              value: `$${(totalRevenue / 100).toFixed(2)}`,
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className="rounded-md border border-border p-4"
            >
              <p className="text-xs text-muted-foreground">{stat.label}</p>
              <p className="text-lg font-semibold mt-1">{stat.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Subscriptions Table */}
      <div>
        <h2 className="text-[13px] font-medium text-muted-foreground mb-3">
          All Subscriptions
        </h2>
        {loading ? (
          <div className="flex items-center justify-center py-12">
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
                        No subscriptions found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between mt-4">
              <p className="text-xs text-muted-foreground">
                {table.getRowModel().rows.length} row(s)
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Edit modal */}
      {editModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-6 shadow-lg space-y-4">
            <h3 className="text-sm font-medium">
              Edit Subscription — {editModal.orgName}
            </h3>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Status</label>
                <select
                  value={editForm.status}
                  onChange={(e) =>
                    setEditForm({ ...editForm, status: e.target.value })
                  }
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="trialing">Trialing</option>
                  <option value="active">Active</option>
                  <option value="past_due">Past Due</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">
                  Monthly Price ($)
                </label>
                <input
                  type="number"
                  value={editForm.monthlyPriceCents / 100}
                  onChange={(e) =>
                    setEditForm({
                      ...editForm,
                      monthlyPriceCents: Math.round(
                        parseFloat(e.target.value || "0") * 100
                      ),
                    })
                  }
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  step="0.01"
                  min="0"
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
                disabled={saving}
                onClick={saveEdit}
              >
                {saving ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  "Save Changes"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
