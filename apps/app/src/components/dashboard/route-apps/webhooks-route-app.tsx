import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const WebhooksRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/webhooks-page").then((module) => ({
		default: module.WebhooksPage,
	})),
);
