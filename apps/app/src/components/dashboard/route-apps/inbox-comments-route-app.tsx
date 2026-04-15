import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const InboxCommentsRouteApp =
	createLazyDashboardRouteApp(() =>
		import("../pages/inbox-comments-page").then((module) => ({
			default: module.InboxCommentsPage,
		})),
	);
