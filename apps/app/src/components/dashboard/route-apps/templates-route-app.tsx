import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const TemplatesRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/templates-page").then((module) => ({
		default: module.TemplatesPage,
	})),
);
