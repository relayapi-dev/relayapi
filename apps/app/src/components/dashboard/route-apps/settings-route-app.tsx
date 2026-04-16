import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";
import type { SettingsPageProps } from "../pages/settings-page";

export const SettingsRouteApp =
	createLazyDashboardRouteApp<SettingsPageProps>(() =>
		import("../pages/settings-page").then((module) => ({
			default: module.SettingsPage,
		})),
	);
