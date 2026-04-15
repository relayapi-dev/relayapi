import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const AdminUsersRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/admin/admin-users-page").then((module) => ({
		default: module.AdminUsersPage,
	})),
);
