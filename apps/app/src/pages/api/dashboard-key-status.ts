import type { APIRoute } from "astro";
import { clearClientCache } from "@/lib/relay";

async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export const GET: APIRoute = async (context) => {
	const user = context.locals.user;
	const org = context.locals.organization as { id?: string } | null;
	const kv = context.locals.kv;

	if (!user || !org?.id || !kv) {
		return Response.json(
			{ error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
			{ status: 401 },
		);
	}

	const rawKey = await kv.get(`dashboard-key:${org.id}`);
	if (!rawKey) {
		return Response.json({ has_api_key: false });
	}

	const hashedKey = await hashKey(rawKey);
	const authEntry = await kv.get(`apikey:${hashedKey}`);

	if (!authEntry) {
		await kv.delete(`dashboard-key:${org.id}`);
		clearClientCache(org.id);
		return Response.json({ has_api_key: false });
	}

	return Response.json({ has_api_key: true });
};
