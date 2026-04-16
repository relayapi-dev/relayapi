import { useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { StreakProvider } from "@/hooks/use-streak";
import { UsageProvider } from "@/hooks/use-usage";
import { authClient } from "@/lib/auth-client";
import { prefetchDashboardPage } from "@/lib/dashboard-prefetch";
import type { AppOrganization, AppUser } from "@/types/dashboard";
import { FeedbackWidget } from "./feedback-widget";
import { FilterProvider } from "./filter-context";
import { Sidebar } from "./sidebar";
import { StreakToastContainer } from "./streak-toast";
import { UserProvider } from "./user-context";
import { DashboardPageGuard } from "./dashboard-page-guard";

const fullHeightPages = new Set(["inbox-comments", "inbox-messages", "posts"]);

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
		const prevParams = new URLSearchParams(window.location.search);
		const nextParams = new URLSearchParams();
		for (const key of ["workspace", "account"]) {
			const value = prevParams.get(key);
			if (value) nextParams.set(key, value);
		}

		const nextPath = `/app/${page}`;
		return `${nextPath}${nextParams.toString() ? `?${nextParams}` : ""}`;
	};

	const navigate = (page: string) => {
		setSidebarOpen(false);

		const currentPath = window.location.pathname.replace(/\/$/, "");
		const nextPath = `/app/${page}`;
		if (currentPath === nextPath) return;

		window.location.assign(buildPageUrl(page));
	};

	const prefetchPage = (page: string) => {
		if (window.location.pathname.replace(/\/$/, "") === `/app/${page}`) return;
		prefetchDashboardPage(page, buildPageUrl(page));
	};

	const handleStopImpersonating = async () => {
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
								{!sidebarOpen && (
									<button
										className="fixed top-3 left-6 z-40 rounded-md border border-border bg-background/80 p-1.5 shadow-sm backdrop-blur hover:bg-accent/50 md:hidden"
										onClick={() => setSidebarOpen(true)}
									>
										<Menu className="size-4" />
									</button>
								)}
								<Sidebar
									currentPage={currentPage}
									onNavigate={navigate}
									onPrefetch={prefetchPage}
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
										className={`mx-auto max-w-7xl px-5 pt-16 sm:px-8 md:px-10 md:pt-8 ${
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
							<FeedbackWidget />
							<StreakToastContainer />
						</div>
					</FilterProvider>
				</StreakProvider>
			</UsageProvider>
		</UserProvider>
	);
}
