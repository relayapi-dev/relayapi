import { ArrowRight, Building2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { organization, signOut } from "../../lib/auth-client";
import { Button } from "../ui/button";

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

interface OnboardingFormProps {
	userEmail: string;
}

export function OnboardingForm({ userEmail }: OnboardingFormProps) {
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [slugEdited, setSlugEdited] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!slugEdited) {
			setSlug(slugify(name));
		}
	}, [name, slugEdited]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setLoading(true);

		try {
			const { data, error: createError } = await organization.create({
				name: name.trim(),
				slug: slug.trim(),
			});

			if (createError) {
				setError(createError.message || "Failed to create organization");
				setLoading(false);
				return;
			}

			if (data?.id) {
				await organization.setActive({ organizationId: data.id });

				// Bootstrap dashboard API key for SDK access
				try {
					await fetch("/api/bootstrap-key", { method: "POST" });
				} catch {
					// Non-critical — key can be created on next dashboard load
				}
			}

			window.location.href = "/app";
		} catch {
			setError("Something went wrong. Please try again.");
			setLoading(false);
		}
	};

	const handleSignOut = async () => {
		await signOut();
		window.location.href = "/login";
	};

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
						<Building2 className="size-6 text-primary" />
					</div>
					<h1 className="text-2xl font-semibold text-foreground">
						Create your organization
					</h1>
					<p className="mt-2 text-sm text-muted-foreground">
						Organizations help you manage your API keys, connections, and team
						members.
					</p>
				</div>

				<div className="rounded-xl border border-border bg-card shadow-sm p-6">
					<form onSubmit={handleSubmit} className="space-y-4">
						{error && (
							<motion.div
								initial={{ opacity: 0, y: -8 }}
								animate={{ opacity: 1, y: 0 }}
								className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive"
							>
								{error}
							</motion.div>
						)}

						<div className="space-y-1.5">
							<label
								htmlFor="org-name"
								className="text-xs font-medium text-muted-foreground"
							>
								Organization name
							</label>
							<input
								id="org-name"
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="My Company"
								required
								autoFocus
								className="w-full rounded-lg border border-border bg-background py-2.5 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25"
							/>
						</div>

						<div className="space-y-1.5">
							<label
								htmlFor="org-slug"
								className="text-xs font-medium text-muted-foreground"
							>
								URL slug
							</label>
							<input
								id="org-slug"
								type="text"
								value={slug}
								onChange={(e) => {
									setSlug(slugify(e.target.value));
									setSlugEdited(true);
								}}
								placeholder="my-company"
								required
								pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
								className="w-full rounded-lg border border-border bg-background py-2.5 px-3 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/25 font-mono"
							/>
							{slug && (
								<p className="text-[11px] text-muted-foreground">
									relayapi.dev/org/{slug}
								</p>
							)}
						</div>

						<Button
							type="submit"
							className="w-full bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg py-2.5"
							disabled={loading || !name.trim() || !slug.trim()}
						>
							<span className="flex items-center justify-center gap-2 text-sm font-medium">
								{loading ? (
									<div className="size-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
								) : (
									<>
										Create organization
										<ArrowRight className="size-3.5" />
									</>
								)}
							</span>
						</Button>
					</form>
				</div>

				<p className="mt-6 text-center text-sm text-muted-foreground">
					Signed in as {userEmail}.{" "}
					<button
						onClick={handleSignOut}
						className="font-medium text-primary hover:underline"
					>
						Sign out
					</button>
				</p>
			</motion.div>
		</div>
	);
}
