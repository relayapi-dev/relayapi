// apps/api/src/services/automations/nodes/http-request.ts
//
// Outbound HTTP request node. See spec §8.9.
//
// Resolves merge tags in URL / headers / body, performs a fetch() with a
// configurable timeout, and routes via `success` (2xx) or `error` (non-2xx /
// timeout / network). The response (status + headers + parsed body) is stored
// in `ctx.context[response_key]` (default "last_http_response") so downstream
// nodes can branch on it via the condition/filter engine.

import { applyMergeTags } from "../merge-tags";
import type { NodeHandler } from "../types";

type HttpRequestConfig = {
	url: string;
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	headers?: Record<string, string>;
	body?: string;
	timeout_ms?: number;
	response_key?: string;
};

function buildMergeCtx(ctx: any) {
	return {
		contact: (ctx.context?.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context ?? {},
	};
}

export const httpRequestHandler: NodeHandler<HttpRequestConfig> = {
	kind: "http_request",
	async handle(node, ctx) {
		const cfg = (node.config ?? {}) as HttpRequestConfig;
		const mergeCtx = buildMergeCtx(ctx);

		const url = applyMergeTags(cfg.url ?? "", mergeCtx);
		const method = cfg.method ?? "POST";
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(cfg.headers ?? {})) {
			headers[k] = applyMergeTags(v, mergeCtx);
		}
		const body = cfg.body ? applyMergeTags(cfg.body, mergeCtx) : undefined;

		const timeoutMs = cfg.timeout_ms ?? 15_000;
		const responseKey = cfg.response_key ?? "last_http_response";

		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeoutMs);

		try {
			const res = await fetch(url, {
				method,
				headers,
				body,
				signal: abort.signal,
			});
			const text = await res.text();
			let parsed: unknown = text;
			try {
				parsed = JSON.parse(text);
			} catch {
				// keep text body as-is
			}

			const headerObj: Record<string, string> = {};
			res.headers.forEach((value, key) => {
				headerObj[key] = value;
			});

			ctx.context[responseKey] = {
				status: res.status,
				headers: headerObj,
				body: parsed,
			};

			const viaPort = res.ok ? "success" : "error";
			return {
				result: "advance",
				via_port: viaPort,
				payload: { status: res.status, url, method },
			};
		} catch (err: unknown) {
			const e = err as { name?: string; message?: string };
			const isTimeout = e?.name === "AbortError";
			const msg = isTimeout ? "timeout" : String(e?.message ?? err);
			ctx.context[responseKey] = { error: msg };
			return {
				result: "advance",
				via_port: "error",
				payload: { error: msg, url, method },
			};
		} finally {
			clearTimeout(timer);
		}
	},
};
