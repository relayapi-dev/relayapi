import { fetchAndStoreAdMetrics } from "../services/ad-analytics";
import { addUsersToAudience } from "../services/ad-audience";
import { AdPlatformError } from "../services/ad-platforms/types";
import { boostPost, createAd } from "../services/ad-service";
import { syncExternalAds } from "../services/ad-sync";
import type { Env } from "../types";

interface AdsMessage {
	type: string;
	org_id: string;
	ad_account_id?: string;
	ad_id?: string;
	audience_id?: string;
	params?: any;
	/** Explicit metrics window for sync_external (manual full refresh = 30). */
	window_days?: number;
}

export async function consumeAdsQueue(
	batch: MessageBatch<AdsMessage>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body;

		try {
			switch (body.type) {
				case "create_ad": {
					await createAd(env, body.org_id, body.params);
					break;
				}
				case "boost_post": {
					await boostPost(env, body.org_id, body.params);
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
							thirtyDaysAgo.toISOString().split("T")[0]!,
							now.toISOString().split("T")[0]!,
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
							body.params.users,
						);
					}
					break;
				}
				default:
					console.warn(`[Ads] Unknown message type: ${body.type}`);
			}
			message.ack();
		} catch (err) {
			console.error(`[Ads] Queue processing failed for ${body.type}:`, err);
			// create_ad / boost_post are NOT idempotent: createAd/boostPost create a
			// live campaign + ad on the platform (spending real budget) before the DB
			// rows are written, with no idempotency key. A retry after a transient
			// failure would create a SECOND active campaign that spends money while the
			// first is orphaned. Until ad-service.ts adds a check-before-create /
			// idempotency key (see coordination note), never auto-retry these — drop so
			// the operation can be re-driven explicitly rather than duplicated silently.
			const isNonIdempotent =
				body.type === "create_ad" || body.type === "boost_post";
			if (err instanceof AdPlatformError && err.code === "INVALID_STATE") {
				console.warn(
					`[Ads] ${body.type} requires reconnect; dropping without retry`,
				);
				message.ack();
			} else if (isNonIdempotent) {
				console.error(
					`[Ads] ${body.type} failed and is not idempotent; dropping without retry to avoid duplicate paid campaigns`,
				);
				message.ack();
			} else if (message.attempts < 3) {
				const delaySeconds = 2 ** message.attempts;
				message.retry({ delaySeconds });
			} else {
				console.error(`[Ads] Max retries exceeded for ${body.type}, dropping`);
				message.ack();
			}
		}
	}
}
