import { describe, expect, it } from "bun:test";
import { classifyPublishError, PublishError } from "../publishers/types";
import {
	canRetryTokenExpiredPublish,
	classifyPersistedPostTargets,
	classifyPublishTaskRejection,
	DEFINITIVE_RATE_LIMIT_BASE_DELAY_MS,
	DEFINITIVE_RATE_LIMIT_MAX_DELAY_MS,
	DEFINITIVE_RATE_LIMIT_MAX_RETRIES,
	getDefinitiveRateLimitRetryDelay,
	PublishBoundaryError,
	requiresPublishOutcomeReconciliation,
} from "../services/publisher-runner";

describe("publisher exception outcome classification", () => {
	it("keeps pre-boundary failures definitive", () => {
		expect(
			classifyPublishTaskRejection(
				new PublishBoundaryError(new Error("token lookup failed"), false),
			),
		).toBe("PUBLISH_PREBOUNDARY_ERROR");
		expect(
			classifyPublishTaskRejection(new Error("unexpected setup error")),
		).toBe("PUBLISH_PREBOUNDARY_ERROR");
	});

	it("defaults post-boundary exceptions to unknown", () => {
		expect(
			classifyPublishTaskRejection(
				new PublishBoundaryError(new Error("connection reset"), true),
			),
		).toBe("PUBLISH_OUTCOME_UNKNOWN");
	});

	it("never terminalizes while a target is queued or in flight", () => {
		expect(
			classifyPersistedPostTargets([
				{ status: "published", deliveryState: "succeeded" },
				{ status: "publishing", deliveryState: "in_flight" },
			]),
		).toBe("active");
		expect(
			classifyPersistedPostTargets([
				{ status: "failed", deliveryState: "failed" },
				{ status: "publishing", deliveryState: "queued" },
			]),
		).toBe("active");
	});

	it("keeps ambiguous outcomes distinct from definitive failures", () => {
		expect(
			classifyPersistedPostTargets([
				{ status: "publishing", deliveryState: "unknown" },
			]),
		).toBe("unknown");
		expect(
			classifyPersistedPostTargets([
				{ status: "failed", deliveryState: "failed" },
			]),
		).toBe("failed");
	});

	it("requires explicit structured evidence before allowing a rate-limit retry", () => {
		const optedIn = classifyPublishError(
			new PublishError("RATE_LIMITED: slow down", {
				statusCode: 429,
				retryAfterMs: 1_000,
			}),
			{ safeToRetryRateLimit: true },
		);
		expect(optedIn.retry).toEqual({
			disposition: "safe_to_retry",
			after_ms: 1_000,
		});
		expect(optedIn.outcome).toBeUndefined();

		const notOptedIn = classifyPublishError(
			new PublishError("RATE_LIMITED: slow down", { statusCode: 429 }),
		);
		expect(notOptedIn.retry).toBeUndefined();

		const unstructured = classifyPublishError(
			new Error("RATE_LIMITED: outcome unknown"),
			{ safeToRetryRateLimit: true },
		);
		expect(unstructured.retry).toBeUndefined();
	});

	it("never marks a 5xx rate-limit response safe to replay", () => {
		const ambiguous = classifyPublishError(
			new PublishError(
				"RATE_LIMITED: provider failed after accepting request",
				{
					statusCode: 500,
				},
			),
			{ safeToRetryRateLimit: true },
		);

		expect(ambiguous.retry).toBeUndefined();
		expect(ambiguous.outcome).toBeUndefined();
		expect(requiresPublishOutcomeReconciliation(ambiguous)).toBe(true);
	});

	it("uses capped exponential delays only for definitive rejections", () => {
		const result = classifyPublishError(
			new PublishError("RATE_LIMITED: slow down", { statusCode: 429 }),
			{ safeToRetryRateLimit: true },
		);
		expect(getDefinitiveRateLimitRetryDelay(result, 0)).toBe(
			DEFINITIVE_RATE_LIMIT_BASE_DELAY_MS,
		);
		expect(getDefinitiveRateLimitRetryDelay(result, 1)).toBe(
			DEFINITIVE_RATE_LIMIT_BASE_DELAY_MS * 2,
		);
		expect(
			getDefinitiveRateLimitRetryDelay(
				{
					...result,
					retry: {
						disposition: "safe_to_retry",
						after_ms: DEFINITIVE_RATE_LIMIT_MAX_DELAY_MS + 1,
					},
				},
				0,
			),
		).toBeNull();
		expect(
			getDefinitiveRateLimitRetryDelay(
				result,
				DEFINITIVE_RATE_LIMIT_MAX_RETRIES,
			),
		).toBeNull();
		expect(
			getDefinitiveRateLimitRetryDelay(
				{
					success: false,
					error: { code: "RATE_LIMITED", message: "ambiguous" },
				},
				0,
			),
		).toBeNull();
	});

	it("terminalizes exhausted definitive 429s without replaying ambiguous ones", () => {
		const definitive = classifyPublishError(
			new PublishError("RATE_LIMITED: rejected", { statusCode: 429 }),
			{ safeToRetryRateLimit: true },
		);
		expect(requiresPublishOutcomeReconciliation(definitive)).toBe(false);

		expect(
			requiresPublishOutcomeReconciliation({
				success: false,
				error: { code: "RATE_LIMITED", message: "possibly partial" },
			}),
		).toBe(true);
	});

	it("terminalizes a structured HTTP 400 from a definitive publish boundary", () => {
		const rejected = classifyPublishError(
			new PublishError("Provider rejected payload", { statusCode: 400 }),
			{ definitiveHttpRejection: true },
		);
		expect(rejected.outcome).toEqual({
			disposition: "definitive_rejection",
		});
		expect(requiresPublishOutcomeReconciliation(rejected)).toBe(false);

		const ambiguous = classifyPublishError(
			new PublishError("Provider connection failed", { statusCode: 500 }),
			{ definitiveHttpRejection: true },
		);
		expect(ambiguous.outcome).toBeUndefined();
		expect(requiresPublishOutcomeReconciliation(ambiguous)).toBe(true);
	});

	it("refreshes a multi-post token only after a definitive first-item rejection", () => {
		const definitive = classifyPublishError(
			new PublishError("TOKEN_EXPIRED: expired", { statusCode: 401 }),
			{ definitiveHttpRejection: true },
		);
		expect(canRetryTokenExpiredPublish(definitive, true)).toBe(true);
		expect(
			canRetryTokenExpiredPublish(
				{
					success: false,
					error: { code: "TOKEN_EXPIRED", message: "possibly partial" },
				},
				true,
			),
		).toBe(false);
		expect(canRetryTokenExpiredPublish(definitive, false)).toBe(true);
	});
});
