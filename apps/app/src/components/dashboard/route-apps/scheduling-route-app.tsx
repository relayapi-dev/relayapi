import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const SchedulingRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/scheduling-page").then((module) => ({
		default: module.SchedulingPage,
	})),
);
