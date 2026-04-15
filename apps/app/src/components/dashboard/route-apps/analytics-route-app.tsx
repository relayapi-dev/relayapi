import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";
import type { AnalyticsPageNewProps } from "../pages/analytics/analytics-page-new";

export const AnalyticsRouteApp =
	createLazyDashboardRouteApp<AnalyticsPageNewProps>(() =>
		import("../pages/analytics/analytics-page-new").then((module) => ({
			default: module.AnalyticsPageNew,
		})),
	);
