import resources from "../production-resources.json";

type ApiEnvelope<T> = {
	success: boolean;
	result?: T;
	result_info?: {
		page?: number;
		total_pages?: number;
	};
};

type HyperdriveConfig = {
	id?: string;
	caching?: { disabled?: boolean };
	origin?: {
		service_id?: string;
		user?: string;
		scheme?: string;
		host?: string;
		access_client_id?: string;
	};
};

type Bucket = {
	name?: string;
};

type Lifecycle = {
	rules?: Array<{
		id: string;
		enabled: boolean;
		conditions?: { prefix?: string };
		deleteObjectsTransition?: {
			condition?: { type?: string; maxAge?: number; date?: string };
		};
	}>;
};

type EventNotifications = {
	bucketName?: string;
	queues?: Array<{
		queueName?: string;
		rules?: Array<{
			actions?: string[];
			prefix?: string;
			suffix?: string;
		}>;
	}>;
};

export type QueueConfiguration = {
	queue_id?: string;
	queue_name?: string;
	settings?: {
		delivery_paused?: boolean;
	};
	producers?: Array<{
		script?: string;
		type?: string;
	}>;
	consumers?: Array<{
		type?: string;
		script_name?: string;
		dead_letter_queue?: string;
		settings?: {
			batch_size?: number;
			max_concurrency?: number | null;
			max_retries?: number;
			max_wait_time_ms?: number;
		};
	}>;
};

type VerificationMode = "full" | "predeploy";

type SecretBinding = {
	name?: string;
	type?: string;
};

type DeploymentList = {
	deployments?: Array<{
		versions?: Array<{
			version_id?: string;
			percentage?: number;
		}>;
	}>;
};

type VersionDetail = {
	resources?: {
		bindings?: Array<{
			name?: string;
			type?: string;
		}>;
	};
};

export function assertHyperdriveConfig(value: HyperdriveConfig): void {
	if (value.id !== resources.hyperdriveId) {
		throw new Error(
			"Cloudflare returned an unexpected Hyperdrive configuration",
		);
	}
	if (value.caching?.disabled !== true) {
		throw new Error(
			"Production Hyperdrive query caching must be explicitly disabled",
		);
	}
	if (!value.origin?.service_id) {
		throw new Error(
			"Production Hyperdrive must use a Workers VPC Service origin",
		);
	}
	if (
		value.origin.user !== resources.hyperdriveRuntimeUser ||
		!(["postgres", "postgresql"] as string[]).includes(
			value.origin.scheme ?? "",
		)
	) {
		throw new Error(
			"Production Hyperdrive must use the reviewed no-DDL PostgreSQL runtime role",
		);
	}
	if (value.origin.host || value.origin.access_client_id) {
		throw new Error(
			"Production Hyperdrive must not use a public or legacy Access origin",
		);
	}
}

export function assertBucket(expectedName: string, value: Bucket): void {
	if (value.name !== expectedName) {
		throw new Error(
			`Cloudflare returned an unexpected R2 bucket for ${expectedName}`,
		);
	}
}

function assertExpiringBucketLifecycle(
	bucketName: string,
	retentionSeconds: number,
	value: Lifecycle,
): void {
	const enabledDeletions = (value.rules ?? []).filter(
		(rule) => rule.enabled && rule.deleteObjectsTransition,
	);
	if (enabledDeletions.length !== 1) {
		throw new Error(
			`${bucketName} must have exactly one enabled object-deletion lifecycle rule`,
		);
	}
	const rule = enabledDeletions[0];
	const condition = rule?.deleteObjectsTransition?.condition;
	if (
		rule?.conditions?.prefix !== "" ||
		condition?.type !== "Age" ||
		condition.maxAge !== retentionSeconds
	) {
		throw new Error(
			`${bucketName} lifecycle must delete every object at the reviewed retention age`,
		);
	}
}

export function assertMediaLifecycle(value: Lifecycle): void {
	assertExpiringBucketLifecycle(
		resources.mediaBucket,
		resources.mediaRetentionSeconds,
		value,
	);
}

export function assertQueueRescueLifecycle(value: Lifecycle): void {
	assertExpiringBucketLifecycle(
		resources.queueRescueBucket,
		resources.queueRescueRetentionSeconds,
		value,
	);
}

export function assertDurableBucketLifecycle(
	bucketName: string,
	value: Lifecycle,
): void {
	if (
		(value.rules ?? []).some(
			(rule) => rule.enabled && rule.deleteObjectsTransition,
		)
	) {
		throw new Error(
			`${bucketName} must not have an enabled deletion lifecycle`,
		);
	}
}

export function assertMediaNotifications(value: EventNotifications): void {
	if (value.bucketName !== resources.mediaBucket) {
		throw new Error(
			"Cloudflare returned notifications for an unexpected bucket",
		);
	}
	const expectedActions = [...resources.mediaEventActions].sort();
	const queue = (value.queues ?? []).find(
		(candidate) => candidate.queueName === resources.mediaEventQueue,
	);
	const matchingRules = (queue?.rules ?? []).filter((rule) => {
		const actions = [...(rule.actions ?? [])].sort();
		return (
			actions.join("\0") === expectedActions.join("\0") &&
			!rule.prefix &&
			!rule.suffix
		);
	});
	if (queue?.rules?.length !== 1 || matchingRules.length !== 1) {
		throw new Error(
			"Media bucket must have exactly one cleanup-queue rule covering every reviewed action without filters",
		);
	}
}

function requiredQueueNames(): Set<string> {
	const names = new Set<string>(resources.queueProducers);
	for (const consumer of resources.queueConsumers) {
		names.add(consumer.queue);
		if (consumer.deadLetterQueue) names.add(consumer.deadLetterQueue);
	}
	return names;
}

export function assertQueuePrerequisites(values: QueueConfiguration[]): void {
	const byName = new Map(values.map((value) => [value.queue_name, value]));
	const failures: string[] = [];
	for (const queueName of requiredQueueNames()) {
		const queue = byName.get(queueName);
		if (!queue?.queue_id) {
			failures.push(`missing Queue ${queueName}`);
			continue;
		}
		if (queue.settings?.delivery_paused === true) {
			failures.push(`delivery paused for ${queueName}`);
		}
	}

	if (failures.length > 0) {
		throw new Error(
			`Production Queue prerequisites drift: ${failures.join("; ")}`,
		);
	}
}

export function assertQueueConfiguration(values: QueueConfiguration[]): void {
	assertQueuePrerequisites(values);
	const byName = new Map(values.map((value) => [value.queue_name, value]));
	const expectedNames = new Set(
		resources.queueConsumers.map((consumer) => consumer.queue),
	);
	const failures: string[] = [];
	for (const expected of resources.queueConsumers) {
		const queue = byName.get(expected.queue);
		if (!queue?.queue_id) {
			failures.push(`missing Queue ${expected.queue}`);
			continue;
		}
		if (queue.settings?.delivery_paused === true) {
			failures.push(`delivery paused for ${expected.queue}`);
		}
		const consumers = (queue.consumers ?? []).filter(
			(consumer) =>
				consumer.type === "worker" &&
				consumer.script_name === resources.workerName,
		);
		if (consumers.length !== 1) {
			failures.push(
				`${expected.queue} does not have exactly one RelayAPI Worker consumer`,
			);
			continue;
		}
		const consumer = consumers[0];
		if (
			consumer?.settings?.batch_size !== expected.batchSize ||
			consumer?.settings?.max_retries !== expected.maxRetries ||
			("maxWaitTimeMs" in expected &&
				consumer?.settings?.max_wait_time_ms !== expected.maxWaitTimeMs) ||
			("maxConcurrency" in expected &&
				consumer?.settings?.max_concurrency !== expected.maxConcurrency) ||
			consumer?.dead_letter_queue !== (expected.deadLetterQueue ?? "")
		) {
			failures.push(`consumer settings drifted for ${expected.queue}`);
		}
	}

	for (const queueName of resources.queueProducers) {
		const queue = byName.get(queueName);
		if (!expectedNames.has(queueName)) {
			failures.push(
				`producer manifest has no consumer policy for ${queueName}`,
			);
			continue;
		}
		if (!queue) continue;
		if (
			!(queue.producers ?? []).some(
				(producer) =>
					producer.type === "worker" &&
					producer.script === resources.workerName,
			)
		) {
			failures.push(`RelayAPI producer binding is missing for ${queueName}`);
		}
	}

	if (failures.length > 0) {
		throw new Error(
			`Production Queue configuration drift: ${failures.join("; ")}`,
		);
	}
}

export function assertRequiredSecrets(values: SecretBinding[]): void {
	const names = new Set(
		values
			.filter((value) => value.type?.startsWith("secret_"))
			.map((value) => value.name),
	);
	const missing = resources.requiredSecrets.filter((name) => !names.has(name));
	const failures: string[] = [];
	if (missing.length > 0) {
		failures.push(
			`required Worker secret bindings missing: ${missing.join(", ")}`,
		);
	}

	for (const group of resources.secretGroups) {
		const configured = group.filter((name) => names.has(name));
		if (configured.length > 0 && configured.length !== group.length) {
			const absent = group.filter((name) => !names.has(name));
			failures.push(
				`partially configured secret group missing: ${absent.join(", ")}`,
			);
		}
	}

	if (failures.length > 0) {
		throw new Error(`Production secret binding drift: ${failures.join("; ")}`);
	}
}

export function assertWorkerBindings(value: VersionDetail): void {
	const names = new Set(
		(value.resources?.bindings ?? []).map((binding) => binding.name),
	);
	const missing = resources.requiredBindings.filter((name) => !names.has(name));
	if (missing.length > 0) {
		throw new Error(
			`Active production Worker bindings drifted; missing: ${missing.join(", ")}`,
		);
	}
}

function activeVersionId(value: DeploymentList): string {
	const versions = value.deployments?.[0]?.versions;
	if (
		versions?.length !== 1 ||
		versions[0]?.percentage !== 100 ||
		!versions[0].version_id
	) {
		throw new Error(
			"Production Worker must have one active version receiving 100% of traffic",
		);
	}
	return versions[0].version_id;
}

export function validateCloudflareCredentials(
	token: string | undefined,
	accountId: string | undefined,
): { token: string; accountId: string } {
	if (!token || !accountId) {
		throw new Error(
			"CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required",
		);
	}
	if (/\s/.test(token)) {
		throw new Error(
			"CLOUDFLARE_API_TOKEN must be a single token without whitespace",
		);
	}
	if (accountId !== resources.accountId) {
		throw new Error("Refusing to verify an unexpected Cloudflare account");
	}
	return { token, accountId };
}

export function safeVerificationErrorMessage(
	error: unknown,
	token: string,
): string {
	return error instanceof Error
		? error.message.replaceAll(token, "[REDACTED]")
		: "unexpected verification failure";
}

export function verificationMode(args: string[]): VerificationMode {
	const flags = args.filter((arg) => arg.startsWith("--") && arg !== "--");
	if (flags.length === 0) return "full";
	if (flags.length === 1 && flags[0] === "--predeploy") return "predeploy";
	throw new Error("Usage: verify-cloudflare-production.ts [--predeploy]");
}

async function verifyProduction(): Promise<void> {
	const mode = verificationMode(process.argv.slice(2));
	const { token, accountId } = validateCloudflareCredentials(
		process.env.CLOUDFLARE_API_TOKEN,
		process.env.CLOUDFLARE_ACCOUNT_ID,
	);

	async function get<T>(path: string): Promise<ApiEnvelope<T>> {
		let response: Response;
		try {
			response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(15_000),
			});
		} catch {
			// Fetch implementations can include invalid header values in their error
			// text. Never propagate an exception that could contain the bearer token.
			throw new Error("Cloudflare verification request could not be completed");
		}
		if (!response.ok) {
			throw new Error(
				`Cloudflare production verification request failed (${response.status})`,
			);
		}
		let envelope: ApiEnvelope<T>;
		try {
			envelope = (await response.json()) as ApiEnvelope<T>;
		} catch {
			throw new Error(
				"Cloudflare production verification returned invalid JSON",
			);
		}
		if (!envelope.success || envelope.result === undefined) {
			throw new Error("Cloudflare production verification returned an error");
		}
		return envelope;
	}

	async function result<T>(path: string): Promise<T> {
		return (await get<T>(path)).result as T;
	}

	async function listQueues(): Promise<QueueConfiguration[]> {
		const values: QueueConfiguration[] = [];
		let page = 1;
		let totalPages = 1;
		do {
			const envelope = await get<QueueConfiguration[]>(
				`/accounts/${accountId}/queues?page=${page}&per_page=100`,
			);
			values.push(...(envelope.result ?? []));
			totalPages = envelope.result_info?.total_pages ?? 1;
			page += 1;
		} while (page <= totalPages);
		return values;
	}

	const base = `/accounts/${accountId}`;
	const workerBase = `${base}/workers/scripts/${resources.workerName}`;
	const checks: Array<{ label: string; run: () => Promise<void> }> = [
		{
			label: "Hyperdrive",
			run: async () =>
				assertHyperdriveConfig(
					await result<HyperdriveConfig>(
						`${base}/hyperdrive/configs/${resources.hyperdriveId}`,
					),
				),
		},
		{
			label: "media R2 bucket",
			run: async () =>
				assertBucket(
					resources.mediaBucket,
					await result<Bucket>(`${base}/r2/buckets/${resources.mediaBucket}`),
				),
		},
		{
			label: "avatar R2 bucket",
			run: async () =>
				assertBucket(
					resources.avatarBucket,
					await result<Bucket>(`${base}/r2/buckets/${resources.avatarBucket}`),
				),
		},
		{
			label: "thumbnail R2 bucket",
			run: async () =>
				assertBucket(
					resources.thumbnailBucket,
					await result<Bucket>(
						`${base}/r2/buckets/${resources.thumbnailBucket}`,
					),
				),
		},
		{
			label: "queue rescue R2 bucket",
			run: async () =>
				assertBucket(
					resources.queueRescueBucket,
					await result<Bucket>(
						`${base}/r2/buckets/${resources.queueRescueBucket}`,
					),
				),
		},
		{
			label: "media R2 lifecycle",
			run: async () =>
				assertMediaLifecycle(
					await result<Lifecycle>(
						`${base}/r2/buckets/${resources.mediaBucket}/lifecycle`,
					),
				),
		},
		{
			label: "avatar R2 lifecycle",
			run: async () =>
				assertDurableBucketLifecycle(
					resources.avatarBucket,
					await result<Lifecycle>(
						`${base}/r2/buckets/${resources.avatarBucket}/lifecycle`,
					),
				),
		},
		{
			label: "thumbnail R2 lifecycle",
			run: async () =>
				assertDurableBucketLifecycle(
					resources.thumbnailBucket,
					await result<Lifecycle>(
						`${base}/r2/buckets/${resources.thumbnailBucket}/lifecycle`,
					),
				),
		},
		{
			label: "queue rescue R2 lifecycle",
			run: async () =>
				assertQueueRescueLifecycle(
					await result<Lifecycle>(
						`${base}/r2/buckets/${resources.queueRescueBucket}/lifecycle`,
					),
				),
		},
		{
			label: "media R2 event notifications",
			run: async () =>
				assertMediaNotifications(
					await result<EventNotifications>(
						`${base}/event_notifications/r2/${resources.mediaBucket}/configuration`,
					),
				),
		},
		{
			label: mode === "predeploy" ? "Queue prerequisites" : "Queues",
			run: async () => {
				const queues = await listQueues();
				if (mode === "predeploy") {
					assertQueuePrerequisites(queues);
				} else {
					assertQueueConfiguration(queues);
				}
			},
		},
		{
			label: "Worker secrets",
			run: async () =>
				assertRequiredSecrets(
					await result<SecretBinding[]>(`${workerBase}/secrets`),
				),
		},
	];

	if (mode === "full") {
		checks.push({
			label: "active Worker bindings",
			run: async () => {
				const deployments = await result<DeploymentList>(
					`${workerBase}/deployments`,
				);
				const versionId = activeVersionId(deployments);
				const expectedVersionId = process.env.EXPECTED_WORKER_VERSION_ID;
				if (expectedVersionId && versionId !== expectedVersionId) {
					throw new Error(
						"active version is not the version deployed by this release",
					);
				}
				const version = await result<VersionDetail>(
					`${workerBase}/versions/${versionId}`,
				);
				assertWorkerBindings(version);
			},
		});
	}

	const failures = (
		await Promise.all(
			checks.map(async ({ label, run }) => {
				try {
					await run();
					return null;
				} catch (error) {
					return `${label}: ${safeVerificationErrorMessage(error, token)}`;
				}
			}),
		)
	).filter((failure): failure is string => failure !== null);
	if (failures.length > 0) {
		throw new Error(
			`Production Cloudflare configuration drift:\n- ${failures.join("\n- ")}`,
		);
	}

	console.log(
		mode === "predeploy"
			? "Verified production Cloudflare deployment prerequisites without requiring future Worker bindings."
			: "Verified production Hyperdrive, R2, Queue/DLQ/rescue, secret, and Worker binding configuration.",
	);
}

if (import.meta.main) await verifyProduction();
