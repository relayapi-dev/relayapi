import { fetchAndStoreAdMetrics } from "../services/ad-analytics";
import { addUsersToAudience } from "../services/ad-audience";
import { AdPlatformError } from "../services/ad-platforms/types";
import { boostPost, createAd } from "../services/ad-service";
import { syncExternalAds } from "../services/ad-sync";
import type { Env } from "../types";
import { recordQueueFailure } from "./failures";

interface AdsMessage {
	type: string;
	org_id: string;
	ad_account_id?: string;
	ad_id?: string;
	audience_id?: string;
	params?: Record<string, unknown>;
	operation_id?: string;
	/** Explicit metrics window for sync_external (manual full refresh = 30). */
	window_days?: number;
}

function isAdsMessage(value: unknown): value is AdsMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	return (
		typeof body.type === "string" &&
		body.type.length > 0 &&
		typeof body.org_id === "string" &&
		body.org_id.length > 0
	);
}

const PAID_OPERATION_TYPES = new Set(["create_ad", "boost_post"]);
const AMBIGUOUS_PAID_OPERATION_CODES = new Set([
	"UNKNOWN_EXTERNAL_OUTCOME",
	"MANUAL_REVIEW_REQUIRED",
]);
const PERMANENT_PAID_OPERATION_CODES = new Set([
	"IDEMPOTENCY_KEY_REQUIRED",
	"IDEMPOTENCY_KEY_REUSED",
	"INVALID_STATE",
	"MISSING_CAMPAIGN",
	"MISSING_OBJECTIVE",
	"NOT_FOUND",
	"OPERATION_RESULT_MISSING",
	"UNSUPPORTED_PLATFORM",
]);

export async function consumeAdsQueue(
	batch: MessageBatch<AdsMessage>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		if (!isAdsMessage(message.body)) {
			await recordQueueFailure(
				env,
				batch.queue,
				message,
				"permanent_input",
				"Invalid ads queue payload",
			);
			message.ack();
			continue;
		}
		const body = message.body;

		try {
			switch (body.type) {
				case "create_ad": {
					await createAd(env, body.org_id, {
						...(body.params as Parameters<typeof createAd>[2]),
						// Cloudflare preserves the message id across redelivery. It is
						// the stable durable-operation key that suppresses paid replay.
						operationKey: body.operation_id ?? message.id,
					});
					break;
				}
				case "boost_post": {
					await boostPost(env, body.org_id, {
						...(body.params as Parameters<typeof boostPost>[2]),
						operationKey: body.operation_id ?? message.id,
					});
					break;
				}
				case "sync_metrics": {
					if (body.ad_id) {
						const now = new Date();
						const thirtyDaysAgo = new Date(
							now.getTime() - 30 * 24 * 60 * 60 * 1000,
						);
						await fetchAndStoreAdMetrics(
							env,
							body.ad_id,
							thirtyDaysAgo.toISOString().split("T")[0] ?? "",
							now.toISOString().split("T")[0] ?? "",
						);
					}
					break;
				}
				case "sync_external": {
					if (body.ad_account_id) {
						// window_days is set by manual triggers (full 30-day refresh);
						// the recurring cron omits it and uses the time-based heuristic.
						await syncExternalAds(env, body.ad_account_id, body.org_id, {
							windowDays: body.window_days,
						});
					}
					break;
				}
				case "upload_audience_users": {
					if (body.audience_id && body.params?.users) {
						await addUsersToAudience(
							env,
							body.org_id,
							body.audience_id,
							body.params.users as Parameters<typeof addUsersToAudience>[3],
						);
					}
					break;
				}
				default:
					console.warn(`[Ads] Unknown message type: ${body.type}`);
					await recordQueueFailure(
						env,
						batch.queue,
						message,
						"permanent_input",
						`Unknown ads message type: ${body.type}`,
					);
			}
			message.ack();
		} catch (err) {
			console.error(`[Ads] Queue processing failed for ${body.type}:`, err);
			// Paid creation is guarded by a durable operation keyed by message.id. A
			// redelivery can safely reclaim a pre-provider `failed` operation; after a
			// provider boundary, beginAdCreationOperation refuses the replay and surfaces
			// UNKNOWN_EXTERNAL_OUTCOME instead of spending twice.
			const isPaidOperation = PAID_OPERATION_TYPES.has(body.type);
			if (
				isPaidOperation &&
				err instanceof AdPlatformError &&
				PERMANENT_PAID_OPERATION_CODES.has(err.code)
			) {
				console.warn(
					`[Ads] ${body.type} has permanent input/state error ${err.code}; not retrying`,
				);
				await recordQueueFailure(
					env,
					batch.queue,
					message,
					"permanent_input",
					err,
				);
				message.ack();
			} else if (
				isPaidOperation &&
				err instanceof AdPlatformError &&
				AMBIGUOUS_PAID_OPERATION_CODES.has(err.code)
			) {
				console.error(
					`[Ads] ${body.type} has an ambiguous paid-provider outcome; reconciliation is required`,
				);
				await recordQueueFailure(
					env,
					batch.queue,
					message,
					"unknown_external_outcome",
					err,
				);
				message.ack();
			} else if (isPaidOperation) {
				// This includes raw provider errors from the first boundary-crossing
				// attempt. The durable operation was already moved to `unknown`, so the
				// redelivery performs no provider create and is ACKed by the branch above.
				message.retry({ delaySeconds: 2 ** message.attempts });
			} else if (message.attempts < 3) {
				const delaySeconds = 2 ** message.attempts;
				message.retry({ delaySeconds });
			} else {
				console.error(
					`[Ads] Max retries exceeded for ${body.type}; sending to DLQ`,
				);
				message.retry({ delaySeconds: 60 });
			}
		}
	}
}
