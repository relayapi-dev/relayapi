import { afterEach, describe, expect, it } from "bun:test";
import { beehiivPublisher } from "../publishers/beehiiv";
import type {
	ProviderEffect,
	PublishResult,
	ReconcileRequest,
} from "../publishers/types";

const originalFetch = globalThis.fetch;
const createEffect: ProviderEffect = {
	name: "create_post",
	status: "succeeded",
	provider_id: "post_official",
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function request(overrides: Partial<ReconcileRequest> = {}): ReconcileRequest {
	return {
		account: {
			id: "acc_beehiiv",
			platform: "beehiiv",
			access_token: "beehiiv-token",
			refresh_token: null,
			platform_account_id: "pub_official",
			username: "Relay newsletter",
		},
		provider_operation_id: "post_official",
		platform_post_id: "post_official",
		provider_state: "post_creation_processing",
		effects: [createEffect],
		...overrides,
	};
}

async function reconcile(
	response: Response,
	overrides = {},
): Promise<PublishResult> {
	globalThis.fetch = (async () => response) as unknown as typeof fetch;
	if (!beehiivPublisher.reconcile) {
		throw new Error("Beehiiv reconciler is not registered");
	}
	return beehiivPublisher.reconcile(request(overrides));
}

describe("Beehiiv official Show Post lifecycle", () => {
	it("maps a confirmed post whose publish date has passed to published", async () => {
		const result = await reconcile(
			Response.json({
				data: {
					id: "post_official",
					status: "confirmed",
					publish_date: Math.floor(Date.now() / 1000) - 60,
					web_url: "https://relay.example/post/official",
				},
			}),
		);

		expect(result.success).toBe(true);
		expect(result.provider_outcome).toMatchObject({
			disposition: "published",
			provider_operation_id: "post_official",
			platform_post_id: "post_official",
			provider_state: "confirmed",
			effects: [createEffect],
		});
	});

	it("keeps a confirmed future post scheduled at Beehiiv's canonical publish date", async () => {
		const publishDate = Math.floor(Date.now() / 1000) + 3_600;
		const result = await reconcile(
			Response.json({
				data: {
					id: "post_official",
					status: "confirmed",
					publish_date: publishDate,
					preview_url: "https://app.beehiiv.com/posts/post_official/preview",
				},
			}),
			{ provider_state: "scheduled:2099-01-01T00:00:00.000Z" },
		);

		expect(result.provider_outcome).toMatchObject({
			disposition: "scheduled",
			provider_state: "confirmed",
			next_reconcile_at: new Date(publishDate * 1000).toISOString(),
			effects: [createEffect],
		});
	});

	for (const transcript of [
		{
			status: "draft",
			code: "PROVIDER_DRAFT_REQUIRES_MANUAL_ACTION",
		},
		{ status: "archived", code: "PROVIDER_ARCHIVED" },
	] as const) {
		it(`never reports the official ${transcript.status} status as published`, async () => {
			const result = await reconcile(
				Response.json({
					data: {
						id: "post_official",
						status: transcript.status,
						publish_date: Math.floor(Date.now() / 1000) - 60,
					},
				}),
			);

			expect(result.success).toBe(false);
			expect(result.platform_post_id).toBe("post_official");
			expect(result.error?.code).toBe(transcript.code);
			expect(result.provider_outcome).toMatchObject({
				disposition: "failed",
				platform_post_id: "post_official",
				provider_state: transcript.status,
				effects: [createEffect],
			});
		});
	}

	it("honors the documented HTTP 202 asynchronous-build response", async () => {
		const result = await reconcile(
			new Response(null, {
				status: 202,
				headers: { "Retry-After": "9" },
			}),
		);

		expect(result.provider_outcome).toMatchObject({
			disposition: "processing",
			platform_post_id: "post_official",
			effects: [createEffect],
		});
		expect(
			Date.parse(result.provider_outcome?.next_reconcile_at ?? ""),
		).toBeGreaterThan(Date.now() + 8_000);
	});

	it("keeps a defensive processing body nonterminal and retries unknown statuses", async () => {
		const processing = await reconcile(
			Response.json({
				data: { id: "post_official", status: "processing" },
			}),
		);
		expect(processing.provider_outcome?.disposition).toBe("processing");

		const unknown = await reconcile(
			Response.json({
				data: { id: "post_official", status: "provider_rollout_state" },
			}),
		);
		expect(unknown.success).toBe(false);
		expect(unknown.error?.code).toBe("PUBLISH_OUTCOME_UNKNOWN");
		expect(unknown.provider_outcome).toMatchObject({
			disposition: "outcome_unknown",
			platform_post_id: "post_official",
			provider_state: "provider_rollout_state",
			effects: [createEffect],
		});
	});
});
