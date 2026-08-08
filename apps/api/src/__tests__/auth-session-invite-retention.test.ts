import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	inviteTokens,
	session,
	tenantDeletionSteps,
	workspaceErasureSteps,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";

const retentionSource = readFileSync(
	new URL("../services/operational-retention.ts", import.meta.url),
	"utf8",
);

describe("session and bearer-invite total retention", () => {
	it("indexes both bounded expiry scans", () => {
		expect(
			getTableConfig(session).indexes.map((index) => index.config.name),
		).toContain("session_expires_idx");
		expect(
			getTableConfig(inviteTokens).indexes.map((index) => index.config.name),
		).toContain("invite_tokens_expiry_idx");
	});

	it("deletes expired sessions in bounded oldest-first pages", () => {
		const start = retentionSource.indexOf(".delete(session)");
		const end = retentionSource.indexOf(".delete(verification)", start);
		const implementation = retentionSource.slice(start, end);
		expect(start).toBeGreaterThan(-1);
		expect(implementation).toContain(".orderBy(session.expiresAt, session.id)");
		expect(implementation).toContain(".limit(AUTH_EPHEMERAL_DELETE_BATCH)");
	});

	it("deletes bearer invites 30 days after use or expiry", () => {
		const deleteStart = retentionSource.indexOf(
			"DELETE FROM $" + "{inviteTokens} AS token",
		);
		const start = retentionSource.lastIndexOf("WITH due AS (", deleteStart);
		const implementation = retentionSource.slice(start, deleteStart + 200);
		expect(start).toBeGreaterThan(-1);
		expect(implementation).toContain(
			"token.expires_at <= $" + "{invitationCutoff}",
		);
		expect(implementation).toContain(
			"token.used_at <= $" + "{invitationCutoff}",
		);
		expect(implementation).toContain("NOT EXISTS (");
		expect(implementation).toContain("ORDER BY token.expires_at, token.id");
		expect(
			retentionSource.indexOf("DELETE FROM $" + "{inviteTokenWorkspaces}"),
		).toBeLessThan(deleteStart);
	});
});

describe("terminal erasure detail retention", () => {
	it("indexes oldest-first completed-step scans", () => {
		expect(
			getTableConfig(tenantDeletionSteps).indexes.map(
				(index) => index.config.name,
			),
		).toContain("tenant_deletion_steps_completed_retention_idx");
		expect(
			getTableConfig(workspaceErasureSteps).indexes.map(
				(index) => index.config.name,
			),
		).toContain("workspace_erasure_steps_completed_retention_idx");
	});

	it("deletes only completed detail after 90 days and excludes active holds", () => {
		const start = retentionSource.indexOf(
			"export async function pruneCompletedErasureSteps",
		);
		const end = retentionSource.indexOf("/**", start + 10);
		const implementation = retentionSource.slice(start, end);
		expect(start).toBeGreaterThan(-1);
		expect(implementation).toContain("TERMINAL_ERASURE_STEP_RETENTION_DAYS");
		expect(implementation).toContain("ERASURE_STEP_RETENTION_DELETE_BATCH");
		expect(implementation).toContain("hold.released_at IS NULL");
		expect(implementation).toContain("ORDER BY step.completed_at, step.id");
		expect(implementation).toContain("job.status = 'purged'");
	});
});
