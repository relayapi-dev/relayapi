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
						await syncExternalAds(env, body.ad_account_id, body.org_id);
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
			if (err instanceof AdPlatformError && err.code === "INVALID_STATE") {
				console.warn(
					`[Ads] ${body.type} requires reconnect; dropping without retry`,
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
