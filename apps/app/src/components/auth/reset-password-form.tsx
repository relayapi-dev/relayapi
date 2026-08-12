import { Eye, EyeOff } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { authClient } from "../../lib/auth-client";
import { AuthShell } from "./auth-shell";

const INPUT =
	"h-11 w-full rounded-[12px] border border-[#1a1815]/12 bg-white px-3.5 pr-10 text-base text-[#1a1815] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-[#9a968c] focus:border-[#1a1815]/35 focus:ring-[3px] focus:ring-[#1a1815]/10";

export function ResetPasswordForm() {
	const token = useMemo(() => {
		if (typeof window === "undefined") return null;
		return new URLSearchParams(window.location.search).get("token");
	}, []);
	const [password, setPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [loading, setLoading] = useState(false);
	const [complete, setComplete] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);
		if (!token) {
			setError("This reset link is invalid or has expired.");
			return;
		}
		if (password.length < 8) {
			setError("Password must be at least 8 characters.");
			return;
		}
		if (password !== confirmation) {
			setError("Passwords do not match.");
			return;
		}

		setLoading(true);
		try {
			const result = await authClient.resetPassword({
				newPassword: password,
				token,
			});
			if (result.error) {
				setError("This reset link is invalid or has expired.");
				return;
			}
			setComplete(true);
		} catch {
			setError("Password reset is temporarily unavailable. Please try again.");
		} finally {
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
					Choose a new password
				</h1>
				<p className="mt-1.5 text-[0.95rem] text-[#6e6a62]">
					Use at least eight characters.
				</p>

				{complete ? (
					<div className="mt-7">
						<div className="rounded-[10px] border border-emerald-700/20 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
							Your password has been updated. Other active sessions were signed
							out.
						</div>
						<a
							href="/login"
							className="mt-6 block text-center text-sm font-medium text-[#1a1815] hover:underline"
						>
							Sign in
						</a>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="mt-7 flex flex-col gap-3.5">
						{error && (
							<div className="rounded-[10px] border border-[#e0b4ab] bg-[#f7e8e4] px-3 py-2.5 text-sm text-[#a3402f]">
								{error}
							</div>
						)}
						{[
							{
								id: "new-password",
								label: "New password",
								value: password,
								setValue: setPassword,
							},
							{
								id: "confirm-password",
								label: "Confirm password",
								value: confirmation,
								setValue: setConfirmation,
							},
						].map((field) => (
							<div key={field.id} className="flex flex-col gap-1.5">
								<label
									htmlFor={field.id}
									className="text-[0.8125rem] font-medium text-[#6e6a62]"
								>
									{field.label}
								</label>
								<div className="relative">
									<input
										id={field.id}
										type={showPassword ? "text" : "password"}
										value={field.value}
										onChange={(event) => field.setValue(event.target.value)}
										autoComplete="new-password"
										required
										minLength={8}
										className={INPUT}
									/>
									<button
										type="button"
										onClick={() => setShowPassword((visible) => !visible)}
										aria-label={
											showPassword ? "Hide password" : "Show password"
										}
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
						))}
						<button
							type="submit"
							disabled={loading || !token}
							className="mt-1 flex h-[2.875rem] w-full items-center justify-center rounded-[12px] bg-[#1a1815] text-sm font-semibold text-[#f3f1ea] transition-opacity duration-150 hover:opacity-90 disabled:pointer-events-none disabled:opacity-60"
						>
							{loading ? "Updating…" : "Update password"}
						</button>
					</form>
				)}
			</motion.div>
		</AuthShell>
	);
}
