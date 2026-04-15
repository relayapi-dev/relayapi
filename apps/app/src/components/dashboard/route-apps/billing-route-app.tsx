import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const BillingRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/billing-page").then((module) => ({
		default: module.BillingPage,
	})),
);
