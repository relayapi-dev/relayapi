import { validateHyperdriveCaCertificateId } from "./config.js";
import {
	cloudflareQueueName,
	INCOMPLETE_MULTIPART_RETENTION_SECONDS,
	QUEUE_MESSAGE_RETENTION_SECONDS,
	QUEUE_NAMES,
	type QueueName,
	RESOURCE_NAMES,
} from "./constants.js";
import { fetchBounded, parseJsonBytes } from "./http.js";
import type { CloudflareResourcePlan, SelfHostConfig } from "./types.js";

interface ApiResultInfo {
	count?: number;
	page?: number;
	per_page?: number;
	total_count?: number;
	total_pages?: number;
	cursor?: string;
}

interface ApiEnvelope<T> {
	success: boolean;
	result: T;
	result_info?: ApiResultInfo;
	errors?: Array<{ code?: number; message?: string }>;
	messages?: Array<{ code?: number; message?: string }>;
}

interface KvNamespace {
	id: string;
	title: string;
}

interface R2Bucket {
	name: string;
	jurisdiction?: "default" | "eu" | "fedramp";
}

interface Queue {
	queue_id: string;
	queue_name: string;
	settings?: {
		message_retention_period?: number;
	};
}

interface HyperdriveConfig {
	id: string;
	name: string;
	origin?: {
		host?: string;
		port?: number;
		database?: string;
		user?: string;
		scheme?: string;
	};
	caching?: { disabled?: boolean };
	mtls?: {
		sslmode?: string;
		ca_certificate_id?: string;
		mtls_certificate_id?: string;
	};
	origin_connection_limit?: number;
}

type ParsedPostgresUrl = ReturnType<typeof parsePostgresUrl>;

interface DesiredHyperdriveConfig {
	name: string;
	origin: {
		host: string;
		port: number;
		scheme: "postgresql";
		database: string;
		user: string;
		password: string;
	};
	caching: { disabled: true };
	mtls: {
		sslmode: ParsedPostgresUrl["sslmode"];
		ca_certificate_id: string;
		mtls_certificate_id?: string;
	};
	origin_connection_limit?: number;
}

interface HyperdriveReconciliationOptions {
	/** Explicit operator intent; required when changing an existing CA pin. */
	requestedCaCertificateId?: string;
	/** Independently authorized prior CA carried into the apply-time re-plan. */
	expectedCurrentCaCertificateId?: string;
}

const HYPERDRIVE_VERIFY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;
const MAX_CLOUDFLARE_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CLOUDFLARE_LIST_PAGES = 1_000;
const SSLMODE_STRENGTH = {
	require: 0,
	"verify-ca": 1,
	"verify-full": 2,
} as const;

function errorMessage(body: ApiEnvelope<unknown>, status: number): string {
	const details = [...(body.errors ?? []), ...(body.messages ?? [])]
		.map((entry) => entry.message)
		.filter(Boolean)
		.join("; ");
	return details || `Cloudflare API request failed with HTTP ${status}`;
}

function redactSensitiveText(value: string, body?: unknown): string {
	let redacted = value.replace(
		/\b(postgres(?:ql)?:\/\/)([^\s/@]+(?::[^\s/@]*)?)@/giu,
		"$1[REDACTED]@",
	);
	const secrets: string[] = [];
	const visit = (candidate: unknown): void => {
		if (!candidate || typeof candidate !== "object") return;
		if (Array.isArray(candidate)) {
			for (const entry of candidate) visit(entry);
			return;
		}
		for (const [key, entry] of Object.entries(candidate)) {
			if (
				typeof entry === "string" &&
				(key === "password" || key.endsWith("_secret")) &&
				entry.length > 0
			) {
				secrets.push(entry, encodeURIComponent(entry));
			} else {
				visit(entry);
			}
		}
	};
	visit(body);
	for (const secret of secrets)
		redacted = redacted.replaceAll(secret, "[REDACTED]");
	return redacted;
}

function equivalentPostgresScheme(value: string | undefined): boolean {
	return value === "postgres" || value === "postgresql";
}

function currentSslmode(
	config: HyperdriveConfig,
): ParsedPostgresUrl["sslmode"] {
	const value = config.mtls?.sslmode ?? "require";
	if (value !== "require" && value !== "verify-ca" && value !== "verify-full") {
		throw new Error("Existing Hyperdrive has an unsupported TLS mode");
	}
	return value;
}

function assertSafeHyperdriveOrigin(
	config: HyperdriveConfig,
	database: ParsedPostgresUrl,
): void {
	if (
		config.origin?.host?.toLowerCase() !== database.hostname.toLowerCase() ||
		(config.origin?.port ?? 5432) !== database.port ||
		config.origin?.database !== database.database ||
		config.origin?.user !== database.username ||
		!equivalentPostgresScheme(config.origin?.scheme)
	) {
		throw new Error(
			`Existing Hyperdrive ${RESOURCE_NAMES.hyperdrive} points to a different database origin`,
		);
	}
	const existingSslmode = currentSslmode(config);
	if (SSLMODE_STRENGTH[database.sslmode] < SSLMODE_STRENGTH[existingSslmode]) {
		throw new Error(
			`Existing Hyperdrive ${RESOURCE_NAMES.hyperdrive} cannot be downgraded from ${existingSslmode} to ${database.sslmode}`,
		);
	}
}

function desiredHyperdriveConfig(
	database: ParsedPostgresUrl,
	caCertificateId: string,
	existing?: HyperdriveConfig,
): DesiredHyperdriveConfig {
	return {
		name: RESOURCE_NAMES.hyperdrive,
		origin: {
			host: database.hostname,
			port: database.port,
			scheme: "postgresql",
			database: database.database,
			user: database.username,
			password: database.password,
		},
		caching: { disabled: true },
		mtls: {
			sslmode: database.sslmode,
			ca_certificate_id: caCertificateId,
			...(existing?.mtls?.mtls_certificate_id
				? { mtls_certificate_id: existing.mtls.mtls_certificate_id }
				: {}),
		},
		...(existing?.origin_connection_limit === undefined
			? {}
			: { origin_connection_limit: existing.origin_connection_limit }),
	};
}

function existingCaCertificateId(config: HyperdriveConfig): string {
	const value = config.mtls?.ca_certificate_id;
	if (!value) {
		throw new Error(
			`Existing Hyperdrive ${RESOURCE_NAMES.hyperdrive} has no pinned CA certificate`,
		);
	}
	return validateHyperdriveCaCertificateId(
		value,
		`Existing Hyperdrive ${RESOURCE_NAMES.hyperdrive} CA certificate ID`,
	);
}

function resolveHyperdriveCaCertificateId(
	config: SelfHostConfig,
	options: HyperdriveReconciliationOptions,
	existing?: HyperdriveConfig,
): {
	caCertificateId: string;
	caCertificateAction: CloudflareResourcePlan["hyperdrive"]["caCertificateAction"];
} {
	const configured = config.cloudflare.hyperdriveCaCertificateId
		? validateHyperdriveCaCertificateId(
				config.cloudflare.hyperdriveCaCertificateId,
			)
		: undefined;
	const requested = options.requestedCaCertificateId
		? validateHyperdriveCaCertificateId(
				options.requestedCaCertificateId,
				"--hyperdrive-ca-certificate-id",
			)
		: undefined;
	const expectedCurrent = options.expectedCurrentCaCertificateId
		? validateHyperdriveCaCertificateId(
				options.expectedCurrentCaCertificateId,
				"expected Hyperdrive CA certificate ID",
			)
		: undefined;
	if (!existing) {
		const desired = requested ?? configured;
		if (!desired) {
			throw new Error(
				"cloudflare.hyperdriveCaCertificateId is required before creating Hyperdrive with sslmode=verify-full",
			);
		}
		return { caCertificateId: desired, caCertificateAction: "set" };
	}

	const current = existingCaCertificateId(existing);
	const exactOperatorPin = config.resources?.hyperdriveId === existing.id;
	if (!exactOperatorPin && configured && configured !== current) {
		throw new Error(
			`Existing name-resolved Hyperdrive ${RESOURCE_NAMES.hyperdrive} CA certificate conflicts with relayapi.selfhost.json; CA rotation requires the exact operator-pinned resource ID`,
		);
	}
	if (!configured && !exactOperatorPin) {
		throw new Error(
			"A legacy config may adopt a Hyperdrive CA certificate only from its exact pinned resource ID; set cloudflare.hyperdriveCaCertificateId explicitly",
		);
	}
	if (requested) {
		if (!configured && current !== requested) {
			throw new Error(
				"A legacy exact-pinned config must first adopt and persist its currently attached Hyperdrive CA certificate before rotating to a different explicit target",
			);
		}
		if (requested !== current && !exactOperatorPin) {
			throw new Error(
				`Hyperdrive CA rotation requires the exact operator-pinned resources.hyperdriveId; name-only resources cannot be rotated`,
			);
		}

		const authorizedCaCertificateIds = new Set([requested]);
		if (configured && configured !== requested) {
			authorizedCaCertificateIds.add(configured);
		}
		if (expectedCurrent) {
			authorizedCaCertificateIds.add(expectedCurrent);
		}
		if (!authorizedCaCertificateIds.has(current)) {
			throw new Error(
				`Hyperdrive CA certificate changed to an unexpected third state; expected ${[...authorizedCaCertificateIds].join(" or ")}`,
			);
		}
		if (requested === current) {
			return {
				caCertificateId: current,
				caCertificateAction: configured ? "retain" : "adopt",
			};
		}
		return {
			caCertificateId: requested,
			caCertificateAction: "rotate",
		};
	}
	if (configured && configured !== current) {
		throw new Error(
			`Existing Hyperdrive ${RESOURCE_NAMES.hyperdrive} CA certificate conflicts with relayapi.selfhost.json; pass --hyperdrive-ca-certificate-id explicitly to rotate the exact pinned resource`,
		);
	}
	return {
		caCertificateId: current,
		caCertificateAction: configured ? "retain" : "adopt",
	};
}

function visibleHyperdriveDrift(
	config: HyperdriveConfig,
	database: ParsedPostgresUrl,
): string[] {
	const drift: string[] = [];
	if (config.name !== RESOURCE_NAMES.hyperdrive) drift.push("name");
	if (config.caching?.disabled !== true) drift.push("caching.disabled");
	if (currentSslmode(config) !== database.sslmode) drift.push("mtls.sslmode");
	return drift;
}

function assertHyperdriveMatchesDesired(
	config: HyperdriveConfig,
	id: string,
	desired: DesiredHyperdriveConfig,
): void {
	if (
		config.id !== id ||
		config.name !== desired.name ||
		config.origin?.host?.toLowerCase() !== desired.origin.host.toLowerCase() ||
		(config.origin?.port ?? 5432) !== desired.origin.port ||
		config.origin?.database !== desired.origin.database ||
		config.origin?.user !== desired.origin.user ||
		!equivalentPostgresScheme(config.origin?.scheme) ||
		config.caching?.disabled !== true ||
		currentSslmode(config) !== desired.mtls.sslmode ||
		existingCaCertificateId(config) !== desired.mtls.ca_certificate_id ||
		config.mtls?.mtls_certificate_id !== desired.mtls.mtls_certificate_id ||
		(desired.origin_connection_limit !== undefined &&
			config.origin_connection_limit !== desired.origin_connection_limit)
	) {
		throw new Error("Hyperdrive reconciliation has not converged");
	}
}

function wait(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class CloudflareClient {
	readonly accountId: string;
	readonly token: string;
	readonly baseUrl: string;

	constructor(
		accountId: string,
		token: string,
		baseUrl = "https://api.cloudflare.com/client/v4",
	) {
		if (!accountId || !token) {
			throw new Error("Cloudflare account ID and API token are required");
		}
		this.accountId = accountId;
		this.token = token;
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	private async requestEnvelope<T>(
		method: "GET" | "POST" | "PUT" | "PATCH",
		path: string,
		body?: unknown,
		headers?: Record<string, string>,
	): Promise<ApiEnvelope<T>> {
		let response: Response;
		let bytes: Uint8Array;
		try {
			({ response, bytes } = await fetchBounded(
				`${this.baseUrl}${path}`,
				{
					method,
					headers: {
						Authorization: `Bearer ${this.token}`,
						...(body === undefined
							? {}
							: { "Content-Type": "application/json" }),
						...headers,
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				},
				{
					label: "Cloudflare API request",
					maxBytes: MAX_CLOUDFLARE_RESPONSE_BYTES,
				},
			));
		} catch (error) {
			throw new Error(
				redactSensitiveText(
					error instanceof Error
						? error.message
						: "Cloudflare API request failed",
					body,
				),
			);
		}
		let envelope: ApiEnvelope<T>;
		try {
			envelope = parseJsonBytes<ApiEnvelope<T>>(
				bytes,
				"Cloudflare API request",
			);
		} catch {
			throw new Error(`Cloudflare API returned HTTP ${response.status}`);
		}
		if (!response.ok || !envelope.success) {
			throw new Error(
				redactSensitiveText(errorMessage(envelope, response.status), body),
			);
		}
		return envelope;
	}

	private async request<T>(
		method: "GET" | "POST" | "PUT" | "PATCH",
		path: string,
		body?: unknown,
		headers?: Record<string, string>,
	): Promise<T> {
		return (await this.requestEnvelope<T>(method, path, body, headers)).result;
	}

	private r2Request<T>(
		method: "GET" | "POST" | "PUT",
		path: string,
		jurisdiction: "default" | "eu",
		body?: unknown,
	): Promise<T> {
		return this.request(method, path, body, {
			"cf-r2-jurisdiction": jurisdiction,
		});
	}

	private r2RequestEnvelope<T>(
		method: "GET" | "POST" | "PUT",
		path: string,
		jurisdiction: "default" | "eu",
		body?: unknown,
	): Promise<ApiEnvelope<T>> {
		return this.requestEnvelope(method, path, body, {
			"cf-r2-jurisdiction": jurisdiction,
		});
	}

	private account(path: string): string {
		return `/accounts/${encodeURIComponent(this.accountId)}${path}`;
	}

	async verifyAccess(zoneId: string): Promise<void> {
		const zone = await this.request<{ id: string; account?: { id?: string } }>(
			"GET",
			`/zones/${encodeURIComponent(zoneId)}`,
		);
		if (zone.id !== zoneId || zone.account?.id !== this.accountId) {
			throw new Error(
				"The configured zone does not belong to the configured Cloudflare account",
			);
		}
	}

	async listKvNamespaces(): Promise<KvNamespace[]> {
		return this.listPageNumbered<KvNamespace>(
			this.account("/storage/kv/namespaces"),
			1_000,
		);
	}

	async listBuckets(jurisdiction: "default" | "eu"): Promise<R2Bucket[]> {
		const buckets: R2Bucket[] = [];
		let cursor: string | undefined;
		const seen = new Set<string>();
		for (let page = 0; page < MAX_CLOUDFLARE_LIST_PAGES; page += 1) {
			const query = new URLSearchParams({ per_page: "1000" });
			if (cursor) query.set("cursor", cursor);
			const envelope = await this.r2RequestEnvelope<{ buckets: R2Bucket[] }>(
				"GET",
				this.account(`/r2/buckets?${query}`),
				jurisdiction,
			);
			buckets.push(...(envelope.result.buckets ?? []));
			const next = envelope.result_info?.cursor;
			if (!next) return buckets;
			if (seen.has(next)) {
				throw new Error("Cloudflare R2 bucket pagination repeated a cursor");
			}
			seen.add(next);
			cursor = next;
		}
		throw new Error(
			`Cloudflare R2 bucket pagination exceeded ${MAX_CLOUDFLARE_LIST_PAGES} pages`,
		);
	}

	async listQueues(): Promise<Queue[]> {
		return this.listPageNumbered<Queue>(this.account("/queues"), 100);
	}

	async listHyperdrives(): Promise<HyperdriveConfig[]> {
		return this.listPageNumbered<HyperdriveConfig>(
			this.account("/hyperdrive/configs"),
			100,
		);
	}

	private async listPageNumbered<T>(
		path: string,
		perPage: number,
	): Promise<T[]> {
		const results: T[] = [];
		for (let page = 1; page <= MAX_CLOUDFLARE_LIST_PAGES; page += 1) {
			const envelope = await this.requestEnvelope<T[]>(
				"GET",
				`${path}?per_page=${perPage}&page=${page}`,
			);
			if (!Array.isArray(envelope.result)) {
				throw new Error("Cloudflare list request returned an invalid result");
			}
			results.push(...envelope.result);
			const info = envelope.result_info;
			const complete =
				(info?.total_pages !== undefined && page >= info.total_pages) ||
				(info?.total_count !== undefined &&
					results.length >= info.total_count) ||
				((info === undefined ||
					(info.total_pages === undefined && info.total_count === undefined)) &&
					envelope.result.length < perPage);
			if (complete) return results;
			if (envelope.result.length === 0) {
				throw new Error(
					"Cloudflare list pagination ended before the advertised total",
				);
			}
		}
		throw new Error(
			`Cloudflare list pagination exceeded ${MAX_CLOUDFLARE_LIST_PAGES} pages`,
		);
	}

	async getHyperdrive(id: string): Promise<HyperdriveConfig> {
		const config = await this.request<HyperdriveConfig>(
			"GET",
			this.account(`/hyperdrive/configs/${encodeURIComponent(id)}`),
		);
		if (config.id !== id) {
			throw new Error(
				"Cloudflare returned a different Hyperdrive configuration",
			);
		}
		return config;
	}

	private async planHyperdrive(
		config: SelfHostConfig,
		database: ParsedPostgresUrl,
		options: HyperdriveReconciliationOptions,
	): Promise<CloudflareResourcePlan["hyperdrive"]> {
		const pinnedId = config.resources?.hyperdriveId;
		if (pinnedId) {
			// Resolve the immutable operator-pinned ID before consulting mutable names.
			const existing = await this.getHyperdrive(pinnedId);
			const hyperdrives = await this.listHyperdrives();
			const collision = hyperdrives.find(
				(item) =>
					item.name === RESOURCE_NAMES.hyperdrive && item.id !== pinnedId,
			);
			if (collision) {
				throw new Error(
					`Hyperdrive name ${RESOURCE_NAMES.hyperdrive} belongs to a different configuration than relayapi.selfhost.json`,
				);
			}
			assertSafeHyperdriveOrigin(existing, database);
			const caCertificate = resolveHyperdriveCaCertificateId(
				config,
				options,
				existing,
			);
			return {
				name: RESOURCE_NAMES.hyperdrive,
				id: pinnedId,
				currentCaCertificateId: existingCaCertificateId(existing),
				...caCertificate,
				action: "reconcile",
				visibleDrift: visibleHyperdriveDrift(existing, database),
				credentialAction: "reapply_write_only",
			};
		}

		const hyperdrives = await this.listHyperdrives();
		const matches = hyperdrives.filter(
			(item) => item.name === RESOURCE_NAMES.hyperdrive,
		);
		if (matches.length > 1) {
			throw new Error(
				`Multiple Hyperdrive configurations are named ${RESOURCE_NAMES.hyperdrive}`,
			);
		}
		const existing = matches[0];
		if (!existing) {
			const caCertificate = resolveHyperdriveCaCertificateId(config, options);
			return {
				name: RESOURCE_NAMES.hyperdrive,
				...caCertificate,
				action: "create",
				visibleDrift: [],
				credentialAction: "set",
			};
		}
		const exact = await this.getHyperdrive(existing.id);
		assertSafeHyperdriveOrigin(exact, database);
		const caCertificate = resolveHyperdriveCaCertificateId(
			config,
			options,
			exact,
		);
		return {
			name: RESOURCE_NAMES.hyperdrive,
			id: exact.id,
			currentCaCertificateId: existingCaCertificateId(exact),
			...caCertificate,
			action: "reconcile",
			visibleDrift: visibleHyperdriveDrift(exact, database),
			credentialAction: "reapply_write_only",
		};
	}

	async plan(
		config: SelfHostConfig,
		runtimeDatabaseUrl: string,
		options: HyperdriveReconciliationOptions = {},
	): Promise<CloudflareResourcePlan> {
		const jurisdiction = config.cloudflare.r2Jurisdiction;
		const database = parsePostgresUrl(runtimeDatabaseUrl);
		const otherJurisdiction = jurisdiction === "default" ? "eu" : "default";
		const hyperdrive = await this.planHyperdrive(config, database, options);
		const [kv, buckets, otherBuckets, queues] = await Promise.all([
			this.listKvNamespaces(),
			this.listBuckets(jurisdiction),
			this.listBuckets(otherJurisdiction),
			this.listQueues(),
		]);
		const kvMatches = kv.filter((item) => item.title === RESOURCE_NAMES.kv);
		if (kvMatches.length > 1) {
			throw new Error(`Multiple KV namespaces are named ${RESOURCE_NAMES.kv}`);
		}
		const bucketNames = new Set(buckets.map((item) => item.name));
		const bucketNamesInOtherJurisdiction = new Set(
			otherBuckets.map((item) => item.name),
		);
		const mismatchedBucket = Object.values(RESOURCE_NAMES.buckets).find(
			(name) => bucketNamesInOtherJurisdiction.has(name),
		);
		if (mismatchedBucket) {
			throw new Error(
				`R2 bucket ${mismatchedBucket} already exists in ${otherJurisdiction}; bucket jurisdiction is immutable`,
			);
		}
		const queueByName = new Map(queues.map((item) => [item.queue_name, item]));
		return {
			kv: {
				name: RESOURCE_NAMES.kv,
				...(kvMatches[0] ? { id: kvMatches[0].id } : {}),
				action: kvMatches[0] ? "reuse" : "create",
			},
			buckets: Object.values(RESOURCE_NAMES.buckets).map((name) => ({
				name,
				jurisdiction,
				action: bucketNames.has(name) ? "reuse" : "create",
			})),
			queues: QUEUE_NAMES.map((logicalName) => {
				const name = cloudflareQueueName(logicalName);
				const existing = queueByName.get(name);
				return {
					logicalName,
					name,
					...(existing ? { id: existing.queue_id } : {}),
					messageRetentionSeconds: QUEUE_MESSAGE_RETENTION_SECONDS,
					...(existing?.settings?.message_retention_period === undefined
						? {}
						: {
								currentMessageRetentionSeconds:
									existing.settings.message_retention_period,
							}),
					action: existing ? "reuse" : "create",
				};
			}),
			hyperdrive,
		};
	}

	async apply(
		config: SelfHostConfig,
		runtimeDatabaseUrl: string,
		options: HyperdriveReconciliationOptions = {},
	): Promise<NonNullable<SelfHostConfig["resources"]>> {
		const jurisdiction = config.cloudflare.r2Jurisdiction;
		const plan = await this.plan(config, runtimeDatabaseUrl, options);
		if (config.resources) {
			if (
				plan.kv.id !== config.resources.kvNamespaceId ||
				plan.hyperdrive.id !== config.resources.hyperdriveId ||
				plan.queues.some(
					(queue) => config.resources?.queues[queue.logicalName] !== queue.id,
				)
			) {
				throw new Error(
					"Provisioned Cloudflare resource IDs drifted from relayapi.selfhost.json",
				);
			}
		}
		let kvNamespaceId = plan.kv.id;
		if (!kvNamespaceId) {
			const created = await this.request<KvNamespace>(
				"POST",
				this.account("/storage/kv/namespaces"),
				{ title: RESOURCE_NAMES.kv },
			);
			kvNamespaceId = created.id;
		}

		for (const bucket of plan.buckets) {
			if (bucket.action === "create") {
				await this.r2Request(
					"POST",
					this.account("/r2/buckets"),
					jurisdiction,
					{ name: bucket.name },
				);
			}
		}

		const queueIds = {} as Record<QueueName, string>;
		for (const queue of plan.queues) {
			let id = queue.id;
			let currentMessageRetentionSeconds = queue.currentMessageRetentionSeconds;
			if (!id) {
				const created = await this.request<Queue>(
					"POST",
					this.account("/queues"),
					{ queue_name: queue.name },
				);
				id = created.queue_id;
				currentMessageRetentionSeconds =
					created.settings?.message_retention_period;
			}
			await this.ensureQueueMessageRetention(
				id,
				queue.name,
				currentMessageRetentionSeconds,
			);
			queueIds[queue.logicalName] = id;
		}

		const database = parsePostgresUrl(runtimeDatabaseUrl);
		let hyperdriveId = plan.hyperdrive.id;
		if (plan.hyperdrive.action === "create") {
			const desired = desiredHyperdriveConfig(
				database,
				plan.hyperdrive.caCertificateId,
			);
			const created = await this.request<HyperdriveConfig>(
				"POST",
				this.account("/hyperdrive/configs"),
				desired,
			);
			if (!created.id || created.name !== RESOURCE_NAMES.hyperdrive) {
				throw new Error(
					"Cloudflare returned an invalid Hyperdrive create result",
				);
			}
			hyperdriveId = created.id;
			await this.verifyHyperdriveConvergence(hyperdriveId, desired);
		} else {
			if (!hyperdriveId) {
				throw new Error(
					"The Hyperdrive reconciliation plan has no resource ID",
				);
			}
			const existing = await this.getHyperdrive(hyperdriveId);
			assertSafeHyperdriveOrigin(existing, database);
			const currentCaCertificateId = existingCaCertificateId(existing);
			const expectedCurrentCaCertificateId =
				options.expectedCurrentCaCertificateId === undefined
					? undefined
					: validateHyperdriveCaCertificateId(
							options.expectedCurrentCaCertificateId,
							"expected Hyperdrive CA certificate ID",
						);
			if (
				currentCaCertificateId !== plan.hyperdrive.currentCaCertificateId &&
				currentCaCertificateId !== plan.hyperdrive.caCertificateId &&
				currentCaCertificateId !== expectedCurrentCaCertificateId
			) {
				throw new Error(
					`Hyperdrive CA certificate changed to an unexpected third state before PATCH; expected ${expectedCurrentCaCertificateId ?? plan.hyperdrive.currentCaCertificateId} or requested target ${plan.hyperdrive.caCertificateId}`,
				);
			}
			const desired = desiredHyperdriveConfig(
				database,
				plan.hyperdrive.caCertificateId,
				existing,
			);
			const updated = await this.request<HyperdriveConfig>(
				"PATCH",
				this.account(`/hyperdrive/configs/${encodeURIComponent(hyperdriveId)}`),
				desired,
			);
			assertHyperdriveMatchesDesired(updated, hyperdriveId, desired);
			await this.verifyHyperdriveConvergence(hyperdriveId, desired);
		}
		if (!hyperdriveId)
			throw new Error("Cloudflare did not provide a Hyperdrive ID");

		await this.configureBucketPolicies(config, queueIds, jurisdiction);

		return { kvNamespaceId, hyperdriveId, queues: queueIds };
	}

	private async verifyHyperdriveConvergence(
		id: string,
		desired: DesiredHyperdriveConfig,
	): Promise<void> {
		let lastError: unknown;
		for (
			let attempt = 0;
			attempt <= HYPERDRIVE_VERIFY_DELAYS_MS.length;
			attempt++
		) {
			try {
				const current = await this.getHyperdrive(id);
				assertHyperdriveMatchesDesired(current, id, desired);
				return;
			} catch (error) {
				lastError = error;
				const delay = HYPERDRIVE_VERIFY_DELAYS_MS[attempt];
				if (delay === undefined) break;
				await wait(delay);
			}
		}
		throw new Error(
			lastError instanceof Error
				? redactSensitiveText(lastError.message, desired)
				: "Hyperdrive reconciliation could not be verified",
		);
	}

	private async ensureQueueMessageRetention(
		queueId: string,
		queueName: string,
		currentMessageRetentionSeconds?: number,
	): Promise<void> {
		let current = currentMessageRetentionSeconds;
		if (current === undefined) {
			const existing = await this.request<Queue>(
				"GET",
				this.account(`/queues/${encodeURIComponent(queueId)}`),
			);
			if (existing.queue_id !== queueId || existing.queue_name !== queueName) {
				throw new Error(
					`Cloudflare Queue ${queueName} did not resolve to its planned resource`,
				);
			}
			current = existing.settings?.message_retention_period;
		}
		if (current === QUEUE_MESSAGE_RETENTION_SECONDS) return;

		const updated = await this.request<Queue>(
			"PUT",
			this.account(`/queues/${encodeURIComponent(queueId)}`),
			{
				queue_name: queueName,
				settings: {
					message_retention_period: QUEUE_MESSAGE_RETENTION_SECONDS,
				},
			},
		);
		if (
			updated.queue_id !== queueId ||
			updated.queue_name !== queueName ||
			updated.settings?.message_retention_period !==
				QUEUE_MESSAGE_RETENTION_SECONDS
		) {
			throw new Error(
				`Cloudflare Queue ${queueName} did not accept the 24-hour message-retention policy`,
			);
		}
	}

	private async configureBucketPolicies(
		config: SelfHostConfig,
		queues: Record<QueueName, string>,
		jurisdiction: "default" | "eu",
	): Promise<void> {
		const mediaCleanupQueueId = queues["media-cleanup"];
		if (!mediaCleanupQueueId) {
			throw new Error("The media cleanup queue was not provisioned");
		}
		for (const bucket of Object.values(RESOURCE_NAMES.buckets)) {
			await this.ensureBucketLifecycle(
				bucket,
				bucket === RESOURCE_NAMES.buckets.media
					? { id: "relayapi-media-expiry", expireDays: 30 }
					: bucket === RESOURCE_NAMES.buckets.queueRescue
						? { id: "relayapi-queue-rescue-expiry", expireDays: 30 }
						: undefined,
				jurisdiction,
			);
		}
		await this.r2Request(
			"PUT",
			this.account(
				`/event_notifications/r2/${encodeURIComponent(RESOURCE_NAMES.buckets.media)}/configuration/queues/${encodeURIComponent(mediaCleanupQueueId)}`,
			),
			jurisdiction,
			{
				rules: [
					{
						prefix: "",
						suffix: "",
						actions: [
							"PutObject",
							"CompleteMultipartUpload",
							"CopyObject",
							"DeleteObject",
							"LifecycleDeletion",
						],
						description: "RelayAPI media thumbnail and cleanup events",
					},
				],
			},
		);

		await this.ensureBucketDomain(
			RESOURCE_NAMES.buckets.media,
			config.cloudflare.mediaHostname,
			config.cloudflare.zoneId,
			jurisdiction,
		);
		await this.ensureBucketDomain(
			RESOURCE_NAMES.buckets.thumbnails,
			config.cloudflare.thumbnailHostname,
			config.cloudflare.zoneId,
			jurisdiction,
		);
	}

	private async ensureBucketLifecycle(
		bucket: string,
		expiration: { id: string; expireDays: number } | undefined,
		jurisdiction: "default" | "eu",
	): Promise<void> {
		const path = this.account(
			`/r2/buckets/${encodeURIComponent(bucket)}/lifecycle`,
		);
		const current = await this.r2Request<{
			rules?: Array<Record<string, unknown>>;
		}>("GET", path, jurisdiction);
		const managedIds = new Set([
			"relayapi-abort-incomplete-multipart",
			...(expiration ? [expiration.id] : []),
		]);
		const rules = (current.rules ?? []).filter(
			(rule) => !managedIds.has(String(rule.id)),
		);
		rules.push({
			id: "relayapi-abort-incomplete-multipart",
			enabled: true,
			conditions: { prefix: "" },
			abortMultipartUploadsTransition: {
				condition: {
					type: "Age",
					maxAge: INCOMPLETE_MULTIPART_RETENTION_SECONDS,
				},
			},
		});
		if (expiration) {
			rules.push({
				id: expiration.id,
				enabled: true,
				conditions: { prefix: "" },
				deleteObjectsTransition: {
					condition: {
						type: "Age",
						maxAge: expiration.expireDays * 86_400,
					},
				},
			});
		}
		await this.r2Request("PUT", path, jurisdiction, { rules });
	}

	private async ensureBucketDomain(
		bucket: string,
		hostname: string,
		zoneId: string,
		jurisdiction: "default" | "eu",
	): Promise<void> {
		const domains = await this.r2Request<{
			domains: Array<{ domain: string }>;
		}>(
			"GET",
			this.account(`/r2/buckets/${encodeURIComponent(bucket)}/domains/custom`),
			jurisdiction,
		);
		if (!domains.domains.some((item) => item.domain === hostname)) {
			await this.r2Request(
				"POST",
				this.account(
					`/r2/buckets/${encodeURIComponent(bucket)}/domains/custom`,
				),
				jurisdiction,
				{
					domain: hostname,
					zoneId,
					minTLS: "1.2",
					enabled: true,
				},
			);
		}
	}
}

export function parsePostgresUrl(value: string): {
	hostname: string;
	port: number;
	database: string;
	username: string;
	password: string;
	sslmode: "require" | "verify-ca" | "verify-full";
} {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Database URL is not a valid URL");
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new Error("Database URL must use postgres:// or postgresql://");
	}
	const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
	const username = decodeURIComponent(url.username);
	const password = decodeURIComponent(url.password);
	if (!url.hostname || !database || !username || !password) {
		throw new Error(
			"Database URL must contain host, database, username, and password",
		);
	}
	const configuredSslmode = url.searchParams.get("sslmode") ?? "require";
	if (!["require", "verify-ca", "verify-full"].includes(configuredSslmode)) {
		throw new Error(
			"Database sslmode must be require, verify-ca, or verify-full",
		);
	}
	return {
		hostname: url.hostname,
		port: url.port ? Number(url.port) : 5432,
		database,
		username,
		password,
		sslmode: configuredSslmode as "require" | "verify-ca" | "verify-full",
	};
}
