import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const InboxMessagesRouteApp =
	createLazyDashboardRouteApp(() =>
		import("../pages/inbox-messages-page").then((module) => ({
			default: module.InboxMessagesPage,
		})),
	);
