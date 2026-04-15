import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";
import type { ConnectionsPageProps } from "../pages/connections-page";

export const ConnectionsRouteApp =
	createLazyDashboardRouteApp<ConnectionsPageProps>(() =>
		import("../pages/connections-page").then((module) => ({
			default: module.ConnectionsPage,
		})),
	);
