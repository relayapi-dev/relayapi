import { lazy, Suspense, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";
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

const fullHeightPages = new Set([
	"inbox-comments",
	"inbox-messages",
	"posts",
	"automation",
	"ideas",
]);

export function DashboardShell({
	adminOnly = false,
	children,
	currentPage,
	fullBleed = false,
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
	fullBleed?: boolean;
	initialAccountId?: string | null;
	initialWorkspaceId?: string | null;
	isImpersonating?: boolean;
	organization?: AppOrganization | null;
	requiresApiKey?: boolean;
	user?: AppUser | null;
}) {
	const [sidebarOpen, setSidebarOpen] = useState(false);

	const buildPageUrl = (page: string) => {
		// Overview canonically lives at /app, not /app/overview.
		const nextPath = page === "overview" ? "/app" : `/app/${page}`;
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
		const currentPath = window.location.pathname.replace(/\/$/, "");
		const nextPath = page === "overview" ? "/app" : `/app/${page}`;

		// Same page: nothing to load, just close the drawer.
		if (currentPath === nextPath) {
			setSidebarOpen(false);
			return;
		}

		// Different page: navigate WITHOUT animating the drawer closed in the same
		// tick. Sliding the drawer off-screen (transition-transform) mid-tap makes
		// iOS Safari (and some Android WebViews) drop the navigation — the original
		// "tap just refreshes the page" bug. The full-document load tears the drawer
		// down anyway, so there's nothing to clean up here.
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
			<UsageProvider orgId={organization?.id ?? null}>
				<StreakProvider orgId={organization?.id ?? null}>
					<FilterProvider
						initialWorkspaceId={initialWorkspaceId}
						initialAccountId={initialAccountId}
					>
						<div className="flex h-screen flex-col bg-background">
							{isImpersonating && (
								<div className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-xs font-medium text-black">
									<span>Impersonating {user?.name || user?.email}</span>
									<button
										type="button"
										onClick={handleStopImpersonating}
										className="rounded bg-black/20 px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-black/30"
									>
										Stop impersonating
									</button>
								</div>
							)}
							<div
								className={cn(
									"flex flex-1 overflow-hidden",
									!fullBleed && "md:gap-10 md:pl-7 lg:gap-20 lg:pl-12",
								)}
							>
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
									className="dash-scroll min-w-0 flex-1 overflow-y-auto"
									style={{
										scrollbarGutter: fullBleed ? undefined : "stable",
									}}
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
										className={
											fullBleed
												? "min-h-full px-0 pt-0 md:h-full"
												: `mx-auto max-w-7xl overflow-x-clip px-5 pt-4 sm:px-8 md:pl-0 md:pr-7 md:pt-10 lg:pr-12 lg:pt-12 ${
														fullHeightPages.has(currentPage) ? "pb-0" : "pb-16"
													}`
										}
									>
										<DashboardPageGuard
											requiresApiKey={requiresApiKey}
											adminOnly={adminOnly}
											orgId={organization?.id ?? null}
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
