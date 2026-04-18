import { lazy, Suspense, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { StreakProvider } from "@/hooks/use-streak";
import { UsageProvider } from "@/hooks/use-usage";
import { prefetchDashboardPage } from "@/lib/dashboard-prefetch";
import type { AppOrganization, AppUser } from "@/types/dashboard";
import { FilterProvider } from "./filter-context";
import { Sidebar } from "./sidebar";
import { UserProvider } from "./user-context";
import { DashboardPageGuard } from "./dashboard-page-guard";

const FeedbackWidget = lazy(() =>
	import("./feedback-widget").then((m) => ({ default: m.FeedbackWidget })),
);
const StreakToastContainer = lazy(() =>
	import("./streak-toast").then((m) => ({ default: m.StreakToastContainer })),
);

const fullHeightPages = new Set(["inbox-comments", "inbox-messages", "posts", "automation", "ideas"]);

export function DashboardShell({
	adminOnly = false,
	children,
	currentPage,
	initialAccountId = null,
	isImpersonating = false,
	initialWorkspaceId = null,
	organization,
	requiresApiKey = true,
	user,
}: {
	adminOnly?: boolean;
	children: ReactNode;
	currentPage: string;
	initialAccountId?: string | null;
	initialWorkspaceId?: string | null;
	isImpersonating?: boolean;
	organization?: AppOrganization | null;
	requiresApiKey?: boolean;
	user?: AppUser | null;
}) {
	const [sidebarOpen, setSidebarOpen] = useState(false);

	const buildPageUrl = (page: string) => {
		const nextPath = `/app/${page}`;
		if (typeof window === "undefined") return nextPath;

		const prevParams = new URLSearchParams(window.location.search);
		const nextParams = new URLSearchParams();
		for (const key of ["workspace", "account"]) {
			const value = prevParams.get(key);
			if (value) nextParams.set(key, value);
		}

		return `${nextPath}${nextParams.toString() ? `?${nextParams}` : ""}`;
	};

	const navigate = (page: string) => {
		setSidebarOpen(false);

		const currentPath = window.location.pathname.replace(/\/$/, "");
		const nextPath = `/app/${page}`;
		if (currentPath === nextPath) return;

		const absoluteUrl = new URL(
			buildPageUrl(page),
			window.location.origin,
		).toString();
		window.location.href = absoluteUrl;
	};

	const prefetchPage = (page: string) => {
		if (window.location.pathname.replace(/\/$/, "") === `/app/${page}`) return;
		prefetchDashboardPage(page, buildPageUrl(page));
	};

	const handleStopImpersonating = async () => {
		const { authClient } = await import("@/lib/auth-client");
		await authClient.admin.stopImpersonating();
		window.location.href = "/app/admin-users";
	};

	return (
		<UserProvider user={user ?? null}>
			<UsageProvider>
				<StreakProvider>
					<FilterProvider
						initialWorkspaceId={initialWorkspaceId}
						initialAccountId={initialAccountId}
					>
						<div className="flex h-screen flex-col bg-background">
							{isImpersonating && (
								<div className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-xs font-medium text-black">
									<span>
										Impersonating {user?.name || user?.email}
									</span>
									<button
										type="button"
										onClick={handleStopImpersonating}
										className="rounded bg-black/20 px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-black/30"
									>
										Stop impersonating
									</button>
								</div>
							)}
							<div className="flex flex-1 overflow-hidden">
								<Sidebar
									currentPage={currentPage}
									onNavigate={navigate}
									onPrefetch={prefetchPage}
									buildHref={buildPageUrl}
									isOpen={sidebarOpen}
									onClose={() => setSidebarOpen(false)}
									user={user}
									organization={organization}
								/>
								<main
									className="flex-1 overflow-y-auto"
									style={{ scrollbarGutter: "stable" }}
								>
									<div
										className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur md:hidden"
										style={{
											paddingTop: "max(0.5rem, env(safe-area-inset-top))",
											paddingBottom: "0.5rem",
										}}
									>
										<button
											type="button"
											aria-label="Open menu"
											className="-ml-1 rounded-md p-1.5 hover:bg-accent/50"
											onClick={() => setSidebarOpen(true)}
										>
											<Menu className="size-4" />
										</button>
									</div>
									<div
										className={`mx-auto max-w-7xl px-5 pt-4 sm:px-8 md:px-10 md:pt-8 ${
											fullHeightPages.has(currentPage) ? "pb-0" : "pb-16"
										}`}
									>
										<DashboardPageGuard
											requiresApiKey={requiresApiKey}
											adminOnly={adminOnly}
										>
											{children}
										</DashboardPageGuard>
									</div>
								</main>
							</div>
							<Suspense fallback={null}>
								<FeedbackWidget />
							</Suspense>
							<Suspense fallback={null}>
								<StreakToastContainer />
							</Suspense>
						</div>
					</FilterProvider>
				</StreakProvider>
			</UsageProvider>
		</UserProvider>
	);
}
