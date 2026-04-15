import { lazy, Suspense, type ComponentType } from "react";
import { Loader2 } from "lucide-react";
import type { AppOrganization, AppUser } from "@/types/dashboard";
import { DashboardShell } from "./dashboard-shell";

export interface DashboardRouteAppProps<PageProps extends object> {
	adminOnly?: boolean;
	currentPage: string;
	initialAccountId?: string | null;
	initialWorkspaceId?: string | null;
	organization?: AppOrganization | null;
	pageProps?: PageProps;
	requiresApiKey?: boolean;
	user?: AppUser | null;
}

export function createDashboardRouteApp<PageProps extends object>(
	PageComponent: ComponentType<PageProps>,
) {
	function DashboardRouteApp({
		adminOnly = false,
		currentPage,
		initialAccountId = null,
		initialWorkspaceId = null,
		organization = null,
		pageProps,
		requiresApiKey = true,
		user = null,
	}: DashboardRouteAppProps<PageProps>) {
		return (
			<DashboardShell
				currentPage={currentPage}
				user={user}
				organization={organization}
				requiresApiKey={requiresApiKey}
				adminOnly={adminOnly}
				initialWorkspaceId={initialWorkspaceId}
				initialAccountId={initialAccountId}
			>
				<PageComponent {...((pageProps || {}) as PageProps)} />
			</DashboardShell>
		);
	}

	DashboardRouteApp.displayName = `DashboardRouteApp(${
		PageComponent.displayName || PageComponent.name || "Page"
	})`;

	return DashboardRouteApp;
}

function RoutePageFallback() {
	return (
		<div className="flex items-center justify-center py-20">
			<Loader2 className="size-5 animate-spin text-muted-foreground" />
		</div>
	);
}

export function createLazyDashboardRouteApp<PageProps extends object>(
	loadPage: () => Promise<{ default: ComponentType<PageProps> }>,
) {
	const LazyPageComponent = lazy(loadPage);

	function LazyDashboardRouteApp({
		adminOnly = false,
		currentPage,
		initialAccountId = null,
		initialWorkspaceId = null,
		organization = null,
		pageProps,
		requiresApiKey = true,
		user = null,
	}: DashboardRouteAppProps<PageProps>) {
		return (
			<DashboardShell
				currentPage={currentPage}
				user={user}
				organization={organization}
				requiresApiKey={requiresApiKey}
				adminOnly={adminOnly}
				initialWorkspaceId={initialWorkspaceId}
				initialAccountId={initialAccountId}
			>
				<Suspense fallback={<RoutePageFallback />}>
					<LazyPageComponent {...((pageProps || {}) as PageProps)} />
				</Suspense>
			</DashboardShell>
		);
	}

	LazyDashboardRouteApp.displayName = "LazyDashboardRouteApp";

	return LazyDashboardRouteApp;
}
