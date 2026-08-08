import resources from "../production-resources.json";
import {
	assertQueuePrerequisites,
	type QueueConfiguration,
	requiredQueueNames,
	validateCloudflareCredentials,
} from "./verify-cloudflare-production";

interface ApiEnvelope<T> {
	success: boolean;
	result?: T;
	result_info?: {
		total_pages?: number;
	};
}

export interface QueueRetentionUpdate {
	queueId: string;
	queueName: string;
	deliveryPaused?: boolean;
}

export function planQueueRetentionUpdates(
	values: QueueConfiguration[],
): QueueRetentionUpdate[] {
	const byName = new Map<string, QueueConfiguration>();
	for (const value of values) {
		if (!value.queue_name) continue;
		if (byName.has(value.queue_name)) {
			throw new Error(`Duplicate Cloudflare Queue named ${value.queue_name}`);
		}
		byName.set(value.queue_name, value);
	}

	const updates: QueueRetentionUpdate[] = [];
	for (const queueName of requiredQueueNames()) {
		const queue = byName.get(queueName);
		if (!queue?.queue_id) {
			throw new Error(`Missing required Cloudflare Queue ${queueName}`);
		}
		if (
			queue.settings?.message_retention_period ===
			resources.queueMessageRetentionSeconds
		) {
			continue;
		}
		updates.push({
			queueId: queue.queue_id,
			queueName,
			...(queue.settings?.delivery_paused === undefined
				? {}
				: { deliveryPaused: queue.settings.delivery_paused }),
		});
	}
	return updates;
}

async function configureQueueRetention(
	token: string,
	accountId: string,
	fetchImpl: typeof fetch = fetch,
): Promise<number> {
	const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;

	async function request<T>(
		method: "GET" | "PUT",
		path: string,
		body?: unknown,
	): Promise<ApiEnvelope<T>> {
		let response: Response;
		try {
			response = await fetchImpl(`${base}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					...(body === undefined
						? {}
						: { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(15_000),
			});
		} catch {
			throw new Error("Cloudflare Queue configuration request failed");
		}
		if (!response.ok) {
			throw new Error(
				`Cloudflare Queue configuration returned HTTP ${response.status}`,
			);
		}
		let envelope: ApiEnvelope<T>;
		try {
			envelope = (await response.json()) as ApiEnvelope<T>;
		} catch {
			throw new Error("Cloudflare Queue configuration returned invalid JSON");
		}
		if (!envelope.success || envelope.result === undefined) {
			throw new Error("Cloudflare Queue configuration returned an error");
		}
		return envelope;
	}

	async function listQueues(): Promise<QueueConfiguration[]> {
		const values: QueueConfiguration[] = [];
		let page = 1;
		let totalPages = 1;
		do {
			const envelope = await request<QueueConfiguration[]>(
				"GET",
				`/queues?page=${page}&per_page=100`,
			);
			values.push(...(envelope.result ?? []));
			totalPages = envelope.result_info?.total_pages ?? 1;
			page += 1;
		} while (page <= totalPages);
		return values;
	}

	const updates = planQueueRetentionUpdates(await listQueues());
	for (const update of updates) {
		const settings = {
			message_retention_period: resources.queueMessageRetentionSeconds,
			...(update.deliveryPaused === undefined
				? {}
				: { delivery_paused: update.deliveryPaused }),
		};
		const envelope = await request<QueueConfiguration>(
			"PUT",
			`/queues/${encodeURIComponent(update.queueId)}`,
			{
				queue_name: update.queueName,
				settings,
			},
		);
		const configured = envelope.result;
		if (
			configured?.queue_id !== update.queueId ||
			configured.queue_name !== update.queueName ||
			configured.settings?.message_retention_period !==
				resources.queueMessageRetentionSeconds
		) {
			throw new Error(
				`Cloudflare Queue ${update.queueName} did not accept the 24-hour message-retention policy`,
			);
		}
	}

	// Re-read all Queues so eventual response-shape drift or a partial update fails
	// before the Worker deployment proceeds.
	assertQueuePrerequisites(await listQueues());
	return updates.length;
}

export async function configureProductionQueueRetention(
	token: string | undefined,
	accountId: string | undefined,
	fetchImpl: typeof fetch = fetch,
): Promise<number> {
	const credentials = validateCloudflareCredentials(token, accountId);
	return configureQueueRetention(
		credentials.token,
		credentials.accountId,
		fetchImpl,
	);
}

if (import.meta.main) {
	const updated = await configureProductionQueueRetention(
		process.env.CLOUDFLARE_API_TOKEN,
		process.env.CLOUDFLARE_ACCOUNT_ID,
	);
	console.log(
		updated === 0
			? "Verified every production Queue already has 24-hour message retention."
			: `Converged and verified 24-hour message retention on ${updated} production Queues.`,
	);
}
