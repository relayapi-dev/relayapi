import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const AdminOrganizationsRouteApp =
	createLazyDashboardRouteApp(() =>
		import("../pages/admin/admin-organizations-page").then((module) => ({
			default: module.AdminOrganizationsPage,
		})),
	);
