import { useState, useMemo } from "react";
import { motion } from "motion/react";
import { Eye, EyeOff, Mail, Lock, User, ArrowRight } from "lucide-react";
import { signUp, signIn } from "../../lib/auth-client";
import { Icons } from "../icons";
import { Button } from "../ui/button";

const SIGNUP_ENABLED = false;

export function SignupForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inviteId = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("invite");
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);

    try {
      const { error: authError } = await signUp.email({
        email,
        password,
        name,
      });

      if (authError) {
        const msg = authError.message?.toLowerCase() || "";
        if (msg.includes("already") || msg.includes("exists") || msg.includes("user with this email")) {
          setError("already_exists");
        } else {
          setError(authError.message || "Failed to create account");
        }
        setLoading(false);
        return;
      }

      window.location.href = inviteId ? `/invite/${inviteId}` : "/app";
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  const handleGoogleSignUp = async () => {
    await signIn.social({
      provider: "google",
      callbackURL: inviteId ? `/invite/${inviteId}` : "/app",
    });
  };

  if (!SIGNUP_ENABLED) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 bg-sidebar">
        <motion.div
          initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-[420px] text-center"
        >
          <a href="/" className="inline-flex items-center gap-2 mb-8 mx-auto text-xl font-semibold">
            <Icons.logo className="h-8 w-8" />
            <span>RelayAPI</span>
          </a>
          <div className="rounded-xl border border-border bg-card shadow-sm p-8">
            <h1 className="text-2xl font-semibold text-foreground">
              Coming Soon
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              RelayAPI is still in development and will be released soon. Thanks for your interest!
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 bg-sidebar">
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
            Create your account
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Get started with RelayAPI in seconds
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card shadow-sm p-6">
          <button
            type="button"
            onClick={handleGoogleSignUp}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
          >
            <svg className="size-4" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Continue with Google
          </button>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive"
              >
                {error === "already_exists" ? (
                  <span>
                    An account with this email already exists.{" "}
                    <a href="/login" className="font-medium underline underline-offset-2 hover:text-destructive/80">
                      Sign in instead
                    </a>
                  </span>
                ) : (
                  error
                )}
              </motion.div>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="name"
                className="text-xs font-medium text-muted-foreground"
              >
                Name
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  required
                  autoComplete="name"
                  className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="email"
                className="text-xs font-medium text-muted-foreground"
              >
                Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                  className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="password"
                className="text-xs font-medium text-muted-foreground"
              >
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="password"
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
                  {showPassword ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
            </div>

            <Button type="submit" className="w-full bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg py-2.5" disabled={loading}>
              <span className="flex items-center justify-center gap-2 text-sm font-medium">
                {loading ? (
                  <div className="size-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
                ) : (
                  <>
                    Create account
                    <ArrowRight className="size-3.5" />
                  </>
                )}
              </span>
            </Button>
          </form>

          <p className="mt-4 text-center text-[11px] text-muted-foreground/70">
            By creating an account, you agree to our{" "}
            <a href="/terms" className="underline hover:text-muted-foreground">
              Terms of Service
            </a>{" "}
            and{" "}
            <a
              href="/privacy"
              className="underline hover:text-muted-foreground"
            >
              Privacy Policy
            </a>
          </p>
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <a
            href="/login"
            className="font-medium text-primary hover:underline"
          >
            Sign in
          </a>
        </p>
      </motion.div>
    </div>
  );
}
