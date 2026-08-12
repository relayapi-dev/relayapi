import {
	getCurrentAdapter,
	runWithTransaction,
} from "@better-auth/core/context";

type TransactionAdapter = Parameters<typeof runWithTransaction>[0];

export interface TransactionalEndpointContext {
	context: { adapter: TransactionAdapter };
}

type EndpointMetadata = {
	path?: unknown;
	method?: unknown;
	options?: unknown;
	headers?: unknown;
};

/**
 * Run every adapter operation issued by a Better Auth endpoint through one
 * adapter transaction while preserving the endpoint metadata used by routing,
 * type inference, and OpenAPI generation.
 */
export function wrapEndpointInTransaction<
	Context extends TransactionalEndpointContext,
	Result,
>(
	endpoint: ((context: Context) => Promise<Result>) & EndpointMetadata,
	afterCommit?: (context: Context, result: Result) => Promise<void>,
): ((context: Context) => Promise<Result>) & EndpointMetadata {
	const wrapped = async (context: Context): Promise<Result> => {
		const baseAdapter = context.context.adapter;
		const result = await runWithTransaction(baseAdapter, async () => {
			// Most Better Auth helpers consult AsyncLocalStorage, but a few plugin
			// paths call ctx.context.adapter directly. Point both access paths at the
			// same transaction adapter for the complete endpoint lifetime.
			context.context.adapter = (await getCurrentAdapter(
				baseAdapter,
			)) as TransactionAdapter;
			try {
				return await endpoint(context);
			} finally {
				context.context.adapter = baseAdapter;
			}
		});
		try {
			await afterCommit?.(context, result);
		} catch {
			// The endpoint transaction is already committed. Returning an error here
			// would invite the caller to retry a mutation that actually succeeded.
			// Post-commit effects must therefore be retry-safe/best-effort and emit a
			// sanitized signal without changing the authoritative response.
			console.error(
				JSON.stringify({
					event: "post_commit_endpoint_effect_failed",
					endpoint_path:
						typeof endpoint.path === "string" ? endpoint.path : undefined,
				}),
			);
		}
		return result;
	};
	return Object.assign(wrapped, endpoint);
}
