export const GOVERNANCE_REVIEWED_AT = "2026-07-28";
export const GOVERNANCE_REVIEW_EXPIRES_AT = "2027-07-28";

export interface GovernanceReview {
	readonly owner: string;
	readonly reviewedAt: string;
	readonly reviewExpiresAt: string;
}

function parseDateOnly(value: string): Date | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Governance decisions are deliberately fail-closed: a missing owner, invalid
 * date, review window longer than twelve calendar months, or expired review
 * blocks the schema freeze until a human re-reviews the decision.
 */
export function validateGovernanceReview(
	label: string,
	review: GovernanceReview,
	now = new Date(),
): string[] {
	const failures: string[] = [];
	if (review.owner.trim().length === 0) {
		failures.push(`${label} has no accountable owner`);
	}
	const reviewedAt = parseDateOnly(review.reviewedAt);
	const expiresAt = parseDateOnly(review.reviewExpiresAt);
	if (!reviewedAt) failures.push(`${label} has an invalid reviewedAt`);
	if (!expiresAt) failures.push(`${label} has an invalid reviewExpiresAt`);
	if (!reviewedAt || !expiresAt) return failures;

	const maximumExpiry = new Date(reviewedAt);
	maximumExpiry.setUTCFullYear(maximumExpiry.getUTCFullYear() + 1);
	if (expiresAt <= reviewedAt) {
		failures.push(`${label} reviewExpiresAt must be after reviewedAt`);
	}
	if (expiresAt > maximumExpiry) {
		failures.push(`${label} governance review exceeds twelve months`);
	}
	if (expiresAt <= now) {
		failures.push(`${label} governance review has expired`);
	}
	return failures;
}
