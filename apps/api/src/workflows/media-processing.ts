import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import {
	createDb,
	media,
	mediaDerivatives,
	mediaProcessingJobs,
} from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import {
	createBoundedReadableBody,
	parseContentLength,
} from "../lib/fetch-public-url";
import { mediaDerivativeStorageKey } from "../lib/media-processing-key";
import {
	isAllowedMediaMimeType,
	MAX_MEDIA_UPLOAD_BYTES,
	normalizeMediaMimeType,
} from "../lib/media-storage-policy";
import { readProviderText } from "../lib/provider-response";
import {
	getStoredObject,
	storageLocatorForMedia,
} from "../services/storage-locator";
import type { Env } from "../types";

export interface MediaProcessingWorkflowParams {
	jobId: string;
	generation: number;
}

type ClaimedMediaJob = {
	claimed: true;
	jobId: string;
	generation: number;
	attempts: number;
	organizationId: string;
	workspaceId: string | null;
	scopeKey: string;
	mediaId: string;
	operation: "normalize" | "provider_variant" | "cover";
	profile: string;
	optionsJson: string;
	optionsHash: string;
	sourceEtag: string;
	sourceMimeType: string;
};

type SkippedMediaJob = { claimed: false; reason: string };

type ProcessedMedia = {
	storageKey: string;
	kind: "normalized" | "provider" | "cover" | "gif_video";
	mimeType: string;
	size: number;
	width: number | null;
	height: number | null;
	duration: number | null;
	checksumSha256: string;
};

const PROCESSING_LEASE_MS = 30 * 60 * 1000;
const MAX_PROCESSING_OPTIONS_BYTES = 8 * 1024;

function encodedOptions(optionsJson: string): string {
	const value = new TextEncoder().encode(optionsJson);
	// Base64url expands by roughly one third. Keep the encoded value plus the
	// other request headers below Node's default 16 KiB aggregate header limit.
	if (value.byteLength > MAX_PROCESSING_OPTIONS_BYTES) {
		throw new Error("Media processing options exceed 8 KiB");
	}
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function integerHeader(headers: Headers, name: string): number | null {
	const value = headers.get(name)?.trim();
	if (!value) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export class MediaProcessingWorkflow extends WorkflowEntrypoint<
	Env,
	MediaProcessingWorkflowParams
> {
	async run(
		event: Readonly<WorkflowEvent<MediaProcessingWorkflowParams>>,
		step: WorkflowStep,
	): Promise<{ status: "completed" | "skipped"; job_id: string }> {
		const claimJson = await step.do(
			"claim exact media processing generation",
			{ retries: { limit: 4, delay: "5 seconds", backoff: "exponential" } },
			async (): Promise<string> => {
				const db = createDb(this.env.HYPERDRIVE.connectionString);
				const now = new Date();
				const leaseExpiresAt = new Date(now.getTime() + PROCESSING_LEASE_MS);
				const result = await db.transaction(async (tx) => {
					const [job] = await tx
						.update(mediaProcessingJobs)
						.set({
							status: "processing",
							workflowId: event.instanceId,
							leaseToken: sql`${mediaProcessingJobs.leaseToken} + 1`,
							leaseExpiresAt,
							attempts: sql`${mediaProcessingJobs.attempts} + 1`,
							lastError: null,
							lastErrorCode: null,
							updatedAt: now,
						})
						.where(
							and(
								eq(mediaProcessingJobs.id, event.payload.jobId),
								eq(mediaProcessingJobs.status, "pending"),
								eq(mediaProcessingJobs.leaseToken, event.payload.generation),
							),
						)
						.returning();
					if (!job)
						return { claimed: false, reason: "generation_not_claimable" };
					const [source] = await tx
						.select({ record: media })
						.from(media)
						.where(
							and(
								eq(media.id, job.mediaId),
								eq(media.organizationId, job.organizationId),
								eq(media.scopeKey, job.scopeKey),
								eq(media.status, "ready"),
							),
						)
						.limit(1);
					if (!source) throw new Error("Media source is no longer ready");
					return {
						claimed: true,
						jobId: job.id,
						generation: job.leaseToken,
						attempts: job.attempts,
						organizationId: job.organizationId,
						workspaceId: job.workspaceId,
						scopeKey: job.scopeKey,
						mediaId: job.mediaId,
						operation: job.operation,
						profile: job.profile,
						optionsJson: JSON.stringify(job.options),
						optionsHash: job.optionsHash,
						sourceEtag: job.sourceEtag,
						sourceMimeType: source.record.mimeType,
					};
				});
				return JSON.stringify(result);
			},
		);
		const claim = JSON.parse(claimJson) as ClaimedMediaJob | SkippedMediaJob;
		if (
			typeof claim !== "object" ||
			claim === null ||
			typeof claim.claimed !== "boolean"
		) {
			throw new Error("Media processing claim step returned an invalid result");
		}

		if (!claim.claimed) {
			return { status: "skipped", job_id: event.payload.jobId };
		}

		let processed: ProcessedMedia | null = null;
		let projectionCommitted = false;
		try {
			processed = await step.do(
				"stream source through ffmpeg container into R2",
				{
					retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
					timeout: "15 minutes",
				},
				async (): Promise<ProcessedMedia> => {
					const db = createDb(this.env.HYPERDRIVE.connectionString);
					const [sourceRow] = await db
						.select()
						.from(media)
						.where(
							and(
								eq(media.id, claim.mediaId),
								eq(media.organizationId, claim.organizationId),
								eq(media.status, "ready"),
							),
						)
						.limit(1);
					if (!sourceRow)
						throw new Error("Media source disappeared during processing");
					const source = await getStoredObject(
						db,
						this.env,
						storageLocatorForMedia(sourceRow),
					);
					if (
						!source ||
						source.size <= 0 ||
						source.size > MAX_MEDIA_UPLOAD_BYTES
					) {
						throw new Error("Media source is missing or exceeds 200 MiB");
					}
					if (source.etag !== claim.sourceEtag) {
						throw new Error(
							"Media source changed after the processing request was created",
						);
					}

					const processor = this.env.MEDIA_PROCESSOR.get(
						this.env.MEDIA_PROCESSOR.idFromName(`media:${claim.mediaId}`),
					);
					const response = await processor.fetch(
						"http://media-processor/transform",
						{
							method: "POST",
							headers: {
								"content-type": source.contentType ?? claim.sourceMimeType,
								"content-length": String(source.size),
								"x-relay-media-operation": claim.operation,
								"x-relay-media-profile": claim.profile,
								"x-relay-media-options": encodedOptions(claim.optionsJson),
							},
							body: source.body,
						},
					);
					if (!response.ok || !response.body) {
						throw new Error(
							`Media processor failed (${response.status}): ${await readProviderText(response)}`,
						);
					}
					const mimeType = normalizeMediaMimeType(
						response.headers.get("content-type") ?? "",
					);
					if (!isAllowedMediaMimeType(mimeType)) {
						void response.body.cancel().catch(() => {});
						throw new Error(
							"Media processor returned an unsupported MIME type",
						);
					}
					const declaredSize = parseContentLength(response.headers);
					if (!declaredSize || declaredSize > MAX_MEDIA_UPLOAD_BYTES) {
						void response.body.cancel().catch(() => {});
						throw new Error("Media processor returned an invalid output size");
					}
					const checksum = response.headers.get("x-relay-sha256")?.trim() ?? "";
					const sourceChecksum =
						response.headers.get("x-relay-source-sha256")?.trim() ?? "";
					if (
						!/^[0-9a-f]{64}$/.test(checksum) ||
						!/^[0-9a-f]{64}$/.test(sourceChecksum)
					) {
						void response.body.cancel().catch(() => {});
						throw new Error("Media processor omitted required checksums");
					}
					const kind =
						claim.operation === "cover"
							? "cover"
							: claim.sourceMimeType === "image/gif" && mimeType === "video/mp4"
								? "gif_video"
								: claim.operation === "provider_variant"
									? "provider"
									: "normalized";
					const storageKey = mediaDerivativeStorageKey({
						organizationId: claim.organizationId,
						mediaId: claim.mediaId,
						jobId: claim.jobId,
						generation: claim.generation,
						kind,
						mimeType,
					});
					const bounded = createBoundedReadableBody(
						response.body,
						MAX_MEDIA_UPLOAD_BYTES,
						declaredSize,
					);
					await this.env.MEDIA_BUCKET.put(storageKey, bounded.body, {
						httpMetadata: { contentType: mimeType },
						customMetadata: {
							organizationId: claim.organizationId,
							mediaId: claim.mediaId,
							processingJobId: claim.jobId,
							processingGeneration: String(claim.generation),
							sha256: checksum,
						},
					});
					const actualSize = await bounded.bytesRead;
					if (actualSize !== declaredSize) {
						await this.env.MEDIA_BUCKET.delete(storageKey);
						throw new Error(
							"Media processor output length did not match its declaration",
						);
					}
					return {
						storageKey,
						kind,
						mimeType,
						size: actualSize,
						width: integerHeader(response.headers, "x-relay-width"),
						height: integerHeader(response.headers, "x-relay-height"),
						duration: integerHeader(response.headers, "x-relay-duration"),
						checksumSha256: checksum,
					};
				},
			);

			const committedProcessed = processed;
			if (!committedProcessed) {
				throw new Error("Media processor returned no durable result");
			}
			const commitResultJson = await step.do(
				"commit derivative projection",
				{ retries: { limit: 6, delay: "10 seconds", backoff: "exponential" } },
				async (): Promise<string> => {
					const db = createDb(this.env.HYPERDRIVE.connectionString);
					const now = new Date();
					const supersededStorageKey = await db.transaction(async (tx) => {
						// Fence the job before touching the shared derivative projection.
						// A recovered generation therefore cannot even transiently replace
						// the winner inside this transaction.
						const [saved] = await tx
							.update(mediaProcessingJobs)
							.set({
								status: "completed",
								leaseExpiresAt: null,
								completedAt: now,
								updatedAt: now,
								lastError: null,
								lastErrorCode: null,
							})
							.where(
								and(
									eq(mediaProcessingJobs.id, claim.jobId),
									eq(mediaProcessingJobs.status, "processing"),
									eq(mediaProcessingJobs.leaseToken, claim.generation),
								),
							)
							.returning({ id: mediaProcessingJobs.id });
						if (!saved) {
							throw new Error(
								"Media processing lease was lost before projection",
							);
						}

						const [existing] = await tx
							.select({ storageKey: mediaDerivatives.storageKey })
							.from(mediaDerivatives)
							.where(
								and(
									eq(mediaDerivatives.mediaId, claim.mediaId),
									eq(mediaDerivatives.kind, committedProcessed.kind),
									eq(mediaDerivatives.profile, claim.profile),
									eq(mediaDerivatives.optionsHash, claim.optionsHash),
								),
							)
							.limit(1)
							.for("update");
						await tx
							.insert(mediaDerivatives)
							.values({
								organizationId: claim.organizationId,
								workspaceId: claim.workspaceId,
								mediaId: claim.mediaId,
								processingJobId: claim.jobId,
								kind: committedProcessed.kind,
								profile: claim.profile,
								optionsHash: claim.optionsHash,
								storageKey: committedProcessed.storageKey,
								mimeType: committedProcessed.mimeType,
								size: committedProcessed.size,
								width: committedProcessed.width,
								height: committedProcessed.height,
								duration: committedProcessed.duration,
								checksumSha256: committedProcessed.checksumSha256,
								status: "ready",
								readyAt: now,
								deleteAfter: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
							})
							.onConflictDoUpdate({
								target: [
									mediaDerivatives.mediaId,
									mediaDerivatives.kind,
									mediaDerivatives.profile,
									mediaDerivatives.optionsHash,
								],
								set: {
									processingJobId: claim.jobId,
									storageKey: committedProcessed.storageKey,
									mimeType: committedProcessed.mimeType,
									size: committedProcessed.size,
									width: committedProcessed.width,
									height: committedProcessed.height,
									duration: committedProcessed.duration,
									checksumSha256: committedProcessed.checksumSha256,
									status: "ready",
									readyAt: now,
									deleteAfter: new Date(
										now.getTime() + 30 * 24 * 60 * 60 * 1000,
									),
								},
							});
						return existing?.storageKey ?? null;
					});
					return JSON.stringify({ supersededStorageKey });
				},
			);
			projectionCommitted = true;
			const commitResult = JSON.parse(commitResultJson) as {
				supersededStorageKey: string | null;
			};
			if (
				commitResult.supersededStorageKey &&
				commitResult.supersededStorageKey !== committedProcessed.storageKey
			) {
				try {
					await step.do("delete superseded derivative bytes", async () => {
						await this.env.MEDIA_BUCKET.delete(
							commitResult.supersededStorageKey as string,
						);
						return { deleted: true };
					});
				} catch (cleanupError) {
					// The private media-bucket lifecycle remains the orphan backstop.
					console.error(
						"[media-processing] failed to delete superseded derivative",
						cleanupError,
					);
				}
			}
			return { status: "completed", job_id: claim.jobId };
		} catch (error) {
			// A generation may lose its PostgreSQL lease after the processor has
			// produced bytes. Its generation-specific key can never overwrite the
			// winner, and is removed before the failed workflow is surfaced.
			if (!projectionCommitted && processed?.storageKey) {
				try {
					await this.env.MEDIA_BUCKET.delete(processed.storageKey);
				} catch (cleanupError) {
					console.error(
						"[media-processing] failed to delete uncommitted generation artifact",
						cleanupError,
					);
				}
			}
			await step.do("record bounded processing failure", async () => {
				const db = createDb(this.env.HYPERDRIVE.connectionString);
				const now = new Date();
				const exhausted = claim.attempts >= 3;
				await db
					.update(mediaProcessingJobs)
					.set({
						status: exhausted ? "manual_review" : "failed",
						leaseExpiresAt: null,
						nextAttemptAt: new Date(
							now.getTime() + Math.min(30, 2 ** claim.attempts) * 60_000,
						),
						lastErrorCode: exhausted
							? "MEDIA_PROCESSING_RETRY_EXHAUSTED"
							: "MEDIA_PROCESSING_FAILED",
						lastError:
							error instanceof Error
								? error.message.slice(0, 4096)
								: String(error).slice(0, 4096),
						updatedAt: now,
					})
					.where(
						and(
							eq(mediaProcessingJobs.id, claim.jobId),
							eq(mediaProcessingJobs.status, "processing"),
							eq(mediaProcessingJobs.leaseToken, claim.generation),
						),
					);
				return { failed: true };
			});
			throw error;
		}
	}
}
