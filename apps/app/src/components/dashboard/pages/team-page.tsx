import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Plus, MoreHorizontal, Mail, Loader2, Clock, X, Send, UserMinus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { organization, useSession } from "@/lib/auth-client";

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.04 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 6 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.15, ease: [0.32, 0.72, 0, 1] as const } },
};

interface Member {
  id: string;
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  };
  role: string;
  createdAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

const roleColors: Record<string, string> = {
  owner: "text-primary bg-primary/10",
  admin: "text-violet-400 bg-violet-400/10",
  editor: "text-emerald-400 bg-emerald-400/10",
  member: "text-muted-foreground bg-accent/50",
  viewer: "text-muted-foreground bg-accent/50",
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const avatarColors = [
  "bg-primary",
  "bg-violet-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-pink-600",
  "bg-blue-600",
];

export function TeamPage() {
  const { data: session } = useSession();
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [updatingRoleId, setUpdatingRoleId] = useState<string | null>(null);

  const fetchMembers = async () => {
    try {
      const result = await organization.listMembers();
      const raw = result.data;
      const list = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.members) ? (raw as any).members : [];
      setMembers(list as unknown as Member[]);
    } catch (e) {
      setError("Failed to load members");
    }
  };

  const fetchInvitations = async () => {
    try {
      const result = await organization.listInvitations();
      const raw = result.data;
      const list = Array.isArray(raw) ? raw : [];
      setInvitations((list as unknown as Invitation[]).filter((inv) => inv.status === "pending"));
    } catch {
      // Non-critical — invitations may not be available
    }
  };

  const fetchAll = async () => {
    setLoading(true);
    await Promise.all([fetchMembers(), fetchInvitations()]);
    setLoading(false);
  };

  useEffect(() => {
    fetchAll();
  }, []);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      await organization.inviteMember({
        email: inviteEmail.trim(),
        role: inviteRole as "admin" | "member",
      });
      setShowInvite(false);
      setInviteEmail("");
      fetchAll();
    } catch {
      setError("Failed to invite member");
    } finally {
      setInviting(false);
    }
  };

  const handleCancelInvitation = async (invitationId: string) => {
    setCancellingId(invitationId);
    try {
      await organization.cancelInvitation({ invitationId });
      setInvitations((prev) => prev.filter((inv) => inv.id !== invitationId));
    } catch {
      setError("Failed to cancel invitation");
    } finally {
      setCancellingId(null);
    }
  };

  const handleResendInvitation = async (invitationId: string) => {
    setResendingId(invitationId);
    setSuccess(null);
    try {
      const res = await fetch(`/api/invitations/${invitationId}/resend`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to resend");
      }
      const inv = invitations.find((i) => i.id === invitationId);
      setSuccess(`Invitation email resent to ${inv?.email ?? "recipient"}`);
    } catch (e: any) {
      setError(e.message || "Failed to resend invitation");
    } finally {
      setResendingId(null);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    setRemovingMemberId(memberId);
    try {
      await organization.removeMember({ memberIdOrEmail: memberId });
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
    } catch {
      setError("Failed to remove member");
    } finally {
      setRemovingMemberId(null);
    }
  };

  const handleUpdateRole = async (memberId: string, role: string) => {
    setUpdatingRoleId(memberId);
    try {
      await organization.updateMemberRole({ memberId, role: role as "admin" | "member" });
      setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, role } : m)));
    } catch {
      setError("Failed to update role");
    } finally {
      setUpdatingRoleId(null);
    }
  };

  const currentUserRole = members.find((m) => m.user.id === session?.user?.id)?.role;
  const canManageMembers = currentUserRole === "owner" || currentUserRole === "admin";

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
        <h1 className="text-lg font-medium">Team</h1>
        {canManageMembers && (
          <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setShowInvite(true)}>
            <Plus className="size-3.5" />
            Invite Member
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
          {success}
        </div>
      )}

      {showInvite && (
        <motion.div
          className="rounded-md border border-border p-4 space-y-3"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Email address</label>
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Role</label>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={!inviteEmail.trim() || inviting}
              onClick={handleInvite}
            >
              {inviting ? <Loader2 className="size-3 animate-spin" /> : "Send Invite"}
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowInvite(false)}>
              Cancel
            </Button>
          </div>
        </motion.div>
      )}

      <motion.div
        className="rounded-md border border-border overflow-hidden"
        variants={stagger}
        initial="hidden"
        animate="visible"
      >
        <div className="hidden md:grid grid-cols-[2fr_1fr_1fr_auto] gap-4 px-4 py-3 text-xs font-medium text-muted-foreground border-b border-border bg-accent/10">
          <span>Member</span>
          <span>Role</span>
          <span>Joined</span>
          <span></span>
        </div>
        {members.map((member, i) => {
          const user = member.user;
          const colorIdx = i % avatarColors.length;
          return (
            <motion.div
              key={member.id}
              variants={fadeUp}
              className={cn(
                "grid md:grid-cols-[2fr_1fr_1fr_auto] gap-3 md:gap-4 p-4 items-center hover:bg-accent/30 transition-colors",
                (i !== members.length - 1 || invitations.length > 0) && "border-b border-border"
              )}
            >
              <div className="flex items-center gap-3">
                <div
                  className={cn(
                    "flex size-9 items-center justify-center rounded-full text-xs font-semibold text-white",
                    avatarColors[colorIdx]
                  )}
                >
                  {user.image ? (
                    <img src={user.image} alt="" className="size-9 rounded-full object-cover" />
                  ) : (
                    getInitials(user.name || user.email)
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium">{user.name || "Unnamed"}</p>
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                </div>
              </div>
              <span
                className={cn(
                  "inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize",
                  roleColors[member.role] || roleColors.member
                )}
              >
                {member.role}
              </span>
              <span className="text-sm text-muted-foreground">
                {new Date(member.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <div className="flex items-center gap-1 justify-self-end">
                <a
                  href={`mailto:${user.email}`}
                  className="rounded-lg p-1.5 hover:bg-accent/50 transition-colors"
                  title={`Email ${user.email}`}
                >
                  <Mail className="size-4 text-muted-foreground" />
                </a>
                {member.role !== "owner" && canManageMembers && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="rounded-lg p-1.5 hover:bg-accent/50 transition-colors">
                        {(removingMemberId === member.id || updatingRoleId === member.id) ? (
                          <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : (
                          <MoreHorizontal className="size-4 text-muted-foreground" />
                        )}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => handleUpdateRole(member.id, member.role === "admin" ? "member" : "admin")}
                      >
                        <RefreshCw className="size-4" />
                        {member.role === "admin" ? "Change to Member" : "Change to Admin"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => handleRemoveMember(member.id)}
                      >
                        <UserMinus className="size-4" />
                        Remove Member
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </motion.div>
          );
        })}
      </motion.div>

      {canManageMembers && invitations.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-muted-foreground">Pending Invitations</h2>
          </div>
          <motion.div
            className="rounded-md border border-dashed border-border overflow-hidden"
            variants={stagger}
            initial="hidden"
            animate="visible"
          >
            {invitations.map((inv, i) => (
              <motion.div
                key={inv.id}
                variants={fadeUp}
                className={cn(
                  "grid md:grid-cols-[2fr_1fr_1fr_auto] gap-3 md:gap-4 p-4 items-center",
                  i !== invitations.length - 1 && "border-b border-border"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="flex size-9 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                    <Mail className="size-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">{inv.email}</p>
                    <p className="text-xs text-muted-foreground/60">Invitation pending</p>
                  </div>
                </div>
                <span
                  className={cn(
                    "inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize",
                    roleColors[inv.role] || roleColors.member
                  )}
                >
                  {inv.role}
                </span>
                <span className="text-xs text-muted-foreground">
                  Sent{" "}
                  {new Date(inv.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
                <div className="flex items-center gap-1 justify-self-end">
                  <button
                    onClick={() => handleResendInvitation(inv.id)}
                    disabled={resendingId === inv.id}
                    className="rounded-lg p-1.5 hover:bg-accent/50 transition-colors text-muted-foreground disabled:opacity-50"
                    title="Resend invitation"
                  >
                    {resendingId === inv.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                  </button>
                  <button
                    onClick={() => handleCancelInvitation(inv.id)}
                    disabled={cancellingId === inv.id}
                    className="rounded-lg p-1.5 hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive disabled:opacity-50"
                    title="Cancel invitation"
                  >
                    {cancellingId === inv.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <X className="size-4" />
                    )}
                  </button>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      )}
    </div>
  );
}
