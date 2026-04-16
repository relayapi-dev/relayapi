import type { APIRoute } from "astro";
import { API_BASE_URL } from "@/lib/api-base-url";
import { clearClientCache, getRelayClient } from "@/lib/relay";

async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export const GET: APIRoute = async (ctx) => {
	const user = ctx.locals.user;
	const org = ctx.locals.organization as { id?: string } | null;
	const kv = ctx.locals.kv;

	if (!user || !org?.id || !kv) {
		return Response.json(
			{ error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
			{ status: 401 },
		);
	}

	const rawKeyPromise = kv.get(`dashboard-key:${org.id}`);
	const clientPromise = getRelayClient(ctx.locals, API_BASE_URL);

	const keyStatusPromise = (async () => {
		const rawKey = await rawKeyPromise;
		if (!rawKey) return { has_api_key: false };

		const hashedKey = await hashKey(rawKey);
		const authEntry = await kv.get(`apikey:${hashedKey}`);
		if (!authEntry) {
			await kv.delete(`dashboard-key:${org.id}`);
			clearClientCache(org.id!);
			return { has_api_key: false };
		}
		return { has_api_key: true };
	})();

	const apiCallsPromise = (async () => {
		const client = await clientPromise;
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
				error?: { error?: { code?: string; message?: string }; code?: string; message?: string };
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
					usage = { plan: "free", api_calls: { used: limit, included: limit } };
				}
			}
		}

		const streak =
			streakResult.status === "fulfilled" ? streakResult.value : null;
		return { usage, streak };
	})();

	const [keyStatus, apiCalls] = await Promise.all([
		keyStatusPromise,
		apiCallsPromise,
	]);

	return Response.json(
		{
			has_api_key: keyStatus.has_api_key,
			usage: apiCalls.usage,
			streak: apiCalls.streak,
		},
		{ headers: { "Cache-Control": "private, max-age=30" } },
	);
};
