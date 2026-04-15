import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const SettingsRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/settings-page").then((module) => ({
		default: module.SettingsPage,
	})),
);
