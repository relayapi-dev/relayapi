import { createDb, externalPosts, socialAccounts } from "@relayapi/db";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { fetchPublicUrl } from "../../lib/fetch-public-url";
import {
	generateAndStoreThumbnailFromResponse,
	THUMBNAIL_SOURCE_MAX_BYTES,
	type ThumbnailGenerationResult,
} from "../../lib/thumbnails";
import type { Env } from "../../types";
import { refreshTokenIfNeeded } from "../token-refresh-coordinator";
import { getExternalPostFetcher } from "./index";
import type { ExternalPostData, GenerateExternalPreviewMessage } from "./types";

const PREVIEW_FETCH_TIMEOUT_MS = 20_000;
const PREVIEW_PROCESSING_LEASE_MS = 10 * 60_000;
const PREVIEW_RETRY_MAX_SECONDS = 6 * 60 * 60;

type Database = ReturnType<typeof createDb>;

type PreviewSource = {
	url: string;
	fallbackMimeType: string;
};

type PreviewRow = {
	id: string;
	organizationId: string;
	socialAccountId: string;
	platform: string;
	platformPostId: string;
	mediaUrls: string[] | null;
	mediaType: string | null;
	thumbnailUrl: string | null;
	previewAttempts: number;
};

export function externalPreviewStorageKey(
	organizationId: string,
	externalPostId: string,
): string {
	return `${organizationId}/external-posts/${externalPostId}/preview`;
}

export function externalPreviewRetryDelaySeconds(attempts: number): number {
	return Math.min(
		2 ** Math.max(attempts - 1, 0) * 60,
		PREVIEW_RETRY_MAX_SECONDS,
	);
}

export function externalPreviewSourceCandidates(input: {
	thumbnailUrl: string | null;
	mediaUrls: string[] | null;
	mediaType: string | null;
}): PreviewSource[] {
	const sources: PreviewSource[] = [];
	const seen = new Set<string>();
	const add = (url: string | null | undefined, fallbackMimeType: string) => {
		if (!url || seen.has(url)) return;
		seen.add(url);
		sources.push({ url, fallbackMimeType });
	};

	add(input.thumbnailUrl, "image/jpeg");
	const mediaFallback = ["video", "reel", "story"].includes(
		input.mediaType ?? "",
	)
		? "video/mp4"
		: "image/jpeg";
	for (const url of input.mediaUrls ?? []) add(url, mediaFallback);
	return sources;
}

async function trySources(
	env: Env,
	storageKey: string,
	sources: PreviewSource[],
): Promise<ThumbnailGenerationResult> {
	if (sources.length === 0) {
		return { status: "source_missing", reason: "Post has no preview source" };
	}

	const failures: string[] = [];
	let unsupportedReason: string | null = null;
	let unsupportedCount = 0;
	for (const [sourceIndex, source] of sources.entries()) {
		const sourceLabel = `source ${sourceIndex + 1}`;
		try {
			const response = await fetchPublicUrl(source.url, {
				timeout: PREVIEW_FETCH_TIMEOUT_MS,
				timeoutThroughBody: true,
				maxBytes: THUMBNAIL_SOURCE_MAX_BYTES,
			});
			if (!response.ok || !response.body) {
				failures.push(`${sourceLabel}: HTTP ${response.status}`);
				await response.body?.cancel().catch(() => {});
				continue;
			}

			const result = await generateAndStoreThumbnailFromResponse(
				env,
				storageKey,
				response,
				source.fallbackMimeType,
			);
			if (result.status === "generated") return result;
			if (result.status === "unsupported") {
				unsupportedReason = result.reason;
				unsupportedCount++;
				failures.push(`${sourceLabel}: ${result.reason}`);
				continue;
			}
			failures.push(
				`${sourceLabel}: ${
					result.status === "source_missing" ? result.reason : result.error
				}`,
			);
		} catch (error) {
			failures.push(
				`${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	if (unsupportedReason && unsupportedCount === sources.length) {
		return { status: "unsupported", reason: unsupportedReason };
	}
	return {
		status: "transient_failure",
		error: failures.join("; ").slice(0, 1000),
	};
}

async function refreshSourceFromPlatform(
	db: Database,
	env: Env,
	row: PreviewRow,
): Promise<ExternalPostData | null> {
	const fetcher = getExternalPostFetcher(row.platform);
	if (!fetcher?.fetchPost) return null;

	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, row.socialAccountId),
				eq(socialAccounts.organizationId, row.organizationId),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	if (!account) return null;

	const accessToken = await refreshTokenIfNeeded(env, account);
	const refreshed = await fetcher.fetchPost(
		accessToken,
		account.platformAccountId,
		row.platformPostId,
	);
	if (!refreshed) return null;

	await db
		.update(externalPosts)
		.set({
			platformUrl: refreshed.platformUrl,
			content: refreshed.content,
			mediaUrls: refreshed.mediaUrls,
			mediaType: refreshed.mediaType,
			thumbnailUrl: refreshed.thumbnailUrl,
			platformData: refreshed.platformData,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(externalPosts.id, row.id),
				eq(externalPosts.organizationId, row.organizationId),
			),
		);
	return refreshed;
}

async function persistResult(
	db: Database,
	row: PreviewRow,
	result: ThumbnailGenerationResult,
	now: Date,
): Promise<void> {
	if (result.status === "generated") {
		await db
			.update(externalPosts)
			.set({
				previewThumbnailKey: result.thumbnailKey,
				previewStorageProvider: result.storage.provider,
				previewStorageBucketLocator: result.storage.bucket,
				previewStorageRegion: result.storage.region,
				previewThumbnailUrl: result.thumbnailUrl,
				previewStatus: "generated",
				previewNextRetryAt: null,
				previewLastError: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(externalPosts.id, row.id),
					eq(externalPosts.organizationId, row.organizationId),
					eq(externalPosts.previewStatus, "processing"),
					eq(externalPosts.previewAttempts, row.previewAttempts),
				),
			);
		return;
	}

	const error =
		result.status === "transient_failure" ? result.error : result.reason;
	await db
		.update(externalPosts)
		.set({
			previewStatus: result.status,
			previewNextRetryAt:
				result.status === "transient_failure"
					? new Date(
							now.getTime() +
								externalPreviewRetryDelaySeconds(row.previewAttempts) * 1000,
						)
					: null,
			previewLastError: error.slice(0, 1000),
			updatedAt: now,
		})
		.where(
			and(
				eq(externalPosts.id, row.id),
				eq(externalPosts.organizationId, row.organizationId),
				eq(externalPosts.previewStatus, "processing"),
				eq(externalPosts.previewAttempts, row.previewAttempts),
			),
		);
}

async function processWithDb(
	db: Database,
	env: Env,
	message: GenerateExternalPreviewMessage,
	now: Date,
): Promise<void> {
	const [row] = await db
		.update(externalPosts)
		.set({
			previewStatus: "processing",
			previewAttempts: sql`${externalPosts.previewAttempts} + 1`,
			previewNextRetryAt: new Date(now.getTime() + PREVIEW_PROCESSING_LEASE_MS),
			previewLastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(externalPosts.id, message.external_post_id),
				eq(externalPosts.organizationId, message.organization_id),
				eq(externalPosts.socialAccountId, message.social_account_id),
				eq(
					externalPosts.platform,
					message.platform as typeof externalPosts.$inferSelect.platform,
				),
				isNull(externalPosts.previewThumbnailUrl),
				inArray(externalPosts.previewStatus, [
					"pending",
					"processing",
					"transient_failure",
				]),
				or(
					isNull(externalPosts.previewNextRetryAt),
					lte(externalPosts.previewNextRetryAt, now),
				),
			),
		)
		.returning({
			id: externalPosts.id,
			organizationId: externalPosts.organizationId,
			socialAccountId: externalPosts.socialAccountId,
			platform: externalPosts.platform,
			platformPostId: externalPosts.platformPostId,
			mediaUrls: externalPosts.mediaUrls,
			mediaType: externalPosts.mediaType,
			thumbnailUrl: externalPosts.thumbnailUrl,
			previewAttempts: externalPosts.previewAttempts,
		});
	if (!row) return;

	const storageKey = externalPreviewStorageKey(row.organizationId, row.id);
	let result = await trySources(
		env,
		storageKey,
		externalPreviewSourceCandidates(row),
	);

	if (result.status !== "generated") {
		try {
			const refreshed = await refreshSourceFromPlatform(db, env, row);
			if (refreshed) {
				result = await trySources(
					env,
					storageKey,
					externalPreviewSourceCandidates({
						thumbnailUrl: refreshed.thumbnailUrl,
						mediaUrls: refreshed.mediaUrls,
						mediaType: refreshed.mediaType,
					}),
				);
			}
		} catch (error) {
			result = {
				status: "transient_failure",
				error: `Platform source refresh failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}

	await persistResult(db, row, result, now);
}

export async function processExternalPostPreview(
	env: Env,
	message: GenerateExternalPreviewMessage,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	await processWithDb(db, env, message, new Date());
}

export async function backfillExternalPostPreviews(
	env: Env,
	limit: number,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const rows = await db
		.select({
			externalPostId: externalPosts.id,
			organizationId: externalPosts.organizationId,
			socialAccountId: externalPosts.socialAccountId,
			platform: externalPosts.platform,
		})
		.from(externalPosts)
		.where(
			and(
				isNull(externalPosts.previewThumbnailUrl),
				inArray(externalPosts.previewStatus, [
					"pending",
					"processing",
					"transient_failure",
				]),
				or(
					isNull(externalPosts.previewNextRetryAt),
					lte(externalPosts.previewNextRetryAt, now),
				),
			),
		)
		.orderBy(
			asc(externalPosts.previewNextRetryAt),
			asc(externalPosts.createdAt),
		)
		.limit(limit);

	for (const row of rows) {
		await processWithDb(
			db,
			env,
			{
				type: "generate_external_preview",
				external_post_id: row.externalPostId,
				organization_id: row.organizationId,
				social_account_id: row.socialAccountId,
				platform: row.platform,
			},
			now,
		);
	}
}
