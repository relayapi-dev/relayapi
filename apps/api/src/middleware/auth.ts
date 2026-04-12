import { createMiddleware } from "hono/factory";
import type { Env, KVKeyData, Variables } from "../types";
import { PRICING } from "../types";

const API_KEY_PREFIXES = ["rlay_live_", "rlay_test_"];

export async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export const authMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Missing API key" } },
			401,
		);
	}

	const token = authHeader.slice(7);
	const hasValidPrefix = API_KEY_PREFIXES.some((prefix) =>
		token.startsWith(prefix),
	);
	if (!hasValidPrefix) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key format" } },
			401,
		);
	}

	const hashedKey = await hashKey(token);
	const data = await c.env.KV.get<KVKeyData>(`apikey:${hashedKey}`, "json");

	if (!data) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
			401,
		);
	}

	if (data.expires_at && new Date(data.expires_at) < new Date()) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "API key expired" } },
			401,
		);
	}

	// SECURITY: default to "free" — never grant Pro without explicit proof
	const plan = data.plan ?? "free";
	const callsIncluded = data.calls_included ?? PRICING.freeCallsIncluded;

	c.set("orgId", data.org_id);
	c.set("keyId", data.key_id);
	c.set("permissions", data.permissions);
	c.set("workspaceScope", data.workspace_scope ?? "all");
	c.set("plan", plan);
	c.set("callsIncluded", callsIncluded);
	c.set("aiEnabled", data.ai_enabled ?? false);
	c.set("dailyToolLimit", data.daily_tool_limit ?? (plan === "pro" ? 10 : 2));
	return next();
});
