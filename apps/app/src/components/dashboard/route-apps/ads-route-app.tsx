import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const AdsRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/ads-page").then((module) => ({
		default: module.AdsPage,
	})),
);
