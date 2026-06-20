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

/**
 * Team-invitation page in the cream / Cursor landing style. Renders under
 * BaseLayout (no `.relay-landing` wrapper), so link colours work without `!`.
 * All accept/decline/login/signup logic is unchanged.
 */

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

const PAGE =
  "flex min-h-screen flex-col items-center justify-center bg-landing-page px-4 text-[#1a1815]";
const INPUT =
  "w-full rounded-[12px] border border-[#1a1815]/12 bg-white py-2.5 pl-10 pr-3 text-sm text-[#1a1815] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-[#9a968c] focus:border-[#1a1815]/35 focus:ring-[3px] focus:ring-[#1a1815]/10";
const PRIMARY_BTN =
  "flex h-[2.875rem] w-full items-center justify-center rounded-[12px] bg-[#1a1815] text-sm font-medium text-[#f3f1ea] transition-opacity duration-150 hover:opacity-[0.9] disabled:pointer-events-none disabled:opacity-60";
const OUTLINE_BTN =
  "flex h-[2.875rem] w-full items-center justify-center rounded-[12px] border border-[#1a1815]/15 bg-transparent text-sm font-medium text-[#1a1815] transition-colors duration-150 hover:bg-[#1a1815]/[0.04] disabled:pointer-events-none disabled:opacity-60";
const CARD = "rounded-[18px] border border-[#1a1815]/10 bg-white p-6 shadow-[0_24px_60px_-40px_rgba(40,28,12,0.5)]";

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
        ? (result.data as { member?: { organizationId?: string } } | null)
            ?.member?.organizationId
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
      const orgId = (
        acceptResult.data as { member?: { organizationId?: string } } | null
      )?.member?.organizationId;
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
      <div className={PAGE}>
        <Loader2 className="size-6 animate-spin text-[#9a968c]" />
      </div>
    );
  }

  if (error && !invite) {
    return (
      <div className={PAGE}>
        <motion.div
          initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[420px] text-center"
        >
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-[14px] bg-[#f7e8e4]">
            <XCircle className="size-6 text-[#a3402f]" />
          </div>
          <h1 className="text-2xl font-semibold text-[#1a1815]">{error}</h1>
          <p className="mt-2 text-sm text-[#6e6a62]">
            This invitation may have expired or been cancelled.
          </p>
          <a href="/login" className="mt-6 inline-block text-sm font-medium text-[#1a1815] hover:underline">
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
      <div className={PAGE}>
        <motion.div
          initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[420px] text-center"
        >
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-[14px] bg-[#efece4]">
            {isExpired ? <Clock className="size-6 text-[#6e6a62]" /> : <Check className="size-6 text-[#6e6a62]" />}
          </div>
          <h1 className="text-2xl font-semibold text-[#1a1815]">
            {isExpired
              ? "Invitation expired"
              : isAlreadyAccepted
                ? "Invitation already accepted"
                : "Invitation cancelled"}
          </h1>
          <p className="mt-2 text-sm text-[#6e6a62]">
            {isExpired
              ? "This invitation has expired. Please ask the team admin to send a new one."
              : isAlreadyAccepted
                ? "You've already accepted this invitation."
                : "This invitation has been cancelled."}
          </p>
          <a href="/login" className="mt-6 inline-block text-sm font-medium text-[#1a1815] hover:underline">
            {isAlreadyAccepted ? "Go to dashboard" : "Go to login"}
          </a>
        </motion.div>
      </div>
    );
  }

  // -- Logged-in user: show accept/decline --
  if (user) {
    return (
      <div className={PAGE}>
        <motion.div
          initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[420px]"
        >
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-[14px] bg-landing-accent/[0.12]">
              <Users className="size-6 text-landing-accent" />
            </div>
            <h1 className="text-2xl font-semibold text-[#1a1815]">
              You're invited
            </h1>
            <p className="mt-2 text-sm text-[#6e6a62]">
              {invite.inviterEmail} invited you to join
            </p>
          </div>

          <div className={`${CARD} space-y-5`}>
            <div className="text-center">
              <p className="text-lg font-semibold text-[#1a1815]">{invite.organizationName}</p>
              <p className="mt-1 text-sm text-[#6e6a62]">
                Role: <span className="font-medium capitalize text-[#1a1815]">{invite.role}</span>
              </p>
            </div>

            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-[10px] border border-[#e0b4ab] bg-[#f7e8e4] px-3 py-2.5 text-sm text-[#a3402f]"
              >
                {error}
              </motion.div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                className={`${PRIMARY_BTN} flex-1`}
                disabled={accepting || declining}
                onClick={handleAccept}
              >
                <span className="flex items-center justify-center gap-2">
                  {accepting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <>
                      Accept
                      <Check className="size-3.5" />
                    </>
                  )}
                </span>
              </button>
              <button
                type="button"
                className={`${OUTLINE_BTN} flex-1`}
                disabled={accepting || declining}
                onClick={handleDecline}
              >
                {declining ? <Loader2 className="size-4 animate-spin" /> : "Decline"}
              </button>
            </div>
          </div>

          <p className="mt-6 text-center text-sm text-[#6e6a62]">
            Signed in as {user.email}
          </p>
        </motion.div>
      </div>
    );
  }

  // -- Not logged in: show login/signup options --
  return (
    <div className={PAGE}>
      <motion.div
        initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-[420px]"
      >
        <div className="mb-8 text-center">
          <a href="/" className="mx-auto mb-8 inline-flex items-center gap-2.5">
            <span className="inline-flex size-7 items-center justify-center rounded-[0.45rem] bg-[#1a1815]">
              <Icons.logo className="size-4 text-[#f3f1ea]" />
            </span>
            <span className="text-base font-semibold tracking-[0.04em]">RELAYAPI</span>
          </a>
          <h1 className="text-2xl font-semibold text-[#1a1815]">
            You're invited to join
          </h1>
          <p className="mt-1 text-lg font-medium text-landing-accent">
            {invite.organizationName}
          </p>
          <p className="mt-2 text-sm text-[#6e6a62]">
            {invite.inviterEmail} invited you as <span className="font-medium capitalize text-[#1a1815]">{invite.role}</span>
          </p>
        </div>

        <div className={CARD}>
          {mode === "choose" && (
            <div className="space-y-3">
              <button
                type="button"
                className={PRIMARY_BTN}
                onClick={() => setMode("login")}
              >
                <span className="flex items-center justify-center gap-2">
                  I have an account
                  <ArrowRight className="size-3.5" />
                </span>
              </button>
              <button
                type="button"
                className={OUTLINE_BTN}
                onClick={() => setMode("signup")}
              >
                <span className="flex items-center justify-center gap-2">
                  Create an account
                  <ArrowRight className="size-3.5" />
                </span>
              </button>
            </div>
          )}

          {mode === "login" && (
            <form onSubmit={handleLogin} className="space-y-4">
              {loginError && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-[10px] border border-[#e0b4ab] bg-[#f7e8e4] px-3 py-2.5 text-sm text-[#a3402f]"
                >
                  {loginError}
                </motion.div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="login-email" className="text-xs font-medium text-[#6e6a62]">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#9a968c]" />
                  <input
                    id="login-email"
                    type="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                    className={INPUT}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="login-password" className="text-xs font-medium text-[#6e6a62]">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#9a968c]" />
                  <input
                    id="login-password"
                    type={showPassword ? "text" : "password"}
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Enter your password"
                    required
                    autoComplete="current-password"
                    className={`${INPUT} pr-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9a968c] transition-colors hover:text-[#1a1815]"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              <button type="submit" className={PRIMARY_BTN} disabled={loginLoading}>
                <span className="flex items-center justify-center gap-2">
                  {loginLoading ? (
                    <div className="size-4 animate-spin rounded-full border-2 border-[#f3f1ea]/30 border-t-[#f3f1ea]" />
                  ) : (
                    <>
                      Sign in & accept
                      <ArrowRight className="size-3.5" />
                    </>
                  )}
                </span>
              </button>

              <button
                type="button"
                onClick={() => { setMode("choose"); setLoginError(null); }}
                className="w-full text-center text-sm text-[#6e6a62] transition-colors hover:text-[#1a1815]"
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
                  className="rounded-[10px] border border-[#e0b4ab] bg-[#f7e8e4] px-3 py-2.5 text-sm text-[#a3402f]"
                >
                  {signupError}
                </motion.div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="signup-name" className="text-xs font-medium text-[#6e6a62]">
                  Name
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#9a968c]" />
                  <input
                    id="signup-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    required
                    autoComplete="name"
                    className={INPUT}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="signup-email" className="text-xs font-medium text-[#6e6a62]">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#9a968c]" />
                  <input
                    id="signup-email"
                    type="email"
                    value={invite.email}
                    readOnly
                    className="w-full cursor-not-allowed rounded-[12px] border border-[#1a1815]/12 bg-[#efece4] py-2.5 pl-10 pr-3 text-sm text-[#6e6a62]"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="signup-password" className="text-xs font-medium text-[#6e6a62]">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#9a968c]" />
                  <input
                    id="signup-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    className={`${INPUT} pr-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9a968c] transition-colors hover:text-[#1a1815]"
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>

              <button type="submit" className={PRIMARY_BTN} disabled={signupLoading}>
                <span className="flex items-center justify-center gap-2">
                  {signupLoading ? (
                    <div className="size-4 animate-spin rounded-full border-2 border-[#f3f1ea]/30 border-t-[#f3f1ea]" />
                  ) : (
                    <>
                      Create account & accept
                      <ArrowRight className="size-3.5" />
                    </>
                  )}
                </span>
              </button>

              <button
                type="button"
                onClick={() => { setMode("choose"); setSignupError(null); }}
                className="w-full text-center text-sm text-[#6e6a62] transition-colors hover:text-[#1a1815]"
              >
                Back
              </button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-[11px] text-[#9a968c]">
          By continuing, you agree to our{" "}
          <a href="/terms" className="underline hover:text-[#6e6a62]">Terms of Service</a>{" "}
          and{" "}
          <a href="/privacy" className="underline hover:text-[#6e6a62]">Privacy Policy</a>
        </p>
      </motion.div>
    </div>
  );
}
