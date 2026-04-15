import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const ProfileRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/profile-page").then((module) => ({
		default: module.ProfilePage,
	})),
);
