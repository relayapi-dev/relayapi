import {
	type Database,
	externalSubjectCleanupJobs,
	generateId,
	shortLinks,
} from "@relayapi/db";
import { and, eq, ne } from "drizzle-orm";
import type { SingleUnitProviderMutationAggregate } from "../lib/mutation-provider-boundary";
import type {
	ProviderAnalyticsTarget,
	ProviderRef,
	ShortLinkProvider,
} from "./short-link-providers";

export type ExternalShortLinkProviderType = "dub" | "short_io" | "bitly";

export class TrackedShortLinkCreationError extends Error {
	constructor(
		message: string,
		readonly shortLinkId: string,
	) {
		super(message);
		this.name = "TrackedShortLinkCreationError";
	}
}

function pendingProviderRef(
	provider: ExternalShortLinkProviderType,
	intentId: string,
): ProviderRef {
	if (provider === "dub") {
		return { provider, externalId: intentId };
	}
	if (provider === "short_io") {
		return { provider, intentId };
	}
	return { provider, intentId };
}

function shortCodeFromUrl(shortUrl: string): string {
	const parsed = new URL(shortUrl);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("Short-link provider returned a non-HTTP URL");
	}
	const shortCode = parsed.pathname.split("/").filter(Boolean).at(-1);
	if (!shortCode) {
		throw new Error("Short-link provider returned an invalid URL");
	}
	return shortCode;
}

/**
 * If erasure locked and removed the pending short-link row while provider
 * creation was in flight, its durable cleanup job initially contains only the
 * pre-egress intent reference. Replace that reference with the provider-issued
 * identity after the erasure transaction commits. The erasure readers lock the
 * selected short-link rows, so either they observe the completed identity or
 * this post-failure repair observes their cleanup job.
 */
async function preserveProviderIdentityForErasure(input: {
	db: Database;
	organizationId: string;
	providerType: ExternalShortLinkProviderType;
	pendingRef: ProviderRef;
	completedRef: ProviderRef;
	now: Date;
}): Promise<void> {
	await input.db
		.update(externalSubjectCleanupJobs)
		.set({
			providerRef: input.completedRef,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(externalSubjectCleanupJobs.operation, "delete_short_link"),
				eq(externalSubjectCleanupJobs.organizationId, input.organizationId),
				eq(externalSubjectCleanupJobs.externalProvider, input.providerType),
				eq(externalSubjectCleanupJobs.providerRef, input.pendingRef),
				ne(externalSubjectCleanupJobs.status, "completed"),
			),
		);
}

/**
 * Create an external short link from a durable local intent.
 *
 * The provider is called exactly once. Any failure after the call begins is
 * terminal `manual_review`, because a timeout cannot prove whether the remote
 * object exists. Operators can reconcile it from the retained intent/provider
 * identity without an automatic duplicate create.
 */
export async function createTrackedExternalShortLink(input: {
	db: Database;
	organizationId: string;
	workspaceId: string | null;
	originalUrl: string;
	providerType: ExternalShortLinkProviderType;
	providerConfigVersion: number;
	credentialVersion: number;
	domain: string | null;
	apiKey: string;
	provider: ShortLinkProvider;
	providerMutation?: SingleUnitProviderMutationAggregate;
	postId?: string | null;
	now?: Date;
}): Promise<typeof shortLinks.$inferSelect> {
	if (input.provider.providerType !== input.providerType) {
		throw new Error("Short-link provider implementation does not match config");
	}
	const now = input.now ?? new Date();
	const id = generateId("sl_");
	const creationFence = 1;
	const pendingRef = pendingProviderRef(input.providerType, id);
	await input.db.insert(shortLinks).values({
		id,
		organizationId: input.organizationId,
		workspaceId: input.workspaceId,
		originalUrl: input.originalUrl,
		provider: input.providerType,
		providerConfigVersion: input.providerConfigVersion,
		credentialVersion: input.credentialVersion,
		providerRef: pendingRef,
		creationStatus: "pending",
		creationFence,
		creationStartedAt: now,
		postId: input.postId ?? null,
	});

	let completedProviderRef: ProviderRef | null = null;
	let completedShortCode: string | null = null;
	let completedShortUrl: string | null = null;
	try {
		const created = await input.provider.shorten(
			input.apiKey,
			input.domain,
			input.originalUrl,
			id,
			input.providerMutation,
		);
		if (created.providerRef.provider !== input.providerType) {
			throw new Error("Short-link provider returned a mismatched identity");
		}
		// Retain the provider-issued identity even if URL validation or the
		// fenced activation write fails. Without this, Short.io and Bitly
		// objects created successfully immediately before a local failure would
		// be impossible to target during reconciliation or erasure.
		completedProviderRef = created.providerRef;
		completedShortCode = shortCodeFromUrl(created.shortUrl);
		completedShortUrl = created.shortUrl;
		const completedAt = new Date();
		const [active] = await input.db
			.update(shortLinks)
			.set({
				providerRef: created.providerRef,
				creationStatus: "active",
				creationCompletedAt: completedAt,
				creationLastError: null,
				shortCode: completedShortCode,
				shortUrl: completedShortUrl,
			})
			.where(
				and(
					eq(shortLinks.id, id),
					eq(shortLinks.organizationId, input.organizationId),
					eq(shortLinks.creationStatus, "pending"),
					eq(shortLinks.creationFence, creationFence),
				),
			)
			.returning();
		if (!active) {
			throw new Error("Short-link creation fence was lost");
		}
		return active;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await input.db
			.update(shortLinks)
			.set({
				...(completedProviderRef ? { providerRef: completedProviderRef } : {}),
				...(completedShortCode && completedShortUrl
					? {
							shortCode: completedShortCode,
							shortUrl: completedShortUrl,
						}
					: {}),
				creationStatus: "manual_review",
				creationCompletedAt: new Date(),
				creationLastError: `ambiguous_provider_create:${message}`.slice(
					0,
					1000,
				),
			})
			.where(
				and(
					eq(shortLinks.id, id),
					eq(shortLinks.organizationId, input.organizationId),
					eq(shortLinks.creationStatus, "pending"),
					eq(shortLinks.creationFence, creationFence),
				),
			);
		if (completedProviderRef) {
			await preserveProviderIdentityForErasure({
				db: input.db,
				organizationId: input.organizationId,
				providerType: input.providerType,
				pendingRef,
				completedRef: completedProviderRef,
				now: new Date(),
			});
		}
		throw new TrackedShortLinkCreationError(
			`Short-link creation requires reconciliation: ${message}`,
			id,
		);
	}
}

export function analyticsTargetForShortLink(
	link: typeof shortLinks.$inferSelect,
): ProviderAnalyticsTarget | null {
	if (
		link.creationStatus !== "active" ||
		!link.shortUrl ||
		typeof link.providerRef !== "object" ||
		link.providerRef === null
	) {
		return null;
	}
	return {
		key: link.id,
		shortUrl: link.shortUrl,
		providerRef: link.providerRef as ProviderRef,
	};
}
