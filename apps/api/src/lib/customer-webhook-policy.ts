/** Durable customer-webhook repair and operator-review horizons. */
export const CUSTOMER_WEBHOOK_REPAIR_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const CUSTOMER_WEBHOOK_MANUAL_REVIEW_DAYS = 90;
export const CUSTOMER_WEBHOOK_MANUAL_REVIEW_WINDOW_MS =
	CUSTOMER_WEBHOOK_MANUAL_REVIEW_DAYS * 24 * 60 * 60 * 1_000;

/**
 * The review clock starts at the persisted lifecycle anchor: the original
 * automatic-repair deadline for known-not-sent failures, or the recorded HTTP
 * boundary for ambiguous outcomes. Worker observation time never extends it.
 */
export function customerWebhookManualReviewUntil(anchorAt: Date): Date {
	return new Date(
		anchorAt.getTime() + CUSTOMER_WEBHOOK_MANUAL_REVIEW_WINDOW_MS,
	);
}
