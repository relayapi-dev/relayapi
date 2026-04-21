import { createDashboardRouteApp } from "../create-dashboard-route-app";
import { ConnectionDetailPage } from "../pages/connection-detail-page";

interface ConnectionDetailPageProps {
	accountId: string;
	initialTab?: string;
}

export const ConnectionDetailRouteApp =
	createDashboardRouteApp<ConnectionDetailPageProps>(ConnectionDetailPage);
