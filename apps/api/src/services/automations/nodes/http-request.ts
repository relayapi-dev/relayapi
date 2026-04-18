import { contacts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { fetchWithTimeout } from "../../../lib/fetch-timeout";
import { resolveTemplatedValue } from "../resolve-templated-value";
import type { NodeHandler } from "../types";

export const httpRequestHandler: NodeHandler = async (ctx) => {
	const contact = ctx.enrollment.contact_id
		? await ctx.db.query.contacts.findFirst({
				where: eq(contacts.id, ctx.enrollment.contact_id),
			})
		: null;
	const templateCtx = {
		contact: (contact as Record<string, unknown> | null | undefined) ?? null,
		state: ctx.enrollment.state,
	};

	const url = resolveTemplatedValue(
		ctx.node.config.url,
		templateCtx,
	) as string | undefined;
	if (!url) return { kind: "fail", error: "http_request missing 'url'" };

	const method =
		(resolveTemplatedValue(ctx.node.config.method, templateCtx) as string | undefined) ??
		"POST";
	const headers =
		(resolveTemplatedValue(
			ctx.node.config.headers ?? {},
			templateCtx,
		) as Record<string, string>) ?? {};
	const body = resolveTemplatedValue(ctx.node.config.body, templateCtx);
	const timeoutMs = (ctx.node.config.timeout_ms as number | undefined) ?? 10000;
	const saveToField = ctx.node.config.save_response_to_field as
		| string
		| undefined;
	const jsonPath = ctx.node.config.json_path as string | undefined;

	let response: Response;
	try {
		response = await fetchWithTimeout(url, {
			method,
			headers: {
				"Content-Type": "application/json",
				...headers,
			},
			body:
				body === undefined
					? undefined
					: typeof body === "string"
						? body
						: JSON.stringify(body),
			timeout: timeoutMs,
		});
	} catch (e) {
		return { kind: "fail", error: `http_request: ${String(e)}` };
	}

	if (!response.ok) {
		return {
			kind: "fail",
			error: `http_request ${response.status}: ${await response.text().catch(() => "")}`,
		};
	}

	let extracted: unknown = undefined;
	if (saveToField) {
		const text = await response.text();
		let parsed: unknown = text;
		try {
			parsed = JSON.parse(text);
		} catch {
			// leave as text
		}
		extracted = jsonPath ? extractJsonPath(parsed, jsonPath) : parsed;
	}

	return {
		kind: "next",
		state_patch: saveToField ? { [saveToField]: extracted } : undefined,
	};
};

function extractJsonPath(obj: unknown, path: string): unknown {
	if (path === "$" || path === "") return obj;
	const cleaned = path.replace(/^\$\.?/, "");
	let cur: unknown = obj;
	for (const key of cleaned.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}
