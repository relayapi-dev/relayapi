import { session } from "@relayapi/db";
import type { APIRoute } from "astro";
import { and, eq, gt } from "drizzle-orm";
import { API_BASE_URL } from "../../../lib/api-base-url";
import { handleSdkError } from "../../../lib/api-utils";
import { createRelayClient } from "../../../lib/relay";

export const POST: APIRoute = async ({ locals, request }) => {
	const currentUser = locals.user as { id?: string } | null | undefined;
	const currentSession = locals.session as { id?: string } | null | undefined;
	if (!currentUser?.id || !currentSession?.id) {
		return Response.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Sign in before redeeming this invitation",
				},
			},
			{ status: 401 },
		);
	}

	let body: { token?: unknown };
	try {
		body = (await request.json()) as { token?: unknown };
	} catch {
		return Response.json(
			{
				error: {
					code: "INVALID_REQUEST",
					message: "Expected a JSON request body",
				},
			},
			{ status: 400 },
		);
	}
	if (
		typeof body.token !== "string" ||
		!/^rlay_inv_[0-9a-f]{48}$/.test(body.token)
	) {
		return Response.json(
			{
				error: {
					code: "INVALID_INVITE_TOKEN",
					message: "Invitation token is invalid",
				},
			},
			{ status: 400 },
		);
	}

	const [liveSession] = await locals.db
		.select({ token: session.token })
		.from(session)
		.where(
			and(
				eq(session.id, currentSession.id),
				eq(session.userId, currentUser.id),
				gt(session.expiresAt, new Date()),
			),
		)
		.limit(1);
	if (!liveSession) {
		return Response.json(
			{
				error: {
					code: "UNAUTHORIZED",
					message: "Your session has expired",
				},
			},
			{ status: 401 },
		);
	}

	try {
		const client = createRelayClient(
			`rlay_session_${liveSession.token}`,
			API_BASE_URL,
		);
		const result = await client.inviteTokens.redeem({
			token: body.token,
		});
		return Response.json(result);
	} catch (error) {
		return handleSdkError(error);
	}
};
