import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { Eye, EyeOff } from "lucide-react";
import { signIn, signUp } from "../../lib/auth-client";
import {
	AuthDivider,
	AuthShell,
	LAST_AUTH_KEY,
	ProviderButton,
} from "./auth-shell";

const SIGNUP_ENABLED = false;

const fade = {
	initial: { opacity: 0, y: 12 },
	animate: { opacity: 1, y: 0 },
	transition: { duration: 0.45, ease: [0.32, 0.72, 0, 1] as const },
};

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

	const rememberMethod = (method: string) => {
		try {
			localStorage.setItem(LAST_AUTH_KEY, method);
		} catch {
			// Non-fatal — the "Last used" hint is best-effort.
		}
	};

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
				if (
					msg.includes("already") ||
					msg.includes("exists") ||
					msg.includes("user with this email")
				) {
					setError("already_exists");
				} else {
					setError(authError.message || "Failed to create account");
				}
				setLoading(false);
				return;
			}

			rememberMethod("email");
			window.location.href = inviteId ? `/invite/${inviteId}` : "/app";
		} catch {
			setError("Something went wrong. Please try again.");
			setLoading(false);
		}
	};

	const handleGoogleSignUp = async () => {
		rememberMethod("google");
		await signIn.social({
			provider: "google",
			callbackURL: inviteId ? `/invite/${inviteId}` : "/app",
		});
	};

	if (!SIGNUP_ENABLED) {
		return (
			<AuthShell>
				<motion.div {...fade} className="text-center">
					<h1 className="text-[1.6875rem] font-semibold tracking-[-0.02em]">
						Coming soon
					</h1>
					<p className="mx-auto mt-2 max-w-[20rem] text-[0.9375rem] text-muted-foreground">
						RelayAPI is still in development and will be released soon. Thanks for
						your interest.
					</p>
					<p className="mt-7 text-sm text-muted-foreground">
						Already have an account?{" "}
						<a
							href="/login"
							className="font-medium text-foreground hover:underline"
						>
							Sign in
						</a>
					</p>
				</motion.div>
			</AuthShell>
		);
	}

	return (
		<AuthShell>
			<motion.div {...fade}>
				<h1 className="text-[1.6875rem] font-semibold tracking-[-0.02em]">
					Create your account
				</h1>
				<p className="mt-1.5 text-[0.9375rem] text-muted-foreground">
					One API for 20 social platforms
				</p>

				<div className="mt-7 flex flex-col gap-2.5">
					<ProviderButton label="Google" onClick={handleGoogleSignUp} />
				</div>

				<AuthDivider />

				<form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
					{error && (
						<motion.div
							initial={{ opacity: 0, y: -8 }}
							animate={{ opacity: 1, y: 0 }}
							className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
						>
							{error === "already_exists" ? (
								<span>
									An account with this email already exists.{" "}
									<a
										href="/login"
										className="font-medium underline underline-offset-2 hover:text-destructive/80"
									>
										Sign in instead
									</a>
								</span>
							) : (
								error
							)}
						</motion.div>
					)}

					<div className="flex flex-col gap-1.5">
						<label
							htmlFor="name"
							className="text-[0.8125rem] font-medium text-muted-foreground"
						>
							Name
						</label>
						<input
							id="name"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Your name"
							required
							autoComplete="name"
							className="h-11 w-full rounded-md border border-input bg-card px-3.5 text-sm text-foreground outline-none transition-colors duration-100 ease-[var(--ease-relay)] placeholder:text-muted-foreground/60 focus:border-ring focus:ring-[3px] focus:ring-ring/30"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<label
							htmlFor="email"
							className="text-[0.8125rem] font-medium text-muted-foreground"
						>
							Email
						</label>
						<input
							id="email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="you@example.com"
							required
							autoComplete="email"
							className="h-11 w-full rounded-md border border-input bg-card px-3.5 text-sm text-foreground outline-none transition-colors duration-100 ease-[var(--ease-relay)] placeholder:text-muted-foreground/60 focus:border-ring focus:ring-[3px] focus:ring-ring/30"
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<label
							htmlFor="password"
							className="text-[0.8125rem] font-medium text-muted-foreground"
						>
							Password
						</label>
						<div className="relative">
							<input
								id="password"
								type={showPassword ? "text" : "password"}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="Min. 8 characters"
								required
								minLength={8}
								autoComplete="new-password"
								className="h-11 w-full rounded-md border border-input bg-card pl-3.5 pr-10 text-sm text-foreground outline-none transition-colors duration-100 ease-[var(--ease-relay)] placeholder:text-muted-foreground/60 focus:border-ring focus:ring-[3px] focus:ring-ring/30"
							/>
							<button
								type="button"
								onClick={() => setShowPassword(!showPassword)}
								aria-label={showPassword ? "Hide password" : "Show password"}
								className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
							>
								{showPassword ? (
									<EyeOff className="size-4" />
								) : (
									<Eye className="size-4" />
								)}
							</button>
						</div>
					</div>

					<button
						type="submit"
						disabled={loading}
						className="mt-1 flex h-[2.875rem] w-full items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground transition-colors duration-100 ease-[var(--ease-relay)] hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-60"
					>
						{loading ? (
							<div className="size-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
						) : (
							"Create account"
						)}
					</button>
				</form>

				<p className="mt-4 text-center text-[0.6875rem] leading-relaxed text-muted-foreground/70">
					By creating an account, you agree to our{" "}
					<a href="/terms" className="underline hover:text-muted-foreground">
						Terms of Service
					</a>{" "}
					and{" "}
					<a href="/privacy" className="underline hover:text-muted-foreground">
						Privacy Policy
					</a>
				</p>

				<p className="mt-6 text-center text-sm text-muted-foreground">
					Already have an account?{" "}
					<a
						href="/login"
						className="font-medium text-foreground hover:underline"
					>
						Sign in
					</a>
				</p>
			</motion.div>
		</AuthShell>
	);
}
