import type { APIRoute } from "astro";
import { handleSdkError, requireSessionBoundClient } from "@/lib/api-utils";

export const POST: APIRoute = async (ctx) => {
	const boundClient = await requireSessionBoundClient(ctx);
	if (boundClient instanceof Response) return boundClient;
	const { client, requestOptions } = boundClient;
	const platform = ctx.params.platform;
	try {
		const body = await ctx.request.json();
		if (platform === "discord") {
			return Response.json(
				await client.connect.connectDiscord(body, requestOptions),
			);
		}
		if (platform === "sms") {
			return Response.json(
				await client.connect.connectSms(body, requestOptions),
			);
		}
		if (platform === "slack") {
			return Response.json(
				await client.connect.connectSlack(body, requestOptions),
			);
		}
		if (platform === "beehiiv") {
			return Response.json(
				await client.connect.connectBeehiiv(body, requestOptions),
			);
		}
		if (platform === "convertkit") {
			return Response.json(
				await client.connect.connectConvertKit(body, requestOptions),
			);
		}
		if (platform === "mailchimp") {
			return Response.json(
				await client.connect.connectMailchimp(body, requestOptions),
			);
		}
		if (platform === "listmonk") {
			return Response.json(
				await client.connect.connectListMonk(body, requestOptions),
			);
		}
		return Response.json(
			{
				error: {
					code: "UNSUPPORTED_PLATFORM",
					message: "This credential connector is not supported.",
				},
			},
			{ status: 404 },
		);
	} catch (error) {
		return handleSdkError(error);
	}
};
