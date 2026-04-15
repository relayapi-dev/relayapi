import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const NotificationsRouteApp =
	createLazyDashboardRouteApp(() =>
		import("../pages/notifications-page").then((module) => ({
			default: module.NotificationsPage,
		})),
	);
