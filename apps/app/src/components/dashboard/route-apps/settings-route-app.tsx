import { createDashboardRouteApp } from "../create-dashboard-route-app";
import { SettingsPage, type SettingsPageProps } from "../pages/settings-page";

export const SettingsRouteApp =
	createDashboardRouteApp<SettingsPageProps>(SettingsPage);
