import { notifications } from "@relayapi/db";
import type Relay from "@relayapi/sdk";
import type { APIRoute } from "astro";
import { and, count, eq } from "drizzle-orm";
import { API_BASE_URL } from "@/lib/api-base-url";
import {
	dashboardCredentialErrorResponse,
	ensureDashboardCredential,
} from "@/lib/dashboard-credential";
import { getRelayClient } from "@/lib/relay";

async function loadDashboardApiCalls(client: Relay | null) {
		if (!client) return { usage: null, streak: null };

		const [usageResult, streakResult] = await Promise.allSettled([
			client.usage.retrieve(),
			client.streaks.retrieve(),
		]);

		let usage: Record<string, unknown> | null = null;
		if (usageResult.status === "fulfilled") {
			const data = usageResult.value;
			usage = {
				plan: data.plan.name,
				api_calls: {
					used: data.usage.api_calls_used,
					included: data.plan.api_calls_limit,
				},
				period_start: data.usage.cycle_start,
				period_end: data.usage.cycle_end,
			};
		} else {
			const e = usageResult.reason as {
				headers?: Headers;
			error?: {
				error?: { code?: string; message?: string };
				code?: string;
				message?: string;
			};
				message?: string;
			};
			const usageCount = e?.headers?.get("x-usage-count");
			const usageLimit = e?.headers?.get("x-usage-limit");
			if (usageCount != null && usageLimit != null) {
				usage = {
					plan: "free",
					api_calls: { used: Number(usageCount), included: Number(usageLimit) },
				};
			} else {
				const body = e?.error;
				const code = body?.error?.code || body?.code;
				if (code === "FREE_LIMIT_REACHED") {
					const msg = body?.error?.message || body?.message || e?.message || "";
					const match = msg.match(/\((\d+)/);
					const limit = match ? Number(match[1]) : 200;
				usage = {
					plan: "free",
					api_calls: { used: limit, included: limit },
				};
				}
			}
		}

		const streak =
			streakResult.status === "fulfilled" ? streakResult.value : null;
		return { usage, streak };
}

export const GET: APIRoute = async (ctx) => {
	const user = ctx.locals.user;
	const org = ctx.locals.organization as { id?: string } | null;
	const membershipRole = ctx.locals.organizationMembershipRole;

	if (!user || !org?.id) {
		return Response.json(
			{ error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
			{ status: 401 },
		);
	}
	if (!membershipRole) {
		return Response.json(
			{
				error: {
					code: "ORGANIZATION_MEMBERSHIP_REQUIRED",
					message: "Active organization membership is required.",
				},
			},
			{ status: 403 },
		);
	}

	const userId = (user as { id: string }).id;
	const credentialPromise = ensureDashboardCredential(ctx.locals);
	const clientPromise = getRelayClient(ctx.locals, API_BASE_URL);
	const apiCallsPromise = clientPromise.then(loadDashboardApiCalls);
	const notifCountPromise = (async () => {
		try {
			const [result] = await ctx.locals.db
				.select({ count: count() })
				.from(notifications)
				.where(
					and(eq(notifications.userId, userId), eq(notifications.read, false)),
				);
			return result?.count ?? 0;
		} catch {
			return 0;
		}
	})();

	const [credential, initialApiCalls, notifCount] = await Promise.all([
		credentialPromise,
		apiCallsPromise,
		notifCountPromise,
	]);
	if (!credential.ok) return dashboardCredentialErrorResponse(credential);

	// The common valid-key path keeps credential validation, SDK calls, and the
	// notification query concurrent. Rotation is rare; only that path repeats
	// the two read-only SDK calls with the newly minted key.
	const apiCalls = credential.created
		? await loadDashboardApiCalls(
				await getRelayClient(ctx.locals, API_BASE_URL),
			)
		: initialApiCalls;

	return Response.json(
		{
			has_api_key: true,
			usage: apiCalls.usage,
			streak: apiCalls.streak,
			notif_count: notifCount,
		},
		{ headers: { "Cache-Control": "private, no-store" } },
	);
};
