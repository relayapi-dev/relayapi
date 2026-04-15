import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const InboxReviewsRouteApp =
	createLazyDashboardRouteApp(() =>
		import("../pages/inbox-reviews-page").then((module) => ({
			default: module.InboxReviewsPage,
		})),
	);
