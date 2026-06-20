import { Eye, EyeOff } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { signIn, signUp } from "../../lib/auth-client";
import {
	AuthDivider,
	AuthShell,
	LAST_AUTH_KEY,
	ProviderButton,
} from "./auth-shell";

const SIGNUP_ENABLED = false;

const INPUT =
	"h-11 w-full rounded-[12px] border border-[#1a1815]/12 bg-white text-sm text-[#1a1815] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-[#9a968c] focus:border-[#1a1815]/35 focus:ring-[3px] focus:ring-[#1a1815]/10";

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
					<h1 className="text-[1.7rem] font-semibold tracking-[-0.02em] text-[#1a1815]">
						Coming soon
					</h1>
					<p className="mx-auto mt-2 max-w-[20rem] text-[0.95rem] text-[#6e6a62]">
						RelayAPI is still in development and will be released soon. Thanks
						for your interest.
					</p>
					<p className="mt-7 text-sm text-[#6e6a62]">
						Already have an account?{" "}
						<a
							href="/login"
							className="font-medium text-[#1a1815] hover:underline"
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
				<h1 className="text-[1.7rem] font-semibold tracking-[-0.02em] text-[#1a1815]">
					Create your account
				</h1>
				<p className="mt-1.5 text-[0.95rem] text-[#6e6a62]">
					One API for 21 social platforms
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
							className="rounded-[10px] border border-[#e0b4ab] bg-[#f7e8e4] px-3 py-2.5 text-sm text-[#a3402f]"
						>
							{error === "already_exists" ? (
								<span>
									An account with this email already exists.{" "}
									<a
										href="/login"
										className="font-medium underline underline-offset-2 hover:opacity-80"
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
							className="text-[0.8125rem] font-medium text-[#6e6a62]"
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
							className={`${INPUT} px-3.5 text-lg`}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<label
							htmlFor="email"
							className="text-[0.8125rem] font-medium text-[#6e6a62]"
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
							className={`${INPUT} px-3.5 text-lg`}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<label
							htmlFor="password"
							className="text-[0.8125rem] font-medium text-[#6e6a62]"
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
								className={`${INPUT} pl-3.5 pr-10`}
							/>
							<button
								type="button"
								onClick={() => setShowPassword(!showPassword)}
								aria-label={showPassword ? "Hide password" : "Show password"}
								className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9a968c] transition-colors hover:text-[#1a1815]"
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
						className="mt-1 flex h-[2.875rem] w-full items-center justify-center rounded-[12px] bg-[#1a1815] text-sm font-semibold text-[#f3f1ea] transition-opacity duration-150 hover:opacity-[0.9] disabled:pointer-events-none disabled:opacity-60"
					>
						{loading ? (
							<div className="size-4 animate-spin rounded-full border-2 border-[#f3f1ea]/30 border-t-[#f3f1ea]" />
						) : (
							"Create account"
						)}
					</button>
				</form>

				<p className="mt-4 text-center text-[0.6875rem] leading-relaxed text-[#9a968c]">
					By creating an account, you agree to our{" "}
					<a href="/terms" className="underline hover:text-[#6e6a62]">
						Terms of Service
					</a>{" "}
					and{" "}
					<a href="/privacy" className="underline hover:text-[#6e6a62]">
						Privacy Policy
					</a>
				</p>

				<p className="mt-6 text-center text-sm text-[#6e6a62]">
					Already have an account?{" "}
					<a
						href="/login"
						className="font-medium text-[#1a1815] hover:underline"
					>
						Sign in
					</a>
				</p>
			</motion.div>
		</AuthShell>
	);
}
