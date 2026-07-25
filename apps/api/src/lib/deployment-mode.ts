import { PRICING } from "@relayapi/config";
import type { Env } from "../types";

type DeploymentEnv = Pick<
	Env,
	| "DEPLOYMENT_MODE"
	| "SELF_HOSTED_FEATURE_AI"
	| "SELF_HOSTED_FEATURE_EMAIL"
	| "SELF_HOSTED_FEATURE_DOWNLOADER"
	| "MEDIA_PUBLIC_HOST"
	| "THUMBNAIL_PUBLIC_HOST"
>;

export const SELF_HOSTED_CALLS_INCLUDED = Number.MAX_SAFE_INTEGER;
export const SELF_HOSTED_DAILY_TOOL_LIMIT = Number.MAX_SAFE_INTEGER;

export function isSelfHosted(
	env: Pick<DeploymentEnv, "DEPLOYMENT_MODE">,
): boolean {
	return env.DEPLOYMENT_MODE === "self_hosted";
}

export function selfHostedFeatureEnabled(
	env: DeploymentEnv,
	feature: "ai" | "email" | "downloader",
): boolean {
	if (!isSelfHosted(env)) return false;
	const value =
		feature === "ai"
			? env.SELF_HOSTED_FEATURE_AI
			: feature === "email"
				? env.SELF_HOSTED_FEATURE_EMAIL
				: env.SELF_HOSTED_FEATURE_DOWNLOADER;
	return value === "1";
}

export function mediaPublicHost(env: DeploymentEnv): string {
	return env.MEDIA_PUBLIC_HOST?.trim() || "media.relayapi.dev";
}

export function thumbnailPublicHost(env: DeploymentEnv): string {
	return env.THUMBNAIL_PUBLIC_HOST?.trim() || "thumbs.relayapi.dev";
}

export function appPublicOrigin(env: Pick<Env, "APP_BASE_URL">): string {
	return new URL(env.APP_BASE_URL?.trim() || "https://app.relayapi.dev").origin;
}

export function deploymentEntitlements(env: DeploymentEnv): {
	plan: "pro";
	callsIncluded: number;
	aiEnabled: boolean;
	dailyToolLimit: number;
} | null {
	if (!isSelfHosted(env)) return null;
	return {
		plan: "pro",
		callsIncluded: SELF_HOSTED_CALLS_INCLUDED,
		aiEnabled: selfHostedFeatureEnabled(env, "ai"),
		dailyToolLimit: SELF_HOSTED_DAILY_TOOL_LIMIT,
	};
}

export function defaultCallsIncluded(plan: "free" | "pro"): number {
	return plan === "pro" ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded;
}
