export type ProviderReadErrorClass = "transient" | "rate_limited" | "permanent";

export interface ExponentialBackoffPolicy {
	baseSeconds: number;
	capSeconds: number;
	jitterRatio: number;
}

function stableUnitInterval(key: string): number {
	// FNV-1a is deliberately small and deterministic. Retry jitter must remain
	// stable across a duplicate delivery so tests and cost bounds are exact,
	// while different tenant/resource keys avoid synchronized retry storms.
	let hash = 0x811c9dc5;
	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) / 0x1_0000_0000;
}

export function exponentialBackoffSeconds(
	attempt: number,
	policy: ExponentialBackoffPolicy,
	jitterKey: string,
): number {
	const normalizedAttempt = Math.max(1, Math.floor(attempt));
	const exponent = Math.min(normalizedAttempt - 1, 30);
	const unjittered = Math.min(
		policy.capSeconds,
		policy.baseSeconds * 2 ** exponent,
	);
	const boundedRatio = Math.max(0, Math.min(policy.jitterRatio, 0.5));
	const jitterFactor =
		1 - boundedRatio + stableUnitInterval(jitterKey) * boundedRatio * 2;
	return Math.max(
		1,
		Math.min(policy.capSeconds, Math.round(unjittered * jitterFactor)),
	);
}

export function statusFromProviderError(error: unknown): number | null {
	if (!error || typeof error !== "object") return null;
	for (const key of ["status", "statusCode", "httpStatus"]) {
		const value = (error as Record<string, unknown>)[key];
		if (typeof value === "number" && Number.isInteger(value)) return value;
	}
	const platformError = (error as { platformError?: unknown }).platformError;
	if (platformError && typeof platformError === "object") {
		const responseStatus = (
			platformError as {
				status?: unknown;
				error?: { code?: unknown };
			}
		).status;
		if (typeof responseStatus === "number") return responseStatus;
	}
	const match =
		error instanceof Error
			? error.message.match(/\b(?:error\s*)?\((\d{3})\)/i)
			: null;
	return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

export function classifyProviderReadError(
	error: unknown,
): ProviderReadErrorClass {
	const status = statusFromProviderError(error);
	if (status === 429) return "rate_limited";
	if (status === null || status === 408 || status === 425 || status >= 500) {
		return "transient";
	}
	return status >= 400 && status < 500 ? "permanent" : "transient";
}

export const EXTERNAL_POST_POLL = {
	maxClaimsPerRun: 100,
	maxClaimsPerTenant: 5,
	maxPagesPerAttempt: 2,
	leaseSeconds: 15 * 60,
	maxAutomaticAttempts: 8,
	retry: {
		baseSeconds: 60,
		capSeconds: 24 * 60 * 60,
		jitterRatio: 0.2,
	},
} as const;

export const EXTERNAL_METRICS_POLL = {
	maxClaimsPerRun: 200,
	maxClaimsPerTenant: 20,
	batchSize: 50,
	leaseSeconds: 15 * 60,
	maxAutomaticAttempts: 8,
	retry: {
		baseSeconds: 60,
		capSeconds: 6 * 60 * 60,
		jitterRatio: 0.2,
	},
} as const;

export const INTERNAL_METRICS_POLL = {
	maxClaimsPerRun: 200,
	maxClaimsPerTenant: 20,
	leaseSeconds: 15 * 60,
	maxAutomaticAttempts: 8,
	retry: {
		baseSeconds: 60,
		capSeconds: 6 * 60 * 60,
		jitterRatio: 0.2,
	},
} as const;

export const AD_ACCOUNT_POLL = {
	maxClaimsPerRun: 50,
	maxClaimsPerTenant: 2,
	leaseSeconds: 15 * 60,
	successIntervalSeconds: 30 * 60,
	maxAutomaticAttempts: 8,
	retry: {
		baseSeconds: 60,
		capSeconds: 24 * 60 * 60,
		jitterRatio: 0.2,
	},
} as const;

export const AD_METRICS_POLL = {
	maxClaimsPerRun: 100,
	maxClaimsPerTenant: 10,
	leaseSeconds: 15 * 60,
	successIntervalSeconds: 30 * 60,
	maxAutomaticAttempts: 8,
	retry: {
		baseSeconds: 60,
		capSeconds: 24 * 60 * 60,
		jitterRatio: 0.2,
	},
} as const;

export const SHORT_LINK_POLL = {
	maxClaimsPerRun: 50,
	maxClaimsPerTenant: 5,
	leaseSeconds: 10 * 60,
	successIntervalSeconds: 60 * 60,
	maxAutomaticAttempts: 8,
	retry: {
		baseSeconds: 60,
		capSeconds: 24 * 60 * 60,
		jitterRatio: 0.2,
	},
} as const;

export const AUTOMATION_BINDING_MUTATION = {
	maxClaimsPerRun: 100,
	maxClaimsPerTenant: 5,
	leaseSeconds: 5 * 60,
	maxAutomaticAttempts: 8,
	retry: {
		baseSeconds: 30,
		capSeconds: 60 * 60,
		jitterRatio: 0.2,
	},
} as const;

export const QUEUE_RESCUE_POLICY = {
	terminalAttempt: 40,
	alertAttempts: [3, 10, 25, 40] as const,
	messageRetentionSeconds: 24 * 60 * 60,
	retry: {
		baseSeconds: 1,
		capSeconds: 15 * 60,
		jitterRatio: 0.2,
	},
} as const;

export const QUEUE_DELIVERY_RETRY = {
	baseSeconds: 2,
	capSeconds: 15 * 60,
	jitterRatio: 0.2,
} as const;

export function nominalQueueDeliveryBound(mainRetries: 3 | 5): number {
	// Initial main delivery + configured retries, initial DLQ delivery + three
	// retries, then application deliveries 1..40 in rescue.
	return 1 + mainRetries + 4 + QUEUE_RESCUE_POLICY.terminalAttempt;
}

export function maximumRetryDelayHorizonSeconds(
	lastRetriedAttempt: number,
	policy: ExponentialBackoffPolicy,
): number {
	const maximumJitterFactor = 1 + Math.max(0, Math.min(policy.jitterRatio, 0.5));
	let total = 0;
	for (let attempt = 1; attempt <= lastRetriedAttempt; attempt += 1) {
		const exponent = Math.min(attempt - 1, 30);
		const unjittered = Math.min(
			policy.capSeconds,
			policy.baseSeconds * 2 ** exponent,
		);
		total += Math.ceil(unjittered * maximumJitterFactor);
	}
	return total;
}
