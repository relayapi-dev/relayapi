import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Plus, MoreHorizontal, Mail, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/ui/user-avatar";
import { cn } from "@/lib/utils";
import { organization } from "@/lib/auth-client";
import { PageHeader } from "@/components/dashboard/page-header";

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
  owner: "text-foreground bg-muted",
  admin: "text-foreground bg-muted",
  editor: "text-success bg-success/10",
  member: "text-muted-foreground bg-muted",
  viewer: "text-muted-foreground bg-muted",
};

const avatarColors = [
  "bg-muted",
  "bg-muted",
  "bg-muted",
  "bg-muted",
  "bg-muted",
  "bg-muted",
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
    } catch (_e) {
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
    <div className="space-y-5 pb-16">
      <PageHeader
        title="Users"
        action={
          <Button size="sm" onClick={() => setShowInvite(true)}>
            <Plus className="size-4" />
            Invite User
          </Button>
        }
      />

      {error && (
        <div className="rounded-[12px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {showInvite && (
        <motion.div
          className="rounded-[12px] border border-border bg-card p-5 space-y-3"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="space-y-1.5">
            <label
              htmlFor="users-invite-email"
              className="text-xs font-medium text-muted-foreground"
            >
              Email address
            </label>
            <input
              id="users-invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="users-invite-role"
              className="text-xs font-medium text-muted-foreground"
            >
              Role
            </label>
            <select
              id="users-invite-role"
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
              disabled={!inviteEmail.trim() || inviting}
              onClick={handleInvite}
            >
              {inviting ? <Loader2 className="size-4 animate-spin" /> : "Send Invite"}
            </Button>
            <Button variant="outline" onClick={() => setShowInvite(false)}>
              Cancel
            </Button>
          </div>
        </motion.div>
      )}

      <motion.div
        className="rounded-[12px] border border-border bg-card overflow-hidden"
        variants={stagger}
        initial="hidden"
        animate="visible"
      >
        <div className="hidden md:grid grid-cols-[2fr_1fr_1fr_auto] gap-4 px-4 py-3 text-xs text-muted-foreground border-b border-border bg-muted">
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
                "grid md:grid-cols-[2fr_1fr_1fr_auto] gap-3 md:gap-4 p-4 items-center hover:bg-accent transition-colors",
                i !== members.length - 1 && "border-b border-border"
              )}
            >
              <div className="flex items-center gap-3">
                <UserAvatar
                  image={user.image}
                  name={user.name}
                  seed={user.id ?? user.email}
                  className="size-9"
                  fallbackBgClassName={avatarColors[colorIdx]}
                />
                <div>
                  <p className="text-[13px] font-medium">{user.name || "Unnamed"}</p>
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
              <span className="text-[13px] text-muted-foreground">
                {new Date(member.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </span>
              <div className="flex items-center gap-1 justify-self-end">
                <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                  <Mail className="size-4" />
                </button>
                <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                  <MoreHorizontal className="size-4" />
                </button>
              </div>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}
