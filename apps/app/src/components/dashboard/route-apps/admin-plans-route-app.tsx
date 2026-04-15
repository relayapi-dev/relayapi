import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const AdminPlansRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/admin/admin-plans-page").then((module) => ({
		default: module.AdminPlansPage,
	})),
);
