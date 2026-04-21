// apps/api/src/services/automations/actions/webhook.ts
//
// webhook_out — fire-and-forget outbound HTTP. Unlike the `http_request`
// node, this action does NOT wait for the response or route on status; it
// just dispatches the request and resolves. Use `http_request` inside a
// normal node if you need to branch on the reply.
//
// Supported auth modes:
//   - none: no Authorization header added
//   - bearer: Authorization: Bearer <token>
//   - basic: Authorization: Basic base64(username:password)
//   - hmac: X-Signature: sha256=<hex hmac of body using secret>

import type { Action } from "../../../schemas/automation-actions";
import { applyMergeTags } from "../merge-tags";
import type { ActionHandler, ActionRegistry } from "./types";

type WebhookOutAction = Extract<Action, { type: "webhook_out" }>;

function buildMergeCtx(ctx: any) {
	return {
		contact:
			(ctx.context?.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context ?? {},
	};
}

function base64(str: string): string {
	if (typeof btoa === "function") return btoa(str);
	// Fallback for non-browser runtimes.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const B = (globalThis as any).Buffer;
	if (B) return B.from(str, "utf8").toString("base64");
	throw new Error("no base64 encoder available");
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

const webhookOut: ActionHandler<WebhookOutAction> = async (action, ctx) => {
	const mergeCtx = buildMergeCtx(ctx);
	const url = applyMergeTags(action.url, mergeCtx);
	const method = action.method ?? "POST";
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(
		(action.headers ?? {}) as Record<string, string>,
	)) {
		headers[k] = applyMergeTags(v, mergeCtx);
	}
	const body = action.body ? applyMergeTags(action.body, mergeCtx) : undefined;

	const auth = action.auth ?? { mode: "none" as const };
	if (auth.mode === "bearer" && auth.token) {
		headers.Authorization = `Bearer ${auth.token}`;
	} else if (auth.mode === "basic" && auth.username != null) {
		const pair = `${auth.username}:${auth.password ?? ""}`;
		headers.Authorization = `Basic ${base64(pair)}`;
	} else if (auth.mode === "hmac" && auth.secret) {
		const signed = body ?? "";
		const sig = await hmacSha256Hex(auth.secret, signed);
		headers["X-Signature"] = `sha256=${sig}`;
	}

	// Fire-and-forget: swallow errors so a bad webhook URL doesn't fail the
	// enclosing action_group run. The step_run payload will still mark the
	// action_group step as `ok` since webhookOut resolved.
	try {
		await fetch(url, { method, headers, body });
	} catch (err) {
		console.warn(
			`[automation webhook_out] fetch failed for ${url}:`,
			err instanceof Error ? err.message : err,
		);
	}
};

export const webhookHandlers: ActionRegistry = {
	webhook_out: webhookOut,
};
