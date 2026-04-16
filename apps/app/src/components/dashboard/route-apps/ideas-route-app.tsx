import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const IdeasRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/ideas-page").then((module) => ({
		default: module.IdeasPage,
	})),
);
