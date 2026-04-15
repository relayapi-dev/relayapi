import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const CampaignsRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/campaigns-page").then((module) => ({
		default: module.CampaignsPage,
	})),
);
