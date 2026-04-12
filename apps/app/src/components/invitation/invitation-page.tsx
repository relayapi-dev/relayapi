import { useState, useEffect } from "react";
import { motion } from "motion/react";
import {
  Eye,
  EyeOff,
  Mail,
  Lock,
  User,
  ArrowRight,
  Loader2,
  Check,
  XCircle,
  Clock,
  Users,
} from "lucide-react";
import { organization, signUp, signIn } from "@/lib/auth-client";
import { Icons } from "@/components/icons";
import { Button } from "@/components/ui/button";

interface InvitationDetails {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  organizationName: string;
  organizationSlug: string;
  inviterEmail: string;
}

interface InvitationPageProps {
  invitationId: string;
  user: { id: string; name: string; email: string } | null;
}

export function InvitationPage({ invitationId, user }: InvitationPageProps) {
  const [invite, setInvite] = useState<InvitationDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);

  // Signup form state (for new users)
  const [mode, setMode] = useState<"choose" | "login" | "signup">("choose");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [signupLoading, setSignupLoading] = useState(false);
  const [signupError, setSignupError] = useState<string | null>(null);

  // Login form state
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    fetchInvitation();
  }, [invitationId]);

  const fetchInvitation = async () => {
    try {
      const res = await fetch(`/api/invitations/${invitationId}`);
      if (!res.ok) {
        setError(res.status === 404 ? "Invitation not found" : "Failed to load invitation");
        return;
      }
      const data = await res.json();
      setInvite(data);
      setEmail(data.email);
      setLoginEmail(data.email);
    } catch {
      setError("Failed to load invitation");
    } finally {
      setLoading(false);
    }
  };

  const handleAccept = async () => {
    setAccepting(true);
    try {
      const result = await organization.acceptInvitation({ invitationId });
      if (result.error) {
        setError(result.error.message || "Failed to accept invitation");
        setAccepting(false);
        return;
      }
      const orgId = invite?.organizationSlug
        ? (result.data as any)?.member?.organizationId
        : undefined;
      if (orgId) {
        await organization.setActive({ organizationId: orgId });
      }
      window.location.href = "/app";
    } catch {
      setError("Failed to accept invitation");
      setAccepting(false);
    }
  };

  const handleDecline = async () => {
    setDeclining(true);
    try {
      await organization.rejectInvitation({ invitationId });
      window.location.href = "/app";
    } catch {
      setError("Failed to decline invitation");
      setDeclining(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setSignupError(null);
    if (password.length < 8) {
      setSignupError("Password must be at least 8 characters");
      return;
    }
    setSignupLoading(true);
    try {
      const { error: authError } = await signUp.email({
        email: invite?.email || email,
        password,
        name,
      });
      if (authError) {
        setSignupError(authError.message || "Failed to create account");
        setSignupLoading(false);
        return;
      }
      // Account created — now accept the invitation
      const acceptResult = await organization.acceptInvitation({ invitationId });
      if (acceptResult.error) {
        // Account was created but invitation accept failed — redirect to login
        window.location.href = `/invite/${invitationId}`;
        return;
      }
      const orgId = (acceptResult.data as any)?.member?.organizationId;
      if (orgId) {
        await organization.setActive({ organizationId: orgId });
      }
      window.location.href = "/app";
    } catch {
      setSignupError("Something went wrong. Please try again.");
      setSignupLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setLoginLoading(true);
    try {
      const { error: authError } = await signIn.email({
        email: loginEmail,
        password: loginPassword,
      });
      if (authError) {
        setLoginError(authError.message || "Invalid email or password");
        setLoginLoading(false);
        return;
      }
      // Logged in — reload to show the accept view
      window.location.href = `/invite/${invitationId}`;
    } catch {
      setLoginError("Something went wrong. Please try again.");
      setLoginLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !invite) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[420px] text-center"
        >
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-destructive/10">
            <XCircle className="size-6 text-destructive" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground">{error}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This invitation may have expired or been cancelled.
          </p>
          <a href="/login" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
            Go to login
          </a>
        </motion.div>
      </div>
    );
  }

  if (!invite) return null;

  const isExpired = new Date(invite.expiresAt) < new Date();
  const isAlreadyAccepted = invite.status === "accepted";
  const isCancelled = invite.status === "cancelled" || invite.status === "rejected";

  if (isExpired || isAlreadyAccepted || isCancelled) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[420px] text-center"
        >
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-muted">
            {isExpired ? <Clock className="size-6 text-muted-foreground" /> : <Check className="size-6 text-muted-foreground" />}
          </div>
          <h1 className="text-2xl font-semibold text-foreground">
            {isExpired
              ? "Invitation expired"
              : isAlreadyAccepted
                ? "Invitation already accepted"
                : "Invitation cancelled"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {isExpired
              ? "This invitation has expired. Please ask the team admin to send a new one."
              : isAlreadyAccepted
                ? "You've already accepted this invitation."
                : "This invitation has been cancelled."}
          </p>
          <a href="/login" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
            {isAlreadyAccepted ? "Go to dashboard" : "Go to login"}
          </a>
        </motion.div>
      </div>
    );
  }

  // -- Logged-in user: show accept/decline --
  if (user) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[420px]"
        >
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10">
              <Users className="size-6 text-primary" />
            </div>
            <h1 className="text-2xl font-semibold text-foreground">
              You're invited
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {invite.inviterEmail} invited you to join
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card shadow-sm p-6 space-y-5">
            <div className="text-center">
              <p className="text-lg font-semibold">{invite.organizationName}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Role: <span className="capitalize font-medium">{invite.role}</span>
              </p>
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive"
              >
                {error}
              </motion.div>
            )}

            <div className="flex gap-3">
              <Button
                className="flex-1"
                disabled={accepting || declining}
                onClick={handleAccept}
              >
                <span className="flex items-center justify-center gap-2 text-sm font-medium">
                  {accepting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      Accept
                      <Check className="size-3.5" />
                    </>
                  )}
                </span>
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                disabled={accepting || declining}
                onClick={handleDecline}
              >
                {declining ? <Loader2 className="size-4 animate-spin" /> : "Decline"}
              </Button>
            </div>
          </div>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Signed in as {user.email}
          </p>
        </motion.div>
      </div>
    );
  }

  // -- Not logged in: show login/signup options --
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[420px]"
      >
        <div className="mb-8 text-center">
          <a href="/" className="inline-flex items-center gap-2 mb-8 mx-auto text-xl font-semibold">
            <Icons.logo className="h-8 w-8" />
            <span>RelayAPI</span>
          </a>
          <h1 className="text-2xl font-semibold text-foreground">
            You're invited to join
          </h1>
          <p className="mt-1 text-lg font-medium text-primary">
            {invite.organizationName}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {invite.inviterEmail} invited you as <span className="capitalize font-medium">{invite.role}</span>
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card shadow-sm p-6">
          {mode === "choose" && (
            <div className="space-y-3">
              <Button
                className="w-full"
                onClick={() => setMode("login")}
              >
                <span className="flex items-center justify-center gap-2 text-sm font-medium">
                  I have an account
                  <ArrowRight className="size-3.5" />
                </span>
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setMode("signup")}
              >
                <span className="flex items-center justify-center gap-2 text-sm font-medium">
                  Create an account
                  <ArrowRight className="size-3.5" />
                </span>
              </Button>
            </div>
          )}

          {mode === "login" && (
            <form onSubmit={handleLogin} className="space-y-4">
              {loginError && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive"
                >
                  {loginError}
                </motion.div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="login-email" className="text-xs font-medium text-muted-foreground">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="login-email"
                    type="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                    className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="login-password" className="text-xs font-medium text-muted-foreground">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Enter your password"
                    required
                    autoComplete="current-password"
                    className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={loginLoading}>
                <span className="flex items-center justify-center gap-2 text-sm font-medium">
                  {loginLoading ? (
                    <div className="size-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
                  ) : (
                    <>
                      Sign in & accept
                      <ArrowRight className="size-3.5" />
                    </>
                  )}
                </span>
              </Button>

              <button
                type="button"
                onClick={() => { setMode("choose"); setLoginError(null); }}
                className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Back
              </button>
            </form>
          )}

          {mode === "signup" && (
            <form onSubmit={handleSignup} className="space-y-4">
              {signupError && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive"
                >
                  {signupError}
                </motion.div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="signup-name" className="text-xs font-medium text-muted-foreground">
                  Name
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="signup-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    required
                    autoFocus
                    autoComplete="name"
                    className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="signup-email" className="text-xs font-medium text-muted-foreground">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="signup-email"
                    type="email"
                    value={invite.email}
                    readOnly
                    className="w-full rounded-lg border border-border bg-muted py-2.5 pl-10 pr-3 text-sm text-muted-foreground cursor-not-allowed"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="signup-password" className="text-xs font-medium text-muted-foreground">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="signup-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-10 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={signupLoading}>
                <span className="flex items-center justify-center gap-2 text-sm font-medium">
                  {signupLoading ? (
                    <div className="size-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
                  ) : (
                    <>
                      Create account & accept
                      <ArrowRight className="size-3.5" />
                    </>
                  )}
                </span>
              </Button>

              <button
                type="button"
                onClick={() => { setMode("choose"); setSignupError(null); }}
                className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Back
              </button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground/70">
          By continuing, you agree to our{" "}
          <a href="/terms" className="underline hover:text-muted-foreground">Terms of Service</a>{" "}
          and{" "}
          <a href="/privacy" className="underline hover:text-muted-foreground">Privacy Policy</a>
        </p>
      </motion.div>
    </div>
  );
}
