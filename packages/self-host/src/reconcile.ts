import type { CloudflareClient } from "./cloudflare.js";
import { withResolvedHyperdriveCaCertificateId } from "./config.js";
import type { CloudflareResourcePlan, SelfHostConfig } from "./types.js";

export interface CloudflareReconciliationResult {
	config: SelfHostConfig;
	plan: CloudflareResourcePlan;
	applied: boolean;
}

/**
 * Plans resource reconciliation and persists the new operator intent only after
 * every Cloudflare mutation and convergence check has succeeded.
 */
export async function reconcileCloudflareResources(input: {
	config: SelfHostConfig;
	runtimeDatabaseUrl: string;
	client: Pick<CloudflareClient, "plan" | "apply">;
	dryRun: boolean;
	requestedCaCertificateId?: string;
	persist: (config: SelfHostConfig) => Promise<void>;
}): Promise<CloudflareReconciliationResult> {
	const reconciliationOptions = input.requestedCaCertificateId
		? { requestedCaCertificateId: input.requestedCaCertificateId }
		: {};
	const plan = await input.client.plan(
		input.config,
		input.runtimeDatabaseUrl,
		reconciliationOptions,
	);
	if (input.dryRun) {
		return { config: input.config, plan, applied: false };
	}

	const configForApply = withResolvedHyperdriveCaCertificateId(
		input.config,
		plan.hyperdrive.caCertificateId,
		{
			allowExplicitReplacement: input.requestedCaCertificateId !== undefined,
		},
	);
	const authorizedPriorCaCertificateId =
		input.config.cloudflare.hyperdriveCaCertificateId ??
		plan.hyperdrive.currentCaCertificateId;
	const applyOptions = {
		...reconciliationOptions,
		...(authorizedPriorCaCertificateId
			? {
					expectedCurrentCaCertificateId: authorizedPriorCaCertificateId,
				}
			: {}),
	};
	const resources = await input.client.apply(
		configForApply,
		input.runtimeDatabaseUrl,
		applyOptions,
	);
	const config = { ...configForApply, resources };
	await input.persist(config);
	return { config, plan, applied: true };
}
