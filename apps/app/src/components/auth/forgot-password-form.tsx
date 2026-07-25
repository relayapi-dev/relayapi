import { motion } from "motion/react";
import { useState } from "react";
import { authClient } from "../../lib/auth-client";
import { AuthShell } from "./auth-shell";

const INPUT =
	"h-11 w-full rounded-[12px] border border-[#1a1815]/12 bg-white px-3.5 text-base text-[#1a1815] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-[#9a968c] focus:border-[#1a1815]/35 focus:ring-[3px] focus:ring-[#1a1815]/10";

export function ForgotPasswordForm() {
	const [email, setEmail] = useState("");
	const [loading, setLoading] = useState(false);
	const [submitted, setSubmitted] = useState(false);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setLoading(true);
		try {
			// Always render the same result so this page cannot be used to enumerate
			// registered accounts.
			await authClient.requestPasswordReset({
				email,
				redirectTo: "/reset-password",
			});
		} finally {
			setSubmitted(true);
			setLoading(false);
		}
	};

	return (
		<AuthShell>
			<motion.div
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				transition={{ duration: 0.45, ease: [0.32, 0.72, 0, 1] }}
			>
				<h1 className="text-[1.7rem] font-semibold tracking-[-0.02em] text-[#1a1815]">
					Reset your password
				</h1>
				<p className="mt-1.5 text-[0.95rem] text-[#6e6a62]">
					We&apos;ll email you a secure reset link.
				</p>

				{submitted ? (
					<div className="mt-7">
						<div className="rounded-[10px] border border-emerald-700/20 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
							If an account exists for that address, a reset link is on its way.
						</div>
						<a
							href="/login"
							className="mt-6 block text-center text-sm font-medium text-[#1a1815] hover:underline"
						>
							Back to sign in
						</a>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="mt-7 flex flex-col gap-3.5">
						<div className="flex flex-col gap-1.5">
							<label
								htmlFor="reset-email"
								className="text-[0.8125rem] font-medium text-[#6e6a62]"
							>
								Email
							</label>
							<input
								id="reset-email"
								type="email"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								autoComplete="email"
								required
								className={INPUT}
								placeholder="you@example.com"
							/>
						</div>
						<button
							type="submit"
							disabled={loading}
							className="mt-1 flex h-[2.875rem] w-full items-center justify-center rounded-[12px] bg-[#1a1815] text-sm font-semibold text-[#f3f1ea] transition-opacity duration-150 hover:opacity-90 disabled:pointer-events-none disabled:opacity-60"
						>
							{loading ? "Sending…" : "Send reset link"}
						</button>
						<a
							href="/login"
							className="text-center text-sm font-medium text-[#1a1815] hover:underline"
						>
							Back to sign in
						</a>
					</form>
				)}
			</motion.div>
		</AuthShell>
	);
}
