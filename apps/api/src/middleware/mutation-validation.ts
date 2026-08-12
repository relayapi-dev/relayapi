import type { OpenAPIHonoOptions } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import type { Env, Variables } from "../types";

type ApiEnvironment = { Bindings: Env; Variables: Variables };
type ApiContext = Context<ApiEnvironment>;

/**
 * Record exact pre-effect rejection evidence for the request's usage
 * reservation. Callers must use this only before customer-visible mutation
 * code can run.
 */
export function markMutationInputNotApplied(c: ApiContext): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "not_applied",
	});
}

/**
 * Return an already-built rejection while recording the same exact K=0 proof.
 * This keeps shared authorization/preflight helpers expression-friendly.
 */
export function returnMutationInputNotApplied<T>(
	c: ApiContext,
	response: T,
): T {
	markMutationInputNotApplied(c);
	return response;
}

/**
 * OpenAPI validators execute before their route handler. A failed schema parse
 * therefore proves K=0 even for routes whose later provider/R2 effects make
 * their general 4xx outcome intentionally ambiguous.
 *
 * Returning void preserves @hono/zod-openapi's existing validation response.
 */
export const openApiMutationValidationHook: NonNullable<
	OpenAPIHonoOptions<ApiEnvironment>["defaultHook"]
> = (result, c) => {
	if (!result.success) markMutationInputNotApplied(c);
};

/**
 * Hono's FormData parser throws before the OpenAPI hook runs. Install this only
 * on a route whose handler already consumes FormData and whose parser runs
 * before every customer-visible effect. Hono caches the parsed body, so the
 * downstream validator/handler does not parse or buffer it a second time.
 */
export const multipartMutationInputPreflight: MiddlewareHandler<
	ApiEnvironment
> = async (c, next) => {
	try {
		await c.req.formData();
	} catch {
		markMutationInputNotApplied(c);
		return c.text("Malformed FormData request.", 400);
	}
	await next();
};
