import type { ComponentType } from "react";
import type { AppOrganization, AppUser } from "@/types/dashboard";
import { DashboardShell } from "./dashboard-shell";

export interface DashboardRouteAppProps<PageProps extends object> {
	adminOnly?: boolean;
	currentPage: string;
	initialAccountId?: string | null;
	isImpersonating?: boolean;
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
		isImpersonating = false,
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
				isImpersonating={isImpersonating}
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
