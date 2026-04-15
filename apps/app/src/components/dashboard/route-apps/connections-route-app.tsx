import { createDashboardRouteApp } from "../create-dashboard-route-app";
import {
	ConnectionsPage,
	type ConnectionsPageProps,
} from "../pages/connections-page";

export const ConnectionsRouteApp =
	createDashboardRouteApp<ConnectionsPageProps>(ConnectionsPage);
