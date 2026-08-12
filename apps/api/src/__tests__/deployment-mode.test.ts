import { describe, expect, test } from "bun:test";
import {
	deploymentEntitlements,
	appPublicOrigin,
	isSelfHosted,
	mediaPublicHost,
	selfHostedFeatureEnabled,
	thumbnailPublicHost,
} from "../lib/deployment-mode";
import type { Env } from "../types";

function env(overrides: Partial<Env> = {}): Env {
	return overrides as Env;
}

describe("self-hosted deployment mode", () => {
	test("is opt-in and grants community entitlements", () => {
		const selfHosted = env({
			DEPLOYMENT_MODE: "self_hosted",
			SELF_HOSTED_FEATURE_AI: "1",
		});
		expect(isSelfHosted(selfHosted)).toBe(true);
		expect(deploymentEntitlements(selfHosted)).toMatchObject({
			plan: "pro",
			aiEnabled: true,
		});
	});

	test("does not grant self-host features in hosted mode", () => {
		const hosted = env({
			DEPLOYMENT_MODE: "hosted",
			SELF_HOSTED_FEATURE_AI: "1",
		});
		expect(deploymentEntitlements(hosted)).toBeNull();
		expect(selfHostedFeatureEnabled(hosted, "ai")).toBe(false);
	});

	test("uses instance-specific media hosts", () => {
		const selfHosted = env({
			MEDIA_PUBLIC_HOST: "media.example.com",
			THUMBNAIL_PUBLIC_HOST: "thumbs.example.com",
		});
		expect(mediaPublicHost(selfHosted)).toBe("media.example.com");
		expect(thumbnailPublicHost(selfHosted)).toBe("thumbs.example.com");
	});

	test("uses the configured app origin for OAuth customer redirects", () => {
		expect(
			appPublicOrigin(env({ APP_BASE_URL: "https://app.example.com/path" })),
		).toBe("https://app.example.com");
	});
});
