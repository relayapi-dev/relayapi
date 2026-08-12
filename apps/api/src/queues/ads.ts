import {
	exponentialBackoffSeconds,
	QUEUE_DELIVERY_RETRY,
} from "../lib/async-policy";
import {
	type AdvancedAdReportQueueMessage,
	processAdvancedAdReportJob,
} from "../services/ad-report-jobs";
import { syncAdMetrics, syncExternalAds } from "../services/ad-sync";
import type { Env } from "../types";
import { recordQueueFailure } from "./failures";

interface AdsSyncMessage {
	type: "sync_metrics" | "sync_external";
	org_id: string;
	ad_account_id?: string;
	ad_id?: string;
	/** Explicit metrics window for sync_external (manual full refresh = 30). */
	window_days?: number;
	sync_generation?: number;
	metrics_poll_generation?: number;
}

type AdsMessage = AdsSyncMessage | AdvancedAdReportQueueMessage;

function isAdsMessage(value: unknown): value is AdsMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	if (typeof body.org_id !== "string" || body.org_id.length === 0) return false;
	if (body.type === "sync_metrics") {
		return typeof body.ad_id === "string" && body.ad_id.length > 0;
	}
	if (body.type === "sync_external") {
		return (
			typeof body.ad_account_id === "string" && body.ad_account_id.length > 0
		);
	}
	if (body.type === "advanced_report") {
		return (
			typeof body.report_job_id === "string" &&
			body.report_job_id.length > 0 &&
			Object.keys(body).every((key) =>
				["type", "org_id", "report_job_id"].includes(key),
			)
		);
	}
	return false;
}

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
				case "sync_metrics": {
					await syncAdMetrics(env, {
						organizationId: body.org_id,
						adId: body.ad_id as string,
						pollGeneration: body.metrics_poll_generation,
						windowDays: body.window_days,
					});
					break;
				}
				case "sync_external": {
					// window_days is set by manual triggers (full 30-day refresh);
					// the recurring cron omits it and uses the time-based heuristic.
					await syncExternalAds(
						env,
						body.ad_account_id as string,
						body.org_id,
						{
							windowDays: body.window_days,
							syncGeneration: body.sync_generation,
						},
					);
					break;
				}
				case "advanced_report": {
					await processAdvancedAdReportJob(env, {
						organizationId: body.org_id,
						reportJobId: body.report_job_id,
					});
					break;
				}
			}
			message.ack();
		} catch {
			if (message.attempts < 3) {
				const delaySeconds = exponentialBackoffSeconds(
					message.attempts,
					QUEUE_DELIVERY_RETRY,
					`${message.id}:${message.attempts}`,
				);
				message.retry({ delaySeconds });
			} else {
				message.retry({ delaySeconds: 60 });
			}
		}
	}
}
