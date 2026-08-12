const MAX_R2_DELETE_KEYS = 1_000;

function objectKeySegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/gu, "_");
}

export function adReportOrganizationPrefix(organizationId: string): string {
	return `ad-reports/${objectKeySegment(organizationId)}/`;
}

export function expectedAdReportObjectKey(input: {
	organizationId: string;
	jobId: string;
}): string {
	return `${adReportOrganizationPrefix(input.organizationId)}${objectKeySegment(input.jobId)}/result`;
}

export interface AdReportArtifactProjection {
	id: string;
	organizationId: string;
	resultObjectKey: string | null;
}

/**
 * Delete only exact, internally derived report keys. A corrupt cross-tenant
 * projection fails closed instead of allowing one erasure scope to remove
 * another tenant's object.
 */
export async function deleteExactAdReportArtifacts(
	bucket: R2Bucket,
	jobs: readonly AdReportArtifactProjection[],
): Promise<number> {
	const keys = [
		...new Set(
			jobs.flatMap((job) => {
				if (!job.resultObjectKey) return [];
				const expected = expectedAdReportObjectKey({
					organizationId: job.organizationId,
					jobId: job.id,
				});
				if (job.resultObjectKey !== expected) {
					throw new Error(
						`Ad report artifact key does not match its tenant/job projection: ${job.id}`,
					);
				}
				return [expected];
			}),
		),
	];
	for (let offset = 0; offset < keys.length; offset += MAX_R2_DELETE_KEYS) {
		await bucket.delete(keys.slice(offset, offset + MAX_R2_DELETE_KEYS));
	}
	return keys.length;
}
