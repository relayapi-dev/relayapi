import {
	createDb,
	tenantDeletionJobs,
	workspaceErasureJobs,
} from "@relayapi/db";
import { and, isNull, lt, ne } from "drizzle-orm";
import type { Env } from "../types";
import { redactReleasedErasureHoldEvidence } from "./privacy-retention-policy";

export const ERASURE_JOB_AGED_ALERT_MS = 24 * 60 * 60 * 1_000;
export const ERASURE_HOLD_DETAIL_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export function erasureMaintenanceCutoffs(now: Date): {
	agedJobCutoff: Date;
	releasedHoldDetailCutoff: Date;
} {
	return {
		agedJobCutoff: new Date(now.getTime() - ERASURE_JOB_AGED_ALERT_MS),
		releasedHoldDetailCutoff: new Date(
			now.getTime() - ERASURE_HOLD_DETAIL_RETENTION_MS,
		),
	};
}

/**
 * Daily bounded-state maintenance for erasure workflows.
 *
 * `aged_alerted_at` is a durable first-alert receipt. The operator API exposes
 * every unresolved job and this timestamp; logging only newly marked rows keeps
 * external alert integrations idempotent without adding a second alert table.
 */
export async function maintainErasureHolds(
	env: Env,
	now = new Date(),
): Promise<{
	tenantJobsAlerted: number;
	workspaceJobsAlerted: number;
	holdDetailsRedacted: number;
}> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const { agedJobCutoff, releasedHoldDetailCutoff } =
		erasureMaintenanceCutoffs(now);

	const { tenantRows, workspaceRows } = await db.transaction(async (tx) => {
		const tenantRows = await tx
			.update(tenantDeletionJobs)
			.set({ agedAlertedAt: now, updatedAt: now })
			.where(
				and(
					isNull(tenantDeletionJobs.agedAlertedAt),
					lt(tenantDeletionJobs.requestedAt, agedJobCutoff),
					ne(tenantDeletionJobs.status, "purged"),
				),
			)
			.returning({
				organizationId: tenantDeletionJobs.organizationId,
				status: tenantDeletionJobs.status,
				requestedAt: tenantDeletionJobs.requestedAt,
			});
		const workspaceRows = await tx
			.update(workspaceErasureJobs)
			.set({ agedAlertedAt: now, updatedAt: now })
			.where(
				and(
					isNull(workspaceErasureJobs.agedAlertedAt),
					lt(workspaceErasureJobs.requestedAt, agedJobCutoff),
					ne(workspaceErasureJobs.status, "purged"),
				),
			)
			.returning({
				organizationId: workspaceErasureJobs.organizationId,
				workspaceId: workspaceErasureJobs.workspaceId,
				status: workspaceErasureJobs.status,
				requestedAt: workspaceErasureJobs.requestedAt,
			});
		return { tenantRows, workspaceRows };
	});

	for (const row of tenantRows) {
		console.error("[privacy] erasure job exceeded 24 hours", {
			kind: "organization",
			organization_id: row.organizationId,
			status: row.status,
			requested_at: row.requestedAt.toISOString(),
		});
	}
	for (const row of workspaceRows) {
		console.error("[privacy] erasure job exceeded 24 hours", {
			kind: "workspace",
			organization_id: row.organizationId,
			workspace_id: row.workspaceId,
			status: row.status,
			requested_at: row.requestedAt.toISOString(),
		});
	}

	const holdDetailsRedacted = await redactReleasedErasureHoldEvidence(
		db,
		releasedHoldDetailCutoff,
		now,
	);
	return {
		tenantJobsAlerted: tenantRows.length,
		workspaceJobsAlerted: workspaceRows.length,
		holdDetailsRedacted,
	};
}
