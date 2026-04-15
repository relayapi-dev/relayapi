import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const ContactsRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/contacts-page").then((module) => ({
		default: module.ContactsPage,
	})),
);
