import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "../../../../lib/api-utils";

export const POST: APIRoute = async (context) => {
	const id = context.params.id;
	if (!id) {
		return Response.json({ error: "Missing invitation ID" }, { status: 400 });
	}
	const client = await requireClient(context);
	if (client instanceof Response) return client;

	try {
		const requestedKey = context.request.headers.get("Idempotency-Key")?.trim();
		const idempotencyKey =
			requestedKey && /^[A-Za-z0-9._:-]{8,200}$/.test(requestedKey)
				? requestedKey
				: crypto.randomUUID();
		const staged = await client.emailIntents.resendInvitation(id, {
			idempotencyKey,
		});
		return Response.json({ success: true, ...staged }, { status: 202 });
	} catch (error) {
		return handleSdkError(error);
	}
};
