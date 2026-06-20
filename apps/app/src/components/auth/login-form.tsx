import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Eye, EyeOff } from "lucide-react";
import { signIn } from "../../lib/auth-client";
import {
	AuthDivider,
	AuthShell,
	LAST_AUTH_KEY,
	ProviderButton,
} from "./auth-shell";

const INPUT =
	"h-11 w-full rounded-[12px] border border-[#1a1815]/12 bg-white text-sm text-[#1a1815] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-[#9a968c] focus:border-[#1a1815]/35 focus:ring-[3px] focus:ring-[#1a1815]/10";

export function LoginForm() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [lastUsed, setLastUsed] = useState<string | null>(null);

	useEffect(() => {
		try {
			setLastUsed(localStorage.getItem(LAST_AUTH_KEY));
		} catch {
			// localStorage may be unavailable (private mode) — badge just stays off.
		}
	}, []);

	const rememberMethod = (method: string) => {
		try {
			localStorage.setItem(LAST_AUTH_KEY, method);
		} catch {
			// Non-fatal — the "Last used" hint is best-effort.
		}
	};

	const redirect = useMemo(() => {
		if (typeof window === "undefined") return "/app";
		const params = new URLSearchParams(window.location.search);
		return params.get("redirect") || "/app";
	}, []);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setLoading(true);

		try {
			const { error: authError } = await signIn.email({
				email,
				password,
			});

			if (authError) {
				setError(authError.message || "Invalid email or password");
				setLoading(false);
				return;
			}

			rememberMethod("email");
			window.location.href = redirect;
		} catch {
			setError("Something went wrong. Please try again.");
			setLoading(false);
		}
	};

	const handleGoogleSignIn = async () => {
		rememberMethod("google");
		await signIn.social({
			provider: "google",
			callbackURL: redirect,
		});
	};

	return (
		<AuthShell>
			<motion.div
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
			>
				<h1 className="text-[1.7rem] font-semibold tracking-[-0.02em] text-[#1a1815]">
					Welcome to RelayAPI
				</h1>
				<p className="mt-1.5 text-[0.95rem] text-[#6e6a62]">
					The unified social media API
				</p>

				<div className="mt-7 flex flex-col gap-2.5">
					<ProviderButton
						label="Google"
						onClick={handleGoogleSignIn}
						lastUsed={lastUsed === "google"}
					/>
				</div>

				<AuthDivider />

				<form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
					{error && (
						<motion.div
							initial={{ opacity: 0, y: -8 }}
							animate={{ opacity: 1, y: 0 }}
							className="rounded-[10px] border border-[#e0b4ab] bg-[#f7e8e4] px-3 py-2.5 text-sm text-[#a3402f]"
						>
							{error}
						</motion.div>
					)}

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
							placeholder="Your email address"
							required
							autoComplete="email"
							className={`${INPUT} px-3.5`}
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
								placeholder="Enter your password"
								required
								autoComplete="current-password"
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
							"Sign in"
						)}
					</button>
				</form>

				<p className="mt-6 text-center text-sm text-[#6e6a62]">
					Don&apos;t have an account?{" "}
					<a
						href="/signup"
						className="font-medium text-[#1a1815] hover:underline"
					>
						Sign up
					</a>
				</p>
			</motion.div>
		</AuthShell>
	);
}
