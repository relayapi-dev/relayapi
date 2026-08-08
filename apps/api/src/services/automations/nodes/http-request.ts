// apps/api/src/services/automations/nodes/http-request.ts
//
// Outbound HTTP request node. See spec §8.9.
//
// Resolves merge tags in URL / headers / body, performs a fetch() with a
// configurable timeout, and routes via `success` (2xx) or `error` (non-2xx /
// timeout / network). The response (status + headers + parsed body) is stored
// in `ctx.context[response_key]` (default "last_http_response") so downstream
// nodes can branch on it via the condition/filter engine.

import {
	BlockedPublicUrlError,
	fetchPublicUrl,
	readResponseBytes,
} from "../../../lib/fetch-public-url";
import { loadAutomationHttpRequestSecret } from "../graph-secrets";
import { applyMergeTags } from "../merge-tags";
import {
	AutomationExternalEffectKnownFailureError,
	isAutomationExternalEffectControlError,
	type NodeHandler,
	type RunContext,
} from "../types";

type HttpRequestConfig = {
	url: string;
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	headers?: Record<string, string>;
	body?: string;
	timeout_ms?: number;
	response_key?: string;
	secret_ref?: string;
	credentials_configured?: boolean;
};

const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1;
const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BODY_BYTES = 512 * 1024;
const MAX_REQUEST_HEADER_BYTES = 128 * 1024;

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function buildMergeCtx(ctx: RunContext) {
	return {
		contact:
			(ctx.context?.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context ?? {},
	};
}

export const httpRequestHandler: NodeHandler<HttpRequestConfig> = {
	kind: "http_request",
	async handle(node, ctx) {
		const cfg = (node.config ?? {}) as HttpRequestConfig;
		const mergeCtx = buildMergeCtx(ctx);
		if (!cfg.secret_ref) {
			throw new Error(
				"http_request: write-only request configuration is missing",
			);
		}
		const encryptionKey = ctx.env.ENCRYPTION_KEY;
		if (typeof encryptionKey !== "string" || encryptionKey === "") {
			throw new Error("http_request: credential encryption is unavailable");
		}
		const secret = await loadAutomationHttpRequestSecret(
			ctx.db,
			encryptionKey,
			{
				id: cfg.secret_ref,
				organizationId: ctx.organizationId,
				automationId: ctx.automationId,
				nodeKey: node.key,
			},
		);

		const url = applyMergeTags(secret.url ?? "", mergeCtx);
		const method = cfg.method ?? "POST";
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(secret.headers ?? {})) {
			headers[k] = applyMergeTags(v, mergeCtx);
		}
		const hasConfiguredIdempotencyKey = Object.keys(headers).some(
			(key) => key.toLowerCase() === "idempotency-key",
		);
		const body = secret.body
			? applyMergeTags(secret.body, mergeCtx)
			: undefined;

		const timeoutMs = Math.max(
			MIN_TIMEOUT_MS,
			Math.min(cfg.timeout_ms ?? 15_000, MAX_TIMEOUT_MS),
		);
		const responseKey = cfg.response_key ?? "last_http_response";
		if (body && byteLength(body) > MAX_REQUEST_BODY_BYTES) {
			throw new Error("http_request: request body exceeds 256 KiB");
		}
		const headerBytes = Object.entries(headers).reduce(
			(total, [key, value]) => total + byteLength(key) + byteLength(value),
			0,
		);
		if (headerBytes > MAX_REQUEST_HEADER_BYTES) {
			throw new Error("http_request: headers exceed 128 KiB");
		}

		try {
			const request = async (
				providerIdempotencyKey = ctx.effectIdempotencyKey,
			) => {
				const requestHeaders = { ...headers };
				if (providerIdempotencyKey && !hasConfiguredIdempotencyKey) {
					requestHeaders["Idempotency-Key"] = providerIdempotencyKey;
				}
				let res: Response;
				try {
					res = await fetchPublicUrl(url, {
						method,
						headers: requestHeaders,
						body,
						timeout: timeoutMs,
						timeoutThroughBody: true,
					});
				} catch (error) {
					if (error instanceof BlockedPublicUrlError) {
						throw new AutomationExternalEffectKnownFailureError(error.message);
					}
					throw error;
				}
				const text = new TextDecoder().decode(
					await readResponseBytes(res, MAX_RESPONSE_BODY_BYTES),
				);
				let parsed: unknown = text;
				try {
					parsed = JSON.parse(text);
				} catch {
					// keep text body as-is
				}

				const headerObj: Record<string, string> = {};
				res.headers.forEach((value, key) => {
					if (/(authorization|cookie|token|secret|api[-_]?key)/i.test(key)) {
						return;
					}
					headerObj[key] = value;
				});
				return {
					ok: res.ok,
					status: res.status,
					headers: headerObj,
					body: parsed,
				};
			};
			const observed = ctx.executeExternalEffect
				? await ctx.executeExternalEffect(
						{
							effectKey: `http-request:${node.key}`,
							kind: "http_request",
						},
						async (providerIdempotencyKey) => ({
							outcome: "succeeded" as const,
							value: await request(providerIdempotencyKey),
						}),
					)
				: await request();

			ctx.context[responseKey] = {
				status: observed.status,
				headers: observed.headers,
				body: observed.body,
			};

			const viaPort = observed.ok ? "success" : "error";
			return {
				result: "advance",
				via_port: viaPort,
				payload: { status: observed.status, method },
			};
		} catch (err: unknown) {
			if (isAutomationExternalEffectControlError(err)) throw err;
			const e = err as { name?: string; message?: string };
			const isTimeout = e?.name === "AbortError" || e?.name === "TimeoutError";
			const msg = isTimeout ? "timeout" : String(e?.message ?? err);
			ctx.context[responseKey] = { error: msg };
			return {
				result: "advance",
				via_port: "error",
				payload: { error: msg, method },
			};
		}
	},
};
