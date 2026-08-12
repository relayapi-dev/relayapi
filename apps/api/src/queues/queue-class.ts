export const WORK_QUEUE_CAPABILITIES = [
	"media-cleanup",
	"media-processing",
	"publish",
	"email",
	"refresh",
	"inbox",
	"tools",
	"ads",
	"sync",
	"customer-webhooks",
] as const;

export type WorkQueueCapability = (typeof WORK_QUEUE_CAPABILITIES)[number];
export type QueueRole = "source" | "dead-letter" | "rescue";

export type NormalizedQueueClass =
	| {
			capability: WorkQueueCapability;
			role: "source" | "dead-letter";
	  }
	| {
			capability: "queue-rescue";
			role: "rescue";
	  };

const WORK_QUEUE_CAPABILITY_SET: ReadonlySet<string> = new Set(
	WORK_QUEUE_CAPABILITIES,
);
const QUEUE_PREFIXES = ["relayapi-selfhost-", "relayapi-"] as const;

function isWorkQueueCapability(value: string): value is WorkQueueCapability {
	return WORK_QUEUE_CAPABILITY_SET.has(value);
}

function unprefixedQueueName(queueName: string): string | null {
	for (const prefix of QUEUE_PREFIXES) {
		if (queueName.startsWith(prefix)) return queueName.slice(prefix.length);
	}
	return null;
}

export function deploymentQueueNames(
	queueClass: NormalizedQueueClass,
): readonly string[] {
	const suffix = queueClass.role === "dead-letter" ? "-dlq" : "";
	return Object.freeze(
		QUEUE_PREFIXES.map(
			(prefix) => `${prefix}${queueClass.capability}${suffix}`,
		),
	);
}

/**
 * Normalize deployment-specific Cloudflare Queue names into one capability
 * identity. Queue failures may use the logical `inbox-raw` origin even though
 * both hosted and self-hosted deployments deliver it through the inbox Queue.
 */
export function normalizeQueueClass(
	queueName: string,
): NormalizedQueueClass | null {
	const unprefixed = unprefixedQueueName(queueName);
	if (!unprefixed) return null;
	if (unprefixed === "queue-rescue") {
		return { capability: "queue-rescue", role: "rescue" };
	}
	if (unprefixed === "inbox-raw") {
		return { capability: "inbox", role: "source" };
	}

	const isDeadLetter = unprefixed.endsWith("-dlq");
	const capability = isDeadLetter
		? unprefixed.slice(0, -"-dlq".length)
		: unprefixed;
	if (!isWorkQueueCapability(capability)) return null;
	return {
		capability,
		role: isDeadLetter ? "dead-letter" : "source",
	};
}
