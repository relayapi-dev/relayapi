import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "../../lib/api-utils";

export const POST: APIRoute = async (context) => {
	const client = await requireClient(context);
	if (client instanceof Response) return client;

	try {
		const value = (await context.request.json()) as Record<string, unknown>;
		const requestedKey = context.request.headers.get("Idempotency-Key")?.trim();
		const idempotencyKey =
			requestedKey && /^[A-Za-z0-9._:-]{8,200}$/.test(requestedKey)
				? requestedKey
				: crypto.randomUUID();
		const staged = await client.emailIntents.requestOnDemandPlatform(
			{
				platform: typeof value.platform === "string" ? value.platform : "",
				email: typeof value.email === "string" ? value.email : "",
				...(typeof value.name === "string" ? { name: value.name } : {}),
				...(typeof value.message === "string"
					? { message: value.message }
					: {}),
			},
			{ idempotencyKey },
		);
		return Response.json({ success: true, ...staged }, { status: 202 });
	} catch (error) {
		return handleSdkError(error);
	}
};
