import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { StreakProvider } from "@/hooks/use-streak";
import { UsageProvider } from "@/hooks/use-usage";
import { authClient, useSession } from "@/lib/auth-client";
import { FeedbackWidget } from "./feedback-widget";
import { FilterProvider } from "./filter-context";
import { PageContent } from "./page-content";
import { Sidebar } from "./sidebar";
import { StreakToastContainer } from "./streak-toast";
import type { AppOrganization, AppUser } from "@/types/dashboard";
import { UserProvider } from "./user-context";

// Redirect old route names to new ones
const routeAliases: Record<string, string> = {
	queues: "scheduling",
	users: "team",
	broadcasts: "posts",
	workspaces: "connections",
	settings: "settings",
	inbox: "inbox-comments",
};

function resolveRoute(page: string): string {
	return routeAliases[page] || page;
}

// Pages that use full viewport height and should not have bottom padding
const fullHeightPages = new Set(["inbox-comments", "inbox-messages", "posts"]);

export default function Dashboard({
	initialPage = "posts",
	user,
	organization,
}: {
	initialPage?: string;
	user?: AppUser | null;
	organization?: AppOrganization | null;
}) {
	const [currentPage, setCurrentPage] = useState(() => {
		const resolved = resolveRoute(initialPage);
		// When redirected from workspaces, set the tab query param
		if (initialPage === "workspaces" && typeof window !== "undefined") {
			const url = new URL(window.location.href);
			url.pathname = "/app/connections";
			url.searchParams.set("tab", "workspaces");
			window.history.replaceState({}, "", url.toString());
		}
		return resolved;
	});
	const [sidebarOpen, setSidebarOpen] = useState(false);

	const navigate = (page: string) => {
		const resolved = resolveRoute(page);
		setCurrentPage(resolved);
		setSidebarOpen(false);
		// Preserve filter query params (group, account) across page navigation
		const prev = new URLSearchParams(window.location.search);
		const next = new URLSearchParams();
		for (const key of ["workspace", "account"]) {
			const val = prev.get(key);
			if (val) next.set(key, val);
		}
		const qs = next.toString();
		window.history.pushState({}, "", `/app/${resolved}${qs ? `?${qs}` : ""}`);
	};

	useEffect(() => {
		const handlePopState = () => {
			const path = window.location.pathname
				.replace("/app/", "")
				.replace("/app", "");
			setCurrentPage(resolveRoute(path || "posts"));
		};
		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, []);

	const { data: session } = useSession();
	const isImpersonating = !!(session?.session as any)?.impersonatedBy;

	const handleStopImpersonating = async () => {
		await authClient.admin.stopImpersonating();
		window.location.href = "/app/admin-users";
	};

	return (
		<UserProvider user={user ?? null}>
			<UsageProvider>
				<StreakProvider>
				<FilterProvider>
						<div className="flex h-screen flex-col bg-background">
							{isImpersonating && (
								<div className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-xs font-medium text-black">
									<span>
										Impersonating {session?.user?.name || session?.user?.email}
									</span>
									<button
										onClick={handleStopImpersonating}
										className="rounded bg-black/20 px-2 py-0.5 text-[11px] font-medium hover:bg-black/30 transition-colors"
									>
										Stop impersonating
									</button>
								</div>
							)}
							<div className="flex flex-1 overflow-hidden">
								{/* Mobile hamburger */}
								{!sidebarOpen && (
									<button
										className="fixed top-3 left-6 z-40 rounded-md p-1.5 bg-background/80 backdrop-blur border border-border shadow-sm hover:bg-accent/50 md:hidden"
										onClick={() => setSidebarOpen(true)}
									>
										<Menu className="size-4" />
									</button>
								)}
								<Sidebar
									currentPage={currentPage}
									onNavigate={navigate}
									isOpen={sidebarOpen}
									onClose={() => setSidebarOpen(false)}
									user={user}
									organization={organization}
								/>
								<main className="flex-1 overflow-y-auto" style={{ scrollbarGutter: "stable" }}>
									<div className={`mx-auto max-w-7xl px-5 sm:px-8 md:px-10 pt-16 md:pt-8 ${fullHeightPages.has(currentPage) ? "pb-0" : "pb-16"}`}>
										<PageContent page={currentPage} />
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
