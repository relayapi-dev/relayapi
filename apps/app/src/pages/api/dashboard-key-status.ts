import type { APIRoute } from "astro";
import {
	dashboardCredentialErrorResponse,
	ensureDashboardCredential,
} from "@/lib/dashboard-credential";

export const GET: APIRoute = async (context) => {
	const result = await ensureDashboardCredential(context.locals);
	if (!result.ok) return dashboardCredentialErrorResponse(result);
	return Response.json({ has_api_key: true });
};
