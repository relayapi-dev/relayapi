import { Check, KeyRound, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { useState } from "react";
import { organization } from "@/lib/auth-client";

interface BearerInvitationPageProps {
	token: string;
	user: { id: string; name: string; email: string } | null;
}

const PAGE =
	"auth-shell flex min-h-screen items-center justify-center bg-landing-page px-4 text-[#1a1815]";
const CARD =
	"w-full max-w-[440px] rounded-[18px] border border-[#1a1815]/10 bg-white p-7 shadow-[0_24px_60px_-40px_rgba(40,28,12,0.5)]";
const PRIMARY =
	"flex h-11 w-full items-center justify-center gap-2 rounded-[12px] bg-[#1a1815] text-sm font-medium text-[#f3f1ea] transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-60";

export function BearerInvitationPage({
	token,
	user,
}: BearerInvitationPageProps) {
	const [redeeming, setRedeeming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [redeemed, setRedeemed] = useState(false);

	const redeem = async () => {
		setRedeeming(true);
		setError(null);
		try {
			const response = await fetch("/api/invite-tokens/redeem", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});
			const payload = (await response.json()) as {
				organization?: { id?: string };
				error?: { message?: string };
			};
			if (!response.ok || !payload.organization?.id) {
				setError(
					payload.error?.message ?? "This invitation could not be redeemed.",
				);
				return;
			}
			setRedeemed(true);
			await organization.setActive({
				organizationId: payload.organization.id,
			});
			window.location.href = "/app";
		} catch {
			setError("This invitation could not be redeemed. Please try again.");
		} finally {
			setRedeeming(false);
		}
	};

	return (
		<main className={PAGE}>
			<section className={CARD}>
				<div className="mx-auto flex size-12 items-center justify-center rounded-[14px] bg-[#efece4]">
					{redeemed ? (
						<Check className="size-6 text-[#356246]" />
					) : (
						<KeyRound className="size-6 text-[#1a1815]" />
					)}
				</div>
				<h1 className="mt-5 text-center text-2xl font-semibold">
					Join a RelayAPI organization
				</h1>
				<p className="mt-2 text-center text-sm leading-6 text-[#6e6a62]">
					This secure, single-use invitation grants the role and workspace
					access chosen by its issuer.
				</p>

				<div className="mt-6 flex items-start gap-3 rounded-[12px] bg-[#f6f4ee] p-4">
					<ShieldCheck className="mt-0.5 size-5 shrink-0 text-[#356246]" />
					<p className="text-sm leading-5 text-[#514d46]">
						Invitation authority is checked again when you accept. It cannot
						downgrade access you already hold.
					</p>
				</div>

				{error && (
					<div className="mt-4 flex items-start gap-2 rounded-[12px] bg-[#f7e8e4] p-3 text-sm text-[#8f3327]">
						<XCircle className="mt-0.5 size-4 shrink-0" />
						<span>{error}</span>
					</div>
				)}

				{user ? (
					<div className="mt-6">
						<p className="mb-3 text-center text-xs text-[#7d786f]">
							Accepting as {user.email}
						</p>
						<button
							type="button"
							className={PRIMARY}
							onClick={redeem}
							disabled={redeeming || redeemed}
						>
							{redeeming && <Loader2 className="size-4 animate-spin" />}
							{redeeming ? "Accepting…" : "Accept invitation"}
						</button>
					</div>
				) : (
					<div className="mt-6 grid gap-3">
						<a
							className={PRIMARY}
							href={`/login?redirect=${encodeURIComponent(`/invite/${token}`)}`}
						>
							Log in to accept
						</a>
						<a
							className="flex h-11 items-center justify-center rounded-[12px] border border-[#1a1815]/15 text-sm font-medium text-[#1a1815] transition-colors hover:bg-[#1a1815]/[0.04]"
							href={`/signup?invite=${encodeURIComponent(token)}`}
						>
							Create an account
						</a>
					</div>
				)}
			</section>
		</main>
	);
}
