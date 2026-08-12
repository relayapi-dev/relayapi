import {
	type Database,
	mediaDerivatives,
	mediaProcessingJobs,
} from "@relayapi/db";
import { and, desc, eq } from "drizzle-orm";

const MAX_VISIBLE_DERIVATIVES = 50;

export async function getMediaProcessingProjection(
	db: Database,
	organizationId: string,
	mediaId: string,
) {
	const [latestJob, derivativeRows] = await Promise.all([
		db
			.select()
			.from(mediaProcessingJobs)
			.where(
				and(
					eq(mediaProcessingJobs.mediaId, mediaId),
					eq(mediaProcessingJobs.organizationId, organizationId),
				),
			)
			.orderBy(desc(mediaProcessingJobs.updatedAt), desc(mediaProcessingJobs.id))
			.limit(1)
			.then((rows) => rows[0]),
		db
			.select()
			.from(mediaDerivatives)
			.where(
				and(
					eq(mediaDerivatives.mediaId, mediaId),
					eq(mediaDerivatives.organizationId, organizationId),
				),
			)
			.orderBy(desc(mediaDerivatives.createdAt), desc(mediaDerivatives.id))
			.limit(MAX_VISIBLE_DERIVATIVES + 1),
	]);

	const processingStatus:
		| "not_requested"
		| "pending"
		| "processing"
		| "ready"
		| "failed" = latestJob
		? latestJob.status === "completed"
			? "ready"
			: latestJob.status === "processing"
				? "processing"
				: latestJob.status === "pending"
					? "pending"
					: "failed"
		: "not_requested";

	return {
		processing_status: processingStatus,
		processing_error:
			latestJob &&
			!(["pending", "processing", "completed"] as const).includes(
				latestJob.status as "pending" | "processing" | "completed",
			)
				? {
						code: latestJob.lastErrorCode ?? "MEDIA_PROCESSING_FAILED",
						message: latestJob.lastError ?? "Media processing failed",
					}
				: null,
		variants: derivativeRows
			.slice(0, MAX_VISIBLE_DERIVATIVES)
			.map((derivative) => ({
				id: derivative.id,
				kind: derivative.kind,
				profile: derivative.profile,
				mime_type: derivative.mimeType,
				size: derivative.size,
				width: derivative.width ?? null,
				height: derivative.height ?? null,
				duration: derivative.duration ?? null,
				status: derivative.status,
			})),
		variants_truncated: derivativeRows.length > MAX_VISIBLE_DERIVATIVES,
	};
}
