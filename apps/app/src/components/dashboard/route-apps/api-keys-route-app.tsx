import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const ApiKeysRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/api-keys-page").then((module) => ({
		default: module.ApiKeysPage,
	})),
);
