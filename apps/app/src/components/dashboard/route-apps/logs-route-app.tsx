import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const LogsRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/logs-page").then((module) => ({
		default: module.LogsPage,
	})),
);
