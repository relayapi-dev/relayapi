export const AD_BUDGET_MAX_MINOR_UNITS = 2_147_483_647;

/**
 * The public contract calls ad budgets "cents", so hosted mutations currently
 * support only provider currencies whose ISO minor-unit exponent is exactly 2.
 * `Intl` is the runtime's maintained ISO-4217 exponent table.
 */
export function normalizeSupportedAdCurrency(
	currency: string | null | undefined,
): string | null {
	const normalized = currency?.trim().toUpperCase();
	if (!normalized || !/^[A-Z]{3}$/.test(normalized)) return null;
	try {
		const resolved = new Intl.NumberFormat("en", {
			style: "currency",
			currency: normalized,
		}).resolvedOptions();
		return resolved.minimumFractionDigits === 2 &&
			resolved.maximumFractionDigits === 2
			? normalized
			: null;
	} catch {
		return null;
	}
}

export function isSafeAdBudget(value: number | undefined): boolean {
	return (
		value === undefined ||
		(Number.isSafeInteger(value) &&
			value > 0 &&
			value <= AD_BUDGET_MAX_MINOR_UNITS)
	);
}

export type AdCreationProviderEvidence = {
	kind: string;
	requestPayload: unknown;
	platformCampaignId: string | null;
	platformAdSetId: string | null;
	platformCreativeId: string | null;
	platformAdId: string | null;
};

export function adCreationUsesExistingCampaign(
	row: Pick<AdCreationProviderEvidence, "kind" | "requestPayload">,
): boolean {
	const request = row.requestPayload;
	return (
		row.kind === "create_ad" &&
		request !== null &&
		typeof request === "object" &&
		!Array.isArray(request) &&
		typeof (request as Record<string, unknown>).campaignId === "string"
	);
}

/** Inherited campaign/ad-set IDs are context, not proof of a provider effect. */
export function hasAdCreationProviderEffect(
	row: AdCreationProviderEvidence,
): boolean {
	return Boolean(
		row.platformCreativeId ||
			row.platformAdId ||
			(!adCreationUsesExistingCampaign(row) &&
				(row.platformCampaignId || row.platformAdSetId)),
	);
}
