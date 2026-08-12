export const EMAIL_PROVIDER_MAX_ATTEMPTS = 6;
export const EMAIL_DELIVERY_DEADLINE_MS = 23 * 60 * 60 * 1_000;

/**
 * Return the next durable provider-attempt time, or `null` when an operator
 * must reconcile the occurrence. Cloudflare Queue delivery attempts are
 * deliberately absent: infrastructure redelivery is never an application
 * retry budget.
 */
export function nextEmailProviderAttemptAt(
	providerAttempts: number,
	now: Date,
	deadlineAt: Date,
): Date | null {
	if (
		!Number.isSafeInteger(providerAttempts) ||
		providerAttempts < 1 ||
		providerAttempts >= EMAIL_PROVIDER_MAX_ATTEMPTS ||
		now.getTime() >= deadlineAt.getTime()
	) {
		return null;
	}
	const delaySeconds = Math.min(3_600, 2 ** Math.min(providerAttempts, 10));
	const retryAt = new Date(now.getTime() + delaySeconds * 1_000);
	return retryAt.getTime() < deadlineAt.getTime() ? retryAt : null;
}
