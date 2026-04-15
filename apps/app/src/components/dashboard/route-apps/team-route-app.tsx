import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const TeamRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/team-page").then((module) => ({
		default: module.TeamPage,
	})),
);
