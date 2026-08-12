import {
	adReportJobs,
	adReportRows,
	createDb,
	type Database,
	organization,
} from "@relayapi/db";
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
	classifyProviderReadError,
	exponentialBackoffSeconds,
} from "../lib/async-policy";
import {
	createBoundedReadableBody,
	fetchPublicUrl,
	ResponseTooLargeError,
} from "../lib/fetch-public-url";
import { AdReportProviderRequest } from "../schemas/ads-advanced";
import type { Env } from "../types";
import { getAdvancedAdReportAdapter } from "./ad-advanced-reports";
import type { AdProviderCredentials } from "./ad-platforms/types";
import {
	AdAuthoritativeNotAppliedError,
	AdPlatformError,
} from "./ad-platforms/types";
import { lockAdProviderBoundary } from "./ad-provider-boundary";
import {
	type AdReportArtifactFormat,
	type AdReportRequest,
	parseAdReportRows,
} from "./ad-report-normalization";

type ReportJob = typeof adReportJobs.$inferSelect;
type ReportRowInsert = typeof adReportRows.$inferInsert;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface AdvancedAdReportQueueMessage {
	type: "advanced_report";
	org_id: string;
	report_job_id: string;
}

export const AD_REPORT_POLICY = {
	leaseSeconds: 5 * 60,
	maxAutomaticAttempts: 30,
	recoveryLimit: 100,
	maxClaimsPerTenant: 5,
	providerDownloadMaxBytes: 32 * 1024 * 1024,
	decompressedMaxBytes: 64 * 1024 * 1024,
	inlineMaxBytes: 4 * 1024 * 1024,
	resultRetentionDays: 7,
	terminalJobRetentionDays: 90,
	retentionRowBatch: 5_000,
	retentionRowMaxPasses: 20,
	retry: {
		baseSeconds: 15,
		capSeconds: 15 * 60,
		jitterRatio: 0.2,
	},
} as const;

class LostAdReportLeaseError extends Error {
	constructor() {
		super("The advanced ad report lease was lost");
		this.name = "LostAdReportLeaseError";
	}
}

function sanitizeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error))
		.replace(
			/\b(bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,
			"$1=[redacted]",
		)
		.slice(0, 2_000);
}

function resultObjectKey(
	job: Pick<ReportJob, "organizationId" | "id">,
): string {
	const organizationId = job.organizationId.replace(/[^A-Za-z0-9_-]/g, "_");
	const jobId = job.id.replace(/[^A-Za-z0-9_-]/g, "_");
	return `ad-reports/${organizationId}/${jobId}/result`;
}

function artifactFormat(request: AdReportRequest): AdReportArtifactFormat {
	if (request.platform === "twitter" || request.platform === "linkedin") {
		return "json";
	}
	return "csv";
}

function artifactContentType(format: AdReportArtifactFormat): string {
	switch (format) {
		case "csv":
			return "text/csv; charset=utf-8";
		case "json":
			return "application/json";
	}
}

function parseRequest(job: ReportJob): AdReportRequest {
	const parsed = AdReportProviderRequest.safeParse(job.requestPayload);
	if (!parsed.success) {
		throw new AdAuthoritativeNotAppliedError(
			"INVALID_STORED_REPORT_REQUEST",
			"The durable ad report request no longer matches the provider contract",
		);
	}
	if (parsed.data.platform !== job.platform) {
		throw new AdAuthoritativeNotAppliedError(
			"INVALID_STORED_REPORT_REQUEST",
			"The durable ad report platform does not match its account authority",
		);
	}
	return parsed.data;
}

function retryAt(job: ReportJob, now: Date): Date {
	const seconds = exponentialBackoffSeconds(
		job.attempts,
		AD_REPORT_POLICY.retry,
		`${job.id}:${job.leaseToken}`,
	);
	return new Date(now.getTime() + seconds * 1_000);
}

function permanentProviderError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AdReportParseError")
		return true;
	if (error instanceof ResponseTooLargeError) return true;
	if (error instanceof AdAuthoritativeNotAppliedError) return true;
	if (error instanceof AdPlatformError) {
		return new Set([
			"ADS_CONNECTION_REQUIRED",
			"ADS_CONNECTION_REVOKED",
			"ADS_CONNECTION_EXPIRED",
			"ADS_CONNECTION_AUTH_FAILED",
			"ADS_PROVIDER_NOT_CONFIGURED",
			"ADS_SCOPE_MISSING",
			"ADS_APPROVAL_REQUIRED",
			"INVALID_PROVIDER_OPTIONS",
			"INVALID_PROVIDER_RESOURCE",
			"PROVIDER_PROTOCOL_ERROR",
		]).has(error.code);
	}
	return classifyProviderReadError(error) === "permanent";
}

function resultExpiry(now: Date): Date {
	return new Date(
		now.getTime() + AD_REPORT_POLICY.resultRetentionDays * 86_400_000,
	);
}

async function updateLeasedJob(
	db: Database | Transaction,
	job: ReportJob,
	values: Partial<typeof adReportJobs.$inferInsert>,
): Promise<ReportJob> {
	const [updated] = await db
		.update(adReportJobs)
		.set(values)
		.where(
			and(
				eq(adReportJobs.id, job.id),
				eq(adReportJobs.organizationId, job.organizationId),
				eq(adReportJobs.leaseToken, job.leaseToken),
			),
		)
		.returning();
	if (!updated) throw new LostAdReportLeaseError();
	return updated;
}

async function claimReportJob(
	db: Database,
	input: { organizationId: string; reportJobId: string; now: Date },
): Promise<ReportJob | null> {
	const leaseExpiresAt = new Date(
		input.now.getTime() + AD_REPORT_POLICY.leaseSeconds * 1_000,
	);
	const [claimed] = await db
		.update(adReportJobs)
		.set({
			leaseToken: sql`${adReportJobs.leaseToken} + 1`,
			leaseExpiresAt,
			attempts: sql`${adReportJobs.attempts} + 1`,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(adReportJobs.id, input.reportJobId),
				eq(adReportJobs.organizationId, input.organizationId),
				inArray(adReportJobs.status, [
					"pending",
					"provider_pending",
					"downloading",
				]),
				or(
					isNull(adReportJobs.nextAttemptAt),
					lte(adReportJobs.nextAttemptAt, input.now),
				),
				or(
					isNull(adReportJobs.leaseExpiresAt),
					lte(adReportJobs.leaseExpiresAt, input.now),
				),
			),
		)
		.returning();
	return claimed ?? null;
}

interface ReportProviderContext {
	credentials: AdProviderCredentials;
	providerAdAccountId: string;
}

async function lockExactReportAuthority(
	tx: Transaction,
	env: Env,
	job: ReportJob,
): Promise<ReportProviderContext> {
	const [tenant] = await tx
		.select({ id: organization.id })
		.from(organization)
		.where(
			and(
				eq(organization.id, job.organizationId),
				eq(organization.lifecycleStatus, "active"),
			),
		)
		.for("key share")
		.limit(1);
	if (!tenant) {
		throw new AdAuthoritativeNotAppliedError(
			"ADS_CONNECTION_REQUIRED",
			"The report tenant is no longer active",
		);
	}
	const authority = await lockAdProviderBoundary(tx, env, {
		organizationId: job.organizationId,
		workspaceId: job.workspaceId,
		adAccountId: job.adAccountId,
		platform: job.platform,
		requiresLiveEntitlement: false,
	});
	if (!authority.ok) {
		throw new AdAuthoritativeNotAppliedError(
			"ADS_CONNECTION_REQUIRED",
			authority.message,
		);
	}
	return {
		credentials: authority.context.credentials,
		providerAdAccountId: authority.context.platformAdAccountId,
	};
}

async function openSubmissionBoundary(
	db: Database,
	env: Env,
	job: ReportJob,
	now: Date,
): Promise<{ job: ReportJob; context: ReportProviderContext }> {
	return db.transaction(async (tx) => {
		// Credential/account locks are acquired before the durable marker. A
		// concurrent disconnect therefore linearizes wholly before or after the
		// provider attempt is admitted.
		const context = await lockExactReportAuthority(tx, env, job);
		const [marked] = await tx
			.update(adReportJobs)
			.set({
				status: "submitting",
				requestMayHaveBeenSentAt: now,
				lastError: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(adReportJobs.id, job.id),
					eq(adReportJobs.organizationId, job.organizationId),
					eq(adReportJobs.status, "pending"),
					eq(adReportJobs.leaseToken, job.leaseToken),
				),
			)
			.returning();
		if (!marked) throw new LostAdReportLeaseError();
		return { job: marked, context };
	});
}

async function resolveReadAuthority(
	db: Database,
	env: Env,
	job: ReportJob,
): Promise<ReportProviderContext> {
	return db.transaction((tx) => lockExactReportAuthority(tx, env, job));
}

async function failJob(
	db: Database,
	job: ReportJob,
	error: unknown,
	now: Date,
): Promise<void> {
	await updateLeasedJob(db, job, {
		status: "failed",
		leaseExpiresAt: null,
		nextAttemptAt: null,
		lastError: sanitizeError(error),
		updatedAt: now,
		completedAt: now,
	});
}

async function markUnknown(
	db: Database,
	job: ReportJob,
	error: unknown,
	now: Date,
): Promise<void> {
	await updateLeasedJob(db, job, {
		status: "unknown",
		leaseExpiresAt: null,
		nextAttemptAt: null,
		lastError: sanitizeError(error),
		updatedAt: now,
		completedAt: null,
	});
}

async function retryJob(
	db: Database,
	job: ReportJob,
	status: "pending" | "provider_pending" | "downloading",
	error: unknown,
	now: Date,
	options?: { clearSubmissionMarker?: boolean },
): Promise<void> {
	if (
		job.attempts >= AD_REPORT_POLICY.maxAutomaticAttempts ||
		permanentProviderError(error)
	) {
		await failJob(db, job, error, now);
		return;
	}
	await updateLeasedJob(db, job, {
		status,
		leaseExpiresAt: null,
		nextAttemptAt: retryAt(job, now),
		lastError: sanitizeError(error),
		updatedAt: now,
		...(options?.clearSubmissionMarker
			? { requestMayHaveBeenSentAt: null }
			: {}),
	});
}

async function waitForProvider(
	db: Database,
	job: ReportJob,
	now: Date,
): Promise<void> {
	await updateLeasedJob(db, job, {
		status: "provider_pending",
		leaseExpiresAt: null,
		nextAttemptAt: retryAt(job, now),
		lastError: null,
		updatedAt: now,
	});
}

async function beginDownload(
	db: Database,
	job: ReportJob,
	now: Date,
): Promise<ReportJob> {
	return updateLeasedJob(db, job, {
		status: "downloading",
		leaseExpiresAt: new Date(
			now.getTime() + AD_REPORT_POLICY.leaseSeconds * 1_000,
		),
		nextAttemptAt: now,
		lastError: null,
		updatedAt: now,
	});
}

export async function decompressGzipIfPresent(
	source: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
	const reader = source.getReader();
	const prefix: Uint8Array[] = [];
	let prefixBytes = 0;
	let sourceDone = false;
	while (prefixBytes < 2) {
		const next = await reader.read();
		if (next.done) {
			sourceDone = true;
			break;
		}
		prefix.push(next.value);
		prefixBytes += next.value.byteLength;
	}
	if (prefixBytes === 0 && sourceDone) {
		reader.releaseLock();
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
	}
	let prefixIndex = 0;
	const replay = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (prefixIndex < prefix.length) {
				controller.enqueue(prefix[prefixIndex++] as Uint8Array);
				return;
			}
			if (sourceDone) {
				reader.releaseLock();
				controller.close();
				return;
			}
			try {
				const next = await reader.read();
				if (next.done) {
					sourceDone = true;
					reader.releaseLock();
					controller.close();
				} else {
					controller.enqueue(next.value);
				}
			} catch (error) {
				reader.releaseLock();
				controller.error(error);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
			reader.releaseLock();
		},
	});
	let firstByte: number | undefined;
	let secondByte: number | undefined;
	for (const chunk of prefix) {
		for (const byte of chunk) {
			if (firstByte === undefined) firstByte = byte;
			else if (secondByte === undefined) {
				secondByte = byte;
				break;
			}
		}
		if (secondByte !== undefined) break;
	}
	const gzip = firstByte === 0x1f && secondByte === 0x8b;
	if (!gzip) return replay;
	const gzipInput = replay.pipeThrough(
		new TransformStream<Uint8Array, BufferSource>({
			transform(chunk, controller) {
				const copied = new Uint8Array(chunk.byteLength);
				copied.set(chunk);
				controller.enqueue(copied);
			},
		}),
	);
	return gzipInput.pipeThrough(new DecompressionStream("gzip"));
}

async function putBoundedArtifact(
	env: Env,
	job: ReportJob,
	request: AdReportRequest,
	format: AdReportArtifactFormat,
	source: ReadableStream<Uint8Array>,
	declaredBytes: number | null,
): Promise<string> {
	const key = resultObjectKey(job);
	const bounded = createBoundedReadableBody(
		source,
		AD_REPORT_POLICY.decompressedMaxBytes,
		declaredBytes,
	);
	const stored = await env.AD_REPORT_BUCKET.put(key, bounded.body, {
		httpMetadata: { contentType: artifactContentType(format) },
		customMetadata: {
			organization_id: job.organizationId,
			report_job_id: job.id,
			platform: request.platform,
			format,
		},
	});
	const bytesRead = await bounded.bytesRead;
	if (!stored || bytesRead <= 0) {
		throw new Error("The provider report artifact was empty or not stored");
	}
	return key;
}

async function downloadReportArtifact(
	env: Env,
	job: ReportJob,
	request: AdReportRequest,
	downloadUrl: string,
): Promise<string> {
	const response = await fetchPublicUrl(downloadUrl, {
		timeout: 60_000,
		timeoutThroughBody: true,
		maxBytes: AD_REPORT_POLICY.providerDownloadMaxBytes,
		headers: { Accept: "application/json, text/csv, application/gzip, */*" },
	});
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => {});
		throw new AdPlatformError(
			response.status === 429
				? "PROVIDER_RATE_LIMITED"
				: response.status >= 500
					? "PROVIDER_TEMPORARILY_UNAVAILABLE"
					: "PROVIDER_API_ERROR",
			`Provider report download returned HTTP ${response.status}`,
			{ status: response.status },
		);
	}
	// The runtime transparently decodes HTTP Content-Encoding. Sniffing the
	// remaining bytes handles a genuine .gz artifact without accidentally
	// double-decompressing an already-decoded response.
	const source = await decompressGzipIfPresent(response.body);
	return putBoundedArtifact(
		env,
		job,
		request,
		artifactFormat(request),
		source,
		null,
	);
}

async function storeInlineRows(
	env: Env,
	job: ReportJob,
	request: AdReportRequest,
	rows: unknown[],
): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(rows));
	if (bytes.byteLength > AD_REPORT_POLICY.inlineMaxBytes) {
		const error = new Error(
			"Inline provider report exceeded the bounded result limit",
		);
		error.name = "AdReportParseError";
		throw error;
	}
	return putBoundedArtifact(
		env,
		job,
		request,
		"json",
		new Response(bytes).body as ReadableStream<Uint8Array>,
		bytes.byteLength,
	);
}

async function normalizeStoredArtifact(
	db: Database,
	env: Env,
	job: ReportJob,
	request: AdReportRequest,
	key: string,
	now: Date,
): Promise<void> {
	const object = await env.AD_REPORT_BUCKET.get(key);
	if (!object) throw new Error("The private report artifact was not found");
	const metadataFormat = object.customMetadata?.format;
	const format: AdReportArtifactFormat =
		metadataFormat === "csv" || metadataFormat === "json"
			? metadataFormat
			: artifactFormat(request);
	const bounded = createBoundedReadableBody(
		object.body,
		AD_REPORT_POLICY.decompressedMaxBytes,
		object.size,
	);
	const expiresAt = resultExpiry(now);

	await db.transaction(async (tx) => {
		await tx
			.delete(adReportRows)
			.where(
				and(
					eq(adReportRows.reportJobId, job.id),
					eq(adReportRows.organizationId, job.organizationId),
				),
			);
		let rowNumber = 0;
		let batch: ReportRowInsert[] = [];
		const flush = async () => {
			if (batch.length === 0) return;
			await tx.insert(adReportRows).values(batch);
			batch = [];
		};
		for await (const row of parseAdReportRows(bounded.body, format, request)) {
			rowNumber++;
			batch.push({
				organizationId: job.organizationId,
				reportJobId: job.id,
				rowNumber,
				dimensions: row.dimensions,
				metrics: row.metrics,
			});
			if (batch.length >= 250) await flush();
		}
		await flush();
		await bounded.bytesRead;
		const [completed] = await tx
			.update(adReportJobs)
			.set({
				status: "completed",
				resultObjectKey: key,
				rowCount: rowNumber,
				resultExpiresAt: expiresAt,
				leaseExpiresAt: null,
				nextAttemptAt: null,
				requestMayHaveBeenSentAt: null,
				lastError: null,
				updatedAt: now,
				completedAt: now,
			})
			.where(
				and(
					eq(adReportJobs.id, job.id),
					eq(adReportJobs.organizationId, job.organizationId),
					eq(adReportJobs.status, "downloading"),
					eq(adReportJobs.leaseToken, job.leaseToken),
				),
			)
			.returning({ id: adReportJobs.id });
		if (!completed) throw new LostAdReportLeaseError();
	});
}

async function persistAndNormalize(
	db: Database,
	env: Env,
	job: ReportJob,
	request: AdReportRequest,
	store: () => Promise<string>,
	now: Date,
): Promise<void> {
	try {
		const key = await store();
		job = await updateLeasedJob(db, job, {
			resultObjectKey: key,
			// Persist expiry before parsing. If normalization fails permanently, the
			// private artifact remains discoverable by retention instead of leaking.
			resultExpiresAt: resultExpiry(now),
			updatedAt: new Date(),
		});
		await normalizeStoredArtifact(db, env, job, request, key, new Date());
	} catch (error) {
		if (error instanceof LostAdReportLeaseError) return;
		// Async provider downloads are repeatable reads. LinkedIn reporting is a
		// GET completed inline, so it is also safe to reissue from pending.
		if (job.providerJobId) {
			await retryJob(db, job, "provider_pending", error, now);
		} else if (job.platform === "linkedin") {
			await retryJob(db, job, "pending", error, now, {
				clearSubmissionMarker: true,
			});
		} else {
			await failJob(db, job, error, now);
		}
	}
}

async function submitReport(
	db: Database,
	env: Env,
	claimed: ReportJob,
	request: AdReportRequest,
	now: Date,
): Promise<void> {
	const adapter = getAdvancedAdReportAdapter(claimed.platform);
	if (!adapter) {
		await failJob(db, claimed, "No advanced report adapter is registered", now);
		return;
	}

	let boundary: Awaited<ReturnType<typeof openSubmissionBoundary>>;
	try {
		boundary = await openSubmissionBoundary(db, env, claimed, now);
	} catch (error) {
		if (error instanceof LostAdReportLeaseError) return;
		await failJob(db, claimed, error, now);
		return;
	}

	let submission: Awaited<ReturnType<typeof adapter.submit>>;
	try {
		submission = await adapter.submit(
			boundary.context.credentials,
			boundary.context.providerAdAccountId,
			request,
		);
	} catch (error) {
		if (
			claimed.platform === "linkedin" ||
			error instanceof AdAuthoritativeNotAppliedError
		) {
			await retryJob(db, boundary.job, "pending", error, now, {
				clearSubmissionMarker: true,
			});
		} else {
			// TikTok/X report creation uses POST and exposes no correlation key.
			// Once the request marker opens, replay could create a duplicate job.
			await markUnknown(db, boundary.job, error, now);
		}
		return;
	}

	if (submission.status === "provider_pending") {
		await updateLeasedJob(db, boundary.job, {
			status: "provider_pending",
			providerJobId: submission.providerJobId,
			leaseExpiresAt: null,
			nextAttemptAt: new Date(now.getTime() + 15_000),
			lastError: null,
			updatedAt: now,
		});
		return;
	}

	const downloading = await beginDownload(db, boundary.job, now);
	await persistAndNormalize(
		db,
		env,
		downloading,
		request,
		() => storeInlineRows(env, downloading, request, submission.inlineRows),
		now,
	);
}

async function pollReport(
	db: Database,
	env: Env,
	job: ReportJob,
	request: AdReportRequest,
	now: Date,
): Promise<void> {
	const adapter = getAdvancedAdReportAdapter(job.platform);
	if (!adapter || !job.providerJobId) {
		await failJob(db, job, "The provider report job identity is missing", now);
		return;
	}
	let context: ReportProviderContext;
	try {
		context = await resolveReadAuthority(db, env, job);
	} catch (error) {
		await failJob(db, job, error, now);
		return;
	}

	let status: Awaited<ReturnType<typeof adapter.status>>;
	try {
		status = await adapter.status(
			context.credentials,
			context.providerAdAccountId,
			job.providerJobId,
		);
	} catch (error) {
		await retryJob(db, job, "provider_pending", error, now);
		return;
	}

	switch (status.status) {
		case "pending":
			await waitForProvider(db, job, now);
			return;
		case "failed":
			await failJob(db, job, status.error, now);
			return;
		case "cancelled":
			await updateLeasedJob(db, job, {
				status: "cancelled",
				leaseExpiresAt: null,
				nextAttemptAt: null,
				lastError: null,
				updatedAt: now,
				completedAt: now,
			});
			return;
		case "completed": {
			const downloading = await beginDownload(db, job, now);
			if (status.inlineRows) {
				await persistAndNormalize(
					db,
					env,
					downloading,
					request,
					() =>
						storeInlineRows(env, downloading, request, status.inlineRows ?? []),
					now,
				);
				return;
			}
			if (!status.downloadUrl) {
				await failJob(
					db,
					downloading,
					"Provider completed the report without a result URL",
					now,
				);
				return;
			}
			await persistAndNormalize(
				db,
				env,
				downloading,
				request,
				() =>
					downloadReportArtifact(
						env,
						downloading,
						request,
						status.downloadUrl as string,
					),
				now,
			);
			return;
		}
	}
}

async function resumeDownload(
	db: Database,
	env: Env,
	job: ReportJob,
	request: AdReportRequest,
	now: Date,
): Promise<void> {
	const key = job.resultObjectKey ?? resultObjectKey(job);
	const existing = await env.AD_REPORT_BUCKET.head(key);
	if (existing) {
		try {
			if (job.resultObjectKey !== key || !job.resultExpiresAt) {
				job = await updateLeasedJob(db, job, {
					resultObjectKey: key,
					resultExpiresAt: resultExpiry(now),
					updatedAt: now,
				});
			}
			await normalizeStoredArtifact(db, env, job, request, key, now);
		} catch (error) {
			if (error instanceof LostAdReportLeaseError) return;
			await failJob(db, job, error, now);
		}
		return;
	}
	if (job.providerJobId) {
		await retryJob(
			db,
			job,
			"provider_pending",
			"Recovered an interrupted report download",
			now,
		);
		return;
	}
	if (job.platform === "linkedin") {
		await retryJob(
			db,
			job,
			"pending",
			"Recovered an interrupted inline report",
			now,
			{
				clearSubmissionMarker: true,
			},
		);
		return;
	}
	await markUnknown(
		db,
		job,
		"Report download cannot be correlated or replayed",
		now,
	);
}

export async function processAdvancedAdReportJob(
	env: Env,
	input: { organizationId: string; reportJobId: string; now?: Date },
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = input.now ?? new Date();
	const claimed = await claimReportJob(db, {
		organizationId: input.organizationId,
		reportJobId: input.reportJobId,
		now,
	});
	if (!claimed) return;
	if (claimed.attempts > AD_REPORT_POLICY.maxAutomaticAttempts) {
		await failJob(
			db,
			claimed,
			"Advanced ad report exhausted its automatic attempt budget",
			now,
		);
		return;
	}

	let request: AdReportRequest;
	try {
		request = parseRequest(claimed);
	} catch (error) {
		await failJob(db, claimed, error, now);
		return;
	}

	switch (claimed.status) {
		case "pending":
			await submitReport(db, env, claimed, request, now);
			return;
		case "provider_pending":
			await pollReport(db, env, claimed, request, now);
			return;
		case "downloading":
			await resumeDownload(db, env, claimed, request, now);
			return;
	}
}

export async function dispatchAdvancedAdReportJob(
	env: Pick<Env, "ADS_QUEUE">,
	input: { organizationId: string; reportJobId: string },
): Promise<void> {
	await env.ADS_QUEUE.send({
		type: "advanced_report",
		org_id: input.organizationId,
		report_job_id: input.reportJobId,
	} satisfies AdvancedAdReportQueueMessage);
}

/** Recover lost Queue handoffs and expired phase leases from PostgreSQL. */
export async function recoverAdvancedAdReportJobs(
	env: Env,
	options?: { db?: Database; now?: Date },
): Promise<number> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	// LinkedIn reporting is a GET, so an interrupted request is safe to replay.
	// Provider-job creation on TikTok/X is a POST without a correlation key and
	// must remain unknown once its durable request marker has opened.
	await db
		.update(adReportJobs)
		.set({
			status: "pending",
			requestMayHaveBeenSentAt: null,
			leaseExpiresAt: null,
			nextAttemptAt: now,
			lastError: "Recovered an interrupted LinkedIn report read",
			updatedAt: now,
		})
		.where(
			and(
				eq(adReportJobs.status, "submitting"),
				eq(adReportJobs.platform, "linkedin"),
				isNotNull(adReportJobs.requestMayHaveBeenSentAt),
				or(
					isNull(adReportJobs.leaseExpiresAt),
					lte(adReportJobs.leaseExpiresAt, now),
				),
			),
		);
	await db
		.update(adReportJobs)
		.set({
			status: "unknown",
			leaseExpiresAt: null,
			nextAttemptAt: null,
			lastError:
				"Recovered an expired submission lease after the provider request may have been sent",
			updatedAt: now,
		})
		.where(
			and(
				eq(adReportJobs.status, "submitting"),
				sql`${adReportJobs.platform} <> 'linkedin'`,
				isNotNull(adReportJobs.requestMayHaveBeenSentAt),
				or(
					isNull(adReportJobs.leaseExpiresAt),
					lte(adReportJobs.leaseExpiresAt, now),
				),
			),
		);

	const candidates = await db.execute<{
		id: string;
		organizationId: string;
	}>(sql`
		SELECT id, organization_id AS "organizationId"
		FROM (
			SELECT job.id,
			       job.organization_id,
			       row_number() OVER (
				       PARTITION BY job.organization_id
				       ORDER BY job.next_attempt_at, job.created_at, job.id
			       ) AS tenant_rank
			FROM ad_report_jobs AS job
			WHERE job.status IN ('pending', 'provider_pending', 'downloading')
			  AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= ${now})
			  AND (job.lease_expires_at IS NULL OR job.lease_expires_at <= ${now})
		) AS ranked
		WHERE tenant_rank <= ${AD_REPORT_POLICY.maxClaimsPerTenant}
		ORDER BY tenant_rank, organization_id, id
		LIMIT ${AD_REPORT_POLICY.recoveryLimit}
	`);
	const messages = candidates.map((candidate) => ({
		body: {
			type: "advanced_report",
			org_id: candidate.organizationId,
			report_job_id: candidate.id,
		} satisfies AdvancedAdReportQueueMessage,
	}));
	for (let offset = 0; offset < messages.length; offset += 100) {
		await env.ADS_QUEUE.sendBatch(messages.slice(offset, offset + 100));
	}
	return messages.length;
}

export interface AdReportRetentionResult {
	artifactsDeleted: number;
	jobsDeleted: number;
}

/** Delete private result bytes first, then their rows; retain job metadata 90d. */
export async function retainAdvancedAdReports(
	env: Env,
	options?: { db?: Database; now?: Date; limit?: number },
): Promise<AdReportRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
	const expiredArtifacts = await db
		.select({
			id: adReportJobs.id,
			organizationId: adReportJobs.organizationId,
			resultObjectKey: adReportJobs.resultObjectKey,
		})
		.from(adReportJobs)
		.where(
			and(
				isNotNull(adReportJobs.resultObjectKey),
				lte(adReportJobs.resultExpiresAt, now),
			),
		)
		.orderBy(adReportJobs.resultExpiresAt, adReportJobs.id)
		.limit(limit);

	let artifactsDeleted = 0;
	for (const artifact of expiredArtifacts) {
		if (!artifact.resultObjectKey) continue;
		const artifactKey = artifact.resultObjectKey;
		await env.AD_REPORT_BUCKET.delete(artifactKey);
		let fullyDrained = false;
		for (let pass = 0; pass < AD_REPORT_POLICY.retentionRowMaxPasses; pass++) {
			const removed = await db
				.delete(adReportRows)
				.where(
					and(
						eq(adReportRows.reportJobId, artifact.id),
						eq(adReportRows.organizationId, artifact.organizationId),
						inArray(
							adReportRows.rowNumber,
							db
								.select({ rowNumber: adReportRows.rowNumber })
								.from(adReportRows)
								.where(
									and(
										eq(adReportRows.reportJobId, artifact.id),
										eq(adReportRows.organizationId, artifact.organizationId),
									),
								)
								.orderBy(adReportRows.rowNumber)
								.limit(AD_REPORT_POLICY.retentionRowBatch),
						),
					),
				)
				.returning({ rowNumber: adReportRows.rowNumber });
			if (removed.length < AD_REPORT_POLICY.retentionRowBatch) {
				fullyDrained = true;
				break;
			}
		}
		if (!fullyDrained) {
			const [remaining] = await db
				.select({ rowNumber: adReportRows.rowNumber })
				.from(adReportRows)
				.where(
					and(
						eq(adReportRows.reportJobId, artifact.id),
						eq(adReportRows.organizationId, artifact.organizationId),
					),
				)
				.limit(1);
			if (remaining) {
				throw new Error(
					"Advanced ad report row retention exceeded its bounded drain",
				);
			}
		}
		await db
			.update(adReportJobs)
			// Preserve the terminal transition timestamp: the 90-day metadata clock
			// starts when processing terminalizes, not when seven-day bulk results are
			// minimized.
			.set({ resultObjectKey: null })
			.where(
				and(
					eq(adReportJobs.id, artifact.id),
					eq(adReportJobs.organizationId, artifact.organizationId),
					eq(adReportJobs.resultObjectKey, artifactKey),
				),
			);
		artifactsDeleted++;
	}

	const terminalCutoff = new Date(
		now.getTime() - AD_REPORT_POLICY.terminalJobRetentionDays * 86_400_000,
	);
	const deleted = await db
		.delete(adReportJobs)
		.where(
			inArray(
				adReportJobs.id,
				db
					.select({ id: adReportJobs.id })
					.from(adReportJobs)
					.where(
						and(
							inArray(adReportJobs.status, [
								"completed",
								"failed",
								"cancelled",
								"unknown",
							]),
							lte(adReportJobs.updatedAt, terminalCutoff),
							isNull(adReportJobs.resultObjectKey),
						),
					)
					.orderBy(adReportJobs.updatedAt, adReportJobs.id)
					.limit(limit),
			),
		)
		.returning({ id: adReportJobs.id });
	return { artifactsDeleted, jobsDeleted: deleted.length };
}
