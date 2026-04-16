import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Plus, MoreHorizontal, Mail, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { organization } from "@/lib/auth-client";

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

export function UsersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);

  const fetchMembers = async () => {
    try {
      setLoading(true);
      const result = await organization.listMembers();
      if (result.data) {
        setMembers(result.data as unknown as Member[]);
      }
    } catch (e) {
      setError("Failed to load members");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMembers();
  }, []);

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
      fetchMembers();
    } catch {
      setError("Failed to invite member");
    } finally {
      setInviting(false);
    }
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
        <h1 className="text-lg font-medium">Users</h1>
        <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={() => setShowInvite(true)}>
          <Plus className="size-3.5" />
          Invite User
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
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
        initial={false}
        animate="visible"
      >
        <div className="hidden md:grid grid-cols-[2fr_1fr_1fr_auto] gap-4 px-4 py-3 text-xs font-medium text-muted-foreground border-b border-border bg-accent/10">
          <span>User</span>
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
                i !== members.length - 1 && "border-b border-border"
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
                <button className="rounded-lg p-1.5 hover:bg-accent/50 transition-colors">
                  <Mail className="size-4 text-muted-foreground" />
                </button>
                <button className="rounded-lg p-1.5 hover:bg-accent/50 transition-colors">
                  <MoreHorizontal className="size-4 text-muted-foreground" />
                </button>
              </div>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}
