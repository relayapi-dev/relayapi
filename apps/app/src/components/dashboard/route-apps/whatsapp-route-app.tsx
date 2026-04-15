import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";

export const WhatsAppRouteApp = createLazyDashboardRouteApp(() =>
	import("../pages/whatsapp-page").then((module) => ({
		default: module.WhatsAppPage,
	})),
);
