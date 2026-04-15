import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const MediaRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/media-page").then((module) => ({
		default: module.MediaPage,
	})),
);
