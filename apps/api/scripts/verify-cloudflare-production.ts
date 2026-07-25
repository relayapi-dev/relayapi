import { evaluateCompleteSecretGroups } from "../../../scripts/secrets";
import resources from "../production-resources.json";

type ApiEnvelope<T> = {
	success: boolean;
	result?: T;
	result_info?: {
		page?: number;
		total_pages?: number;
	};
};

type Zone = {
	id?: string;
	name?: string;
	status?: string;
};

type ZoneSetting = {
	id?: string;
	value?: string;
	editable?: boolean;
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

type CustomDomains = {
	domains?: Array<{
		domain?: string;
		enabled?: boolean;
		status?: {
			ownership?: string;
			ssl?: string;
		};
		minTLS?: string;
		zoneId?: string;
		zoneName?: string;
	}>;
};

type ManagedDomain = {
	bucketId?: string;
	domain?: string;
	enabled?: boolean;
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

type BucketCors = {
	rules?: Array<{
		allowed?: {
			methods?: string[];
			origins?: string[];
			headers?: string[];
		};
		exposeHeaders?: string[];
		maxAgeSeconds?: number;
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
		bucket_name?: string;
		type?: string;
	}>;
	consumers?: Array<{
		type?: string;
		script?: string;
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
		bindings?: WorkerBinding[];
		script_runtime?: {
			compatibility_date?: string;
			compatibility_flags?: string[];
			migration_tag?: string;
			usage_model?: string;
		};
	};
};

export type WorkerDomain = {
	hostname?: string;
	service?: string;
	zone_name?: string;
};

type WorkerSettings = {
	placement?: Record<string, unknown>;
	observability?: Record<string, unknown>;
};

type CronSchedule = { cron?: string };
type CronScheduleList = { schedules?: CronSchedule[] };

export type WorkerBinding = {
	name?: string;
	type?: string;
	namespace_id?: string;
	bucket_name?: string;
	id?: string;
	queue_name?: string;
	class_name?: string;
	script_name?: string;
	text?: string;
	simple?: { limit?: number; period?: number; mitigation_timeout?: number };
};

export function assertHyperdriveConfig(
	value: HyperdriveConfig,
	reviewedServiceId: string | null = resources.hyperdriveVpcServiceId,
): void {
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
	if (!reviewedServiceId) {
		throw new Error(
			"Production Hyperdrive VPC service ID is not pinned in the resource manifest",
		);
	}
	if (value.origin?.service_id !== reviewedServiceId) {
		throw new Error(
			"Production Hyperdrive must use the exact reviewed Workers VPC Service origin",
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

export function assertAlwaysUseHttps(
	zones: Zone[],
	setting: ZoneSetting,
): void {
	if (
		zones.length !== 1 ||
		!zones[0]?.id ||
		zones[0].name !== resources.zoneName ||
		zones[0].status !== "active"
	) {
		throw new Error(
			"RelayAPI production zone must resolve uniquely and be active",
		);
	}
	if (setting.id !== "always_use_https" || setting.value !== "on") {
		throw new Error("RelayAPI production zone must enable Always Use HTTPS");
	}
}

export function assertBucket(expectedName: string, value: Bucket): void {
	if (value.name !== expectedName) {
		throw new Error(
			`Cloudflare returned an unexpected R2 bucket for ${expectedName}`,
		);
	}
}

export function assertThumbnailCustomDomain(value: CustomDomains): void {
	const domains = value.domains ?? [];
	const domain = domains[0];
	const tlsOrder = ["1.0", "1.1", "1.2", "1.3"];
	const actualTls = tlsOrder.indexOf(domain?.minTLS ?? "");
	const minimumTls = tlsOrder.indexOf(
		resources.thumbnailPublicDomain.minimumTlsVersion,
	);
	if (
		domains.length !== 1 ||
		!domain ||
		domain.domain !== resources.thumbnailPublicDomain.hostname ||
		domain.enabled !== true ||
		domain.status?.ownership !== "active" ||
		domain.status.ssl !== "active" ||
		domain.zoneName !== resources.thumbnailPublicDomain.zoneName ||
		!domain.zoneId ||
		minimumTls < 0 ||
		actualTls < minimumTls
	) {
		throw new Error(
			"Thumbnail R2 custom domain must exactly match the reviewed active TLS policy",
		);
	}
}

export function assertPrivateR2DevDisabled(
	bucketName: string,
	value: ManagedDomain,
): void {
	if (!resources.privateR2Buckets.includes(bucketName)) {
		throw new Error(`No private R2 public-access policy for ${bucketName}`);
	}
	if (!value.bucketId || !value.domain || value.enabled !== false) {
		throw new Error(`${bucketName} must disable public r2.dev access`);
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
		(rule?.conditions?.prefix ?? "") !== "" ||
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
	const queues = value.queues ?? [];
	const queue = queues.find(
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
	if (
		queues.length !== 1 ||
		queue?.rules?.length !== 1 ||
		matchingRules.length !== 1
	) {
		throw new Error(
			"Media bucket must have exactly one cleanup-queue rule covering every reviewed action without filters",
		);
	}
}

function sorted(values: readonly string[] | undefined): string[] {
	return [...(values ?? [])].sort();
}

export function assertMediaCors(value: BucketCors): void {
	const rules = value.rules ?? [];
	const rule = rules[0];
	if (
		rules.length !== 1 ||
		!rule ||
		sorted(rule.allowed?.origins).join("\0") !==
			sorted(resources.mediaCors.origins).join("\0") ||
		sorted(rule.allowed?.methods).join("\0") !==
			sorted(resources.mediaCors.methods).join("\0") ||
		sorted(rule.allowed?.headers).join("\0") !==
			sorted(resources.mediaCors.headers).join("\0") ||
		(rule.exposeHeaders?.length ?? 0) !== 0 ||
		rule.maxAgeSeconds !== resources.mediaCors.maxAgeSeconds
	) {
		throw new Error(
			"Media bucket CORS must allow only the reviewed dashboard presigned-upload policy",
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
		const consumers = queue.consumers ?? [];
		const relayConsumers = consumers.filter(
			(consumer) =>
				consumer.type === "worker" &&
				(consumer.script_name ?? consumer.script) === resources.workerName,
		);
		if (consumers.length !== 1 || relayConsumers.length !== 1) {
			failures.push(
				`${expected.queue} consumer topology does not exactly match RelayAPI`,
			);
			continue;
		}
		const consumer = relayConsumers[0];
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

	for (const expected of resources.queueConsumers) {
		const queueName = expected.queue;
		const queue = byName.get(queueName);
		if (!queue) continue;
		const producers = queue.producers ?? [];
		const expectedProducers: Array<{
			type: string;
			script?: string;
			bucket_name?: string;
		}> = [];
		if (resources.queueProducers.includes(queueName)) {
			expectedProducers.push({
				type: "worker",
				script: resources.workerName,
			});
		}
		if (queueName === resources.mediaEventQueue) {
			expectedProducers.push({
				type: "r2_bucket",
				bucket_name: resources.mediaBucket,
			});
		}
		const additionalProducers =
			resources.queueAdditionalProducers[
				queueName as keyof typeof resources.queueAdditionalProducers
			] ?? [];
		expectedProducers.push(...additionalProducers);
		const normalize = (producer: {
			type?: string;
			script?: string;
			bucket_name?: string;
		}) =>
			JSON.stringify({
				type: producer.type,
				script: producer.script ?? null,
				bucket_name: producer.bucket_name ?? null,
			});
		if (
			producers.map(normalize).sort().join("\0") !==
			expectedProducers.map(normalize).sort().join("\0")
		) {
			failures.push(`producer topology drifted for ${queueName}`);
		}
	}
	for (const queueName of resources.queueProducers) {
		if (!expectedNames.has(queueName)) {
			failures.push(
				`producer manifest has no consumer policy for ${queueName}`,
			);
		}
	}
	for (const queueName of Object.keys(resources.queueAdditionalProducers)) {
		if (!expectedNames.has(queueName)) {
			failures.push(
				`additional producer manifest has no consumer policy for ${queueName}`,
			);
		}
	}

	if (failures.length > 0) {
		throw new Error(
			`Production Queue configuration drift: ${failures.join("; ")}`,
		);
	}
}

export function assertRequiredSecrets(values: SecretBinding[]): void {
	const invalidTypes = values
		.filter((value) => value.type !== "secret_text")
		.map((value) => `${value.name ?? "<unnamed>"}:${value.type ?? "<missing>"}`)
		.sort();
	const names = new Set(
		values
			.filter((value) => value.type === "secret_text")
			.map((value) => value.name)
			.filter((name): name is string => typeof name === "string"),
	);
	const missing = resources.requiredSecrets.filter((name) => !names.has(name));
	const failures: string[] = [];
	if (invalidTypes.length > 0) {
		failures.push(
			`unsupported Worker secret binding types: ${invalidTypes.join(", ")}`,
		);
	}
	if (missing.length > 0) {
		failures.push(
			`required Worker secret bindings missing: ${missing.join(", ")}`,
		);
	}

	const { states, orphanedKeys } = evaluateCompleteSecretGroups(
		resources.secretGroups,
		names,
	);
	for (const { group, present, triggered } of states) {
		if (triggered && present.length !== group.length) {
			const absent = group.filter((name) => !names.has(name));
			failures.push(
				`partially configured secret group missing: ${absent.join(", ")}`,
			);
		}
	}
	if (orphanedKeys.length > 0) {
		failures.push(
			`grouped secret bindings without a complete provider group: ${orphanedKeys.join(", ")}`,
		);
	}
	const allowed = new Set([
		...resources.requiredSecrets,
		...resources.optionalSecrets,
		...resources.secretGroups.flat(),
	]);
	const unexpected = [...names].filter((name) => !allowed.has(name)).sort();
	if (unexpected.length > 0) {
		failures.push(
			`Worker secret bindings outside the production allowlist: ${unexpected.join(", ")}`,
		);
	}

	if (failures.length > 0) {
		throw new Error(`Production secret binding drift: ${failures.join("; ")}`);
	}
}

export function assertWorkerBindings(value: VersionDetail): void {
	const bindings = value.resources?.bindings ?? [];
	const requiredNames = [...resources.requiredBindings].sort();
	const identityNames = Object.keys(resources.workerBindings).sort();
	if (requiredNames.join("\0") !== identityNames.join("\0")) {
		throw new Error(
			"Production binding manifest names and identities are inconsistent",
		);
	}

	const failures: string[] = [];
	const actualNonSecretNames = bindings
		.filter((binding) => !binding.type?.startsWith("secret_"))
		.map((binding) => binding.name)
		.filter((name): name is string => typeof name === "string")
		.sort();
	if (actualNonSecretNames.join("\0") !== identityNames.join("\0")) {
		failures.push(
			`non-secret binding names must exactly match the reviewed manifest (found: ${actualNonSecretNames.join(", ")})`,
		);
	}
	for (const [name, expected] of Object.entries(resources.workerBindings)) {
		const matches = bindings.filter((binding) => binding.name === name);
		if (matches.length !== 1) {
			failures.push(`${name} must appear exactly once`);
			continue;
		}
		if (!matchesExpectedFields(matches[0] ?? {}, expected)) {
			failures.push(`${name} points to an unexpected resource`);
		}
	}
	if (failures.length > 0) {
		throw new Error(
			`Active production Worker binding identities drifted: ${failures.join("; ")}`,
		);
	}
	assertWorkerRuntime(value);
}

export function assertWorkerRuntime(value: VersionDetail): void {
	const runtime = value.resources?.script_runtime;
	if (!runtime) throw new Error("Active Worker runtime settings are missing");
	const actualFlags = [...(runtime.compatibility_flags ?? [])].sort();
	const expectedFlags = [...resources.workerRuntime.compatibility_flags].sort();
	const failures: string[] = [];
	if (
		runtime.compatibility_date !== resources.workerRuntime.compatibility_date
	) {
		failures.push("compatibility date drifted");
	}
	if (actualFlags.join("\0") !== expectedFlags.join("\0")) {
		failures.push("compatibility flags drifted");
	}
	if (runtime.migration_tag !== resources.workerRuntime.migration_tag) {
		failures.push("Durable Object migration tag drifted");
	}
	if (runtime.usage_model !== resources.workerRuntime.usage_model) {
		failures.push("usage model drifted");
	}
	if (failures.length > 0) {
		throw new Error(`Active Worker runtime drifted: ${failures.join("; ")}`);
	}
}

export function assertWorkerSettings(value: WorkerSettings): void {
	if (!matchesExpectedFields(value, resources.workerSettings)) {
		throw new Error(
			"Active Worker placement or observability settings drifted",
		);
	}
}

export function assertCronSchedules(values: CronSchedule[]): void {
	const actual = values
		.map((value) => value.cron)
		.filter((cron): cron is string => typeof cron === "string")
		.sort();
	const expected = [...resources.cronSchedules].sort();
	if (actual.join("\0") !== expected.join("\0")) {
		throw new Error("Active Worker cron schedules drifted");
	}
}

export function assertCronScheduleResponse(value: CronScheduleList): void {
	if (!Array.isArray(value.schedules)) {
		throw new Error("Cloudflare Worker schedule response is malformed");
	}
	assertCronSchedules(value.schedules);
}

export function assertApiWorkerDomain(values: WorkerDomain[]): void {
	const matches = values.filter(
		(value) =>
			value.hostname === resources.apiHostname &&
			value.service === resources.workerName &&
			value.zone_name === resources.zoneName,
	);
	if (matches.length !== 1 || values.length !== 1) {
		throw new Error(
			`${resources.apiHostname} is not mapped exactly once to ${resources.workerName}`,
		);
	}
}

function matchesExpectedFields(
	actual: Record<string, unknown>,
	expected: Record<string, unknown>,
): boolean {
	for (const [field, expectedValue] of Object.entries(expected)) {
		const actualValue = actual[field];
		if (
			expectedValue &&
			typeof expectedValue === "object" &&
			!Array.isArray(expectedValue)
		) {
			if (
				!actualValue ||
				typeof actualValue !== "object" ||
				Array.isArray(actualValue) ||
				!matchesExpectedFields(
					actualValue as Record<string, unknown>,
					expectedValue as Record<string, unknown>,
				)
			) {
				return false;
			}
		} else if (actualValue !== expectedValue) {
			return false;
		}
	}
	return true;
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
			label: "Always Use HTTPS",
			run: async () => {
				const zones = await result<Zone[]>(
					`/zones?name=${encodeURIComponent(resources.zoneName)}&account.id=${encodeURIComponent(accountId)}`,
				);
				const zoneId = zones.length === 1 ? zones[0]?.id : undefined;
				if (!zoneId) {
					assertAlwaysUseHttps(zones, {});
					return;
				}
				assertAlwaysUseHttps(
					zones,
					await result<ZoneSetting>(
						`/zones/${zoneId}/settings/always_use_https`,
					),
				);
			},
		},
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
			label: "thumbnail R2 custom domain",
			run: async () =>
				assertThumbnailCustomDomain(
					await result<CustomDomains>(
						`${base}/r2/buckets/${encodeURIComponent(resources.thumbnailBucket)}/domains/custom`,
					),
				),
		},
		...resources.privateR2Buckets.map((bucketName) => ({
			label: `${bucketName} r2.dev access`,
			run: async () =>
				assertPrivateR2DevDisabled(
					bucketName,
					await result<ManagedDomain>(
						`${base}/r2/buckets/${encodeURIComponent(bucketName)}/domains/managed`,
					),
				),
		})),
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
			label: "media R2 CORS",
			run: async () =>
				assertMediaCors(
					await result<BucketCors>(
						`${base}/r2/buckets/${resources.mediaBucket}/cors`,
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
			label: "active Worker version configuration",
			run: async () => {
				const deployments = await result<DeploymentList>(
					`${workerBase}/deployments`,
				);
				const versionId = activeVersionId(deployments);
				const expectedVersionId = process.env.EXPECTED_WORKER_VERSION_ID;
				if (!expectedVersionId || versionId !== expectedVersionId) {
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
		checks.push(
			{
				label: "API Worker custom domain",
				run: async () =>
					assertApiWorkerDomain(
						await result<WorkerDomain[]>(
							`${base}/workers/domains?hostname=${encodeURIComponent(resources.apiHostname)}`,
						),
					),
			},
			{
				label: "active Worker script settings",
				run: async () =>
					assertWorkerSettings(
						await result<WorkerSettings>(`${workerBase}/settings`),
					),
			},
			{
				label: "active Worker cron schedules",
				run: async () =>
					assertCronScheduleResponse(
						await result<CronScheduleList>(`${workerBase}/schedules`),
					),
			},
		);
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
