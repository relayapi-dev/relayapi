import { createDashboardRouteApp } from "../create-dashboard-route-app";
import { AutomationDetailPage } from "../pages/automation-detail-page";

export const AutomationDetailRouteApp = createDashboardRouteApp(
	AutomationDetailPage,
	{ fullBleed: true },
);
