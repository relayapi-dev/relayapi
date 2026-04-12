import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Users, Check, X, Loader2, ArrowRight, Building2 } from "lucide-react";
import { organization, signOut } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  organizationName: string;
  organizationId: string;
  expiresAt: string;
  createdAt: string;
}

interface PendingInvitationsProps {
  userEmail: string;
}

export function PendingInvitations({ userEmail }: PendingInvitationsProps) {
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);

  useEffect(() => {
    fetchInvitations();
  }, []);

  const fetchInvitations = async () => {
    try {
      // Use the Better Auth API directly to list invitations received by the current user.
      // We can't use organization.listInvitations() because it requires an active org membership.
      const res = await fetch("/api/auth/organization/list-user-invitations", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      setInvitations(
        (list as PendingInvitation[]).filter((inv) => inv.status === "pending"),
      );
    } catch {
      setError("Failed to load invitations");
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = async (inv: PendingInvitation) => {
    setAcceptingId(inv.id);
    try {
      const result = await organization.acceptInvitation({
        invitationId: inv.id,
      });
      if (result.error) {
        setError(result.error.message || "Failed to accept invitation");
        setAcceptingId(null);
        return;
      }
      const orgId = (result.data as any)?.member?.organizationId;
      if (orgId) {
        await organization.setActive({ organizationId: orgId });
      }
      window.location.href = "/app";
    } catch {
      setError("Failed to accept invitation");
      setAcceptingId(null);
    }
  };

  const handleDecline = async (invitationId: string) => {
    setDecliningId(invitationId);
    try {
      await organization.rejectInvitation({ invitationId });
      setInvitations((prev) => prev.filter((inv) => inv.id !== invitationId));
    } catch {
      setError("Failed to decline invitation");
    } finally {
      setDecliningId(null);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    window.location.href = "/login";
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[480px]"
      >
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10">
            <Users className="size-6 text-primary" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground">
            Pending Invitations
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You've been invited to join the following teams
          </p>
        </div>

        {error && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive"
          >
            {error}
          </motion.div>
        )}

        {invitations.length > 0 ? (
          <div className="space-y-3">
            {invitations.map((inv) => (
              <motion.div
                key={inv.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-xl border border-border bg-card shadow-sm p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">
                      {inv.organizationName}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Role: <span className="capitalize font-medium">{inv.role}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1"
                      disabled={acceptingId === inv.id || decliningId === inv.id}
                      onClick={() => handleAccept(inv)}
                    >
                      {acceptingId === inv.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <>
                          <Check className="size-3" />
                          Accept
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1"
                      disabled={acceptingId === inv.id || decliningId === inv.id}
                      onClick={() => handleDecline(inv.id)}
                    >
                      {decliningId === inv.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <>
                          <X className="size-3" />
                          Decline
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card shadow-sm p-6 text-center">
            <p className="text-sm text-muted-foreground">No pending invitations</p>
          </div>
        )}

        <div className="mt-6 text-center space-y-3">
          <a
            href="/app/onboarding"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <Building2 className="size-3.5" />
            Create a new organization instead
            <ArrowRight className="size-3" />
          </a>
          <p className="text-sm text-muted-foreground">
            Signed in as {userEmail}.{" "}
            <button
              onClick={handleSignOut}
              className="font-medium text-primary hover:underline"
            >
              Sign out
            </button>
          </p>
        </div>
      </motion.div>
    </div>
  );
}
