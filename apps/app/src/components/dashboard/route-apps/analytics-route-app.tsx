import { createDashboardRouteApp } from "../create-dashboard-route-app";
import {
	AnalyticsPageNew,
	type AnalyticsPageNewProps,
} from "../pages/analytics/analytics-page-new";

export const AnalyticsRouteApp =
	createDashboardRouteApp<AnalyticsPageNewProps>(AnalyticsPageNew);
