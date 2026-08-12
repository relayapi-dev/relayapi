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

import {
	BlockedPublicUrlError,
	fetchPublicUrl,
} from "../../../lib/fetch-public-url";
import type { Action } from "../../../schemas/automation-actions";
import {
	loadAutomationWebhookSecret,
	type WebhookSecretBundle,
} from "../graph-secrets";
import { applyMergeTags } from "../merge-tags";
import {
	AutomationExternalEffectKnownFailureError,
	type RunContext,
} from "../types";
import type { ActionHandler, ActionRegistry } from "./types";

type WebhookOutAction = Extract<Action, { type: "webhook_out" }>;

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

function bodyByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function buildMergeCtx(ctx: RunContext) {
	return {
		contact:
			(ctx.context?.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context ?? {},
	};
}

function base64(str: string): string {
	if (typeof btoa === "function") return btoa(str);
	// Fallback for non-browser runtimes.
	const B = (
		globalThis as {
			Buffer?: {
				from(data: string, encoding: string): { toString(enc: string): string };
			};
		}
	).Buffer;
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

function hasInlineCredentials(action: WebhookOutAction): boolean {
	if (Object.keys(action.headers ?? {}).length > 0) return true;
	if (action.body) return true;
	if (
		action.auth.token ||
		action.auth.username ||
		action.auth.password ||
		action.auth.secret
	) {
		return true;
	}
	// Full destinations are write-only because provider tokens commonly appear in
	// path segments or subdomains. Only the persisted placeholder may execute
	// without a secret reference (and it will fail closed as an invalid destination).
	return action.url !== "https://redacted.invalid/";
}

async function resolveSecretBundle(
	action: WebhookOutAction,
	ctx: RunContext,
): Promise<WebhookSecretBundle> {
	if (!action.secret_ref) {
		if (hasInlineCredentials(action) || action.credentials_configured) {
			throw new Error(
				"webhook_out: inline credentials must be sealed before execution",
			);
		}
		return {};
	}
	const encryptionKey = ctx.env.ENCRYPTION_KEY;
	if (typeof encryptionKey !== "string" || encryptionKey === "") {
		throw new Error("webhook_out: credential encryption is unavailable");
	}
	return loadAutomationWebhookSecret(ctx.db, encryptionKey, {
		id: action.secret_ref,
		organizationId: ctx.organizationId,
		automationId: ctx.automationId,
		actionId: action.id,
	});
}

const webhookOut: ActionHandler<WebhookOutAction> = async (action, ctx) => {
	const secret = await resolveSecretBundle(action, ctx);
	const mergeCtx = buildMergeCtx(ctx);
	const url = applyMergeTags(secret.url ?? action.url, mergeCtx);
	const method = action.method ?? "POST";
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(secret.headers ?? {})) {
		headers[k] = applyMergeTags(v, mergeCtx);
	}
	const hasConfiguredIdempotencyKey = Object.keys(headers).some(
		(key) => key.toLowerCase() === "idempotency-key",
	);
	const body = secret.body ? applyMergeTags(secret.body, mergeCtx) : undefined;
	if (body && bodyByteLength(body) > MAX_WEBHOOK_BODY_BYTES) {
		throw new Error("webhook_out: request body exceeds 256 KiB");
	}

	const auth = {
		...(action.auth ?? { mode: "none" as const }),
		...(secret.auth ?? {}),
	};
	if (auth.mode === "bearer" && auth.token) {
		headers.Authorization = `Bearer ${auth.token}`;
	} else if (auth.mode === "basic" && auth.username != null) {
		const pair = `${auth.username}:${auth.password ?? ""}`;
		headers.Authorization = `Basic ${base64(pair)}`;
	} else if (auth.mode === "hmac") {
		// Throw rather than silently sending unsigned — this surfaces a
		// misconfigured action through the enclosing action_group's `on_error`
		// setting instead of shipping a request the receiver will reject anyway.
		if (!auth.secret) {
			throw new Error("webhook_out: hmac auth requires secret");
		}
		const signed = body ?? "";
		const sig = await hmacSha256Hex(auth.secret, signed);
		headers["X-Signature"] = `sha256=${sig}`;
	}

	const dispatch = async (
		providerIdempotencyKey = ctx.effectIdempotencyKeyFor?.(
			`action:${action.id}`,
		),
	) => {
		const requestHeaders = { ...headers };
		if (providerIdempotencyKey && !hasConfiguredIdempotencyKey) {
			requestHeaders["Idempotency-Key"] = providerIdempotencyKey;
		}
		let response: Response;
		try {
			response = await fetchPublicUrl(url, {
				method,
				headers: requestHeaders,
				body,
				timeout: 15_000,
			});
		} catch (error) {
			if (error instanceof BlockedPublicUrlError) {
				throw new AutomationExternalEffectKnownFailureError(error.message);
			}
			throw error;
		}
		await response.body?.cancel();
		if (!response.ok) {
			if (response.status >= 500) {
				throw new Error(`webhook_out: ambiguous HTTP ${response.status}`);
			}
			throw new AutomationExternalEffectKnownFailureError(
				`webhook_out: rejected HTTP ${response.status}`,
			);
		}
		return { status: response.status };
	};

	if (ctx.executeExternalEffect) {
		await ctx.executeExternalEffect(
			{
				effectKey: `action:${action.id}`,
				kind: "automation_action",
			},
			async (providerIdempotencyKey) => ({
				outcome: "succeeded",
				value: await dispatch(providerIdempotencyKey),
			}),
		);
	} else {
		await dispatch();
	}
};

export const webhookHandlers: ActionRegistry = {
	webhook_out: webhookOut,
};
