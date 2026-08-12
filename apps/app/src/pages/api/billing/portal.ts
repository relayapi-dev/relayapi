import type { APIRoute } from "astro";
import {
	handleSdkError,
	requireBillingAdmin,
	requireClient,
} from "@/lib/api-utils";

export const POST: APIRoute = async (context) => {
	const forbidden = await requireBillingAdmin(context);
	if (forbidden) return forbidden;
	const client = await requireClient(context);
	if (client instanceof Response) return client;

	try {
		return Response.json(await client.billing.portal());
	} catch (error) {
		return handleSdkError(error);
	}
};
