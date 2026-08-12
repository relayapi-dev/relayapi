import { describe, expect, it } from "bun:test";
import { externalSubjectCleanupJobs } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	EXTERNAL_SUBJECT_CLEANUP_BATCH_SIZE,
	EXTERNAL_SUBJECT_CLEANUP_DEADLINE_MS,
	EXTERNAL_SUBJECT_CLEANUP_LEASE_MS,
	EXTERNAL_SUBJECT_CLEANUP_RECEIPT_MS,
	EXTERNAL_SUBJECT_CLEANUP_TENANT_CAP,
	enqueueExternalSubjectCleanup,
	enqueueShortLinkProviderCleanup,
} from "../services/external-subject-cleanup";

function insertStub(captured: Record<string, unknown>[]) {
	return {
		insert: () => {
			// biome-ignore lint/suspicious/noExplicitAny: tiny Drizzle insert stub
			const chain: any = {
				values: (value: Record<string, unknown>) => {
					captured.push(value);
					return chain;
				},
				onConflictDoNothing: () => chain,
				returning: async () => [{ id: captured.at(-1)?.id }],
			};
			return chain;
		},
	} as unknown as Parameters<typeof enqueueExternalSubjectCleanup>[0];
}

describe("external-subject-cleanup-retention", () => {
	it("commits one bounded, deadline-bearing intent per locator", async () => {
		const captured: Record<string, unknown>[] = [];
		const now = new Date("2026-07-28T12:00:00.000Z");
		const id = await enqueueExternalSubjectCleanup(
			insertStub(captured),
			{
				subjectKind: "contact",
				subjectId: "ct_1",
				organizationId: "org_1",
				workspaceId: "ws_1",
				operation: "delete_exact",
				bucket: "media",
				objectLocator: "instagram/account-1/avatar-1.jpg",
			},
			now,
		);
		expect(id).toStartWith("escj_");
		expect(captured).toHaveLength(1);
		expect(captured[0]).toMatchObject({
			subjectKind: "contact",
			subjectId: "ct_1",
			operation: "delete_exact",
			bucket: "media",
			objectLocator: "instagram/account-1/avatar-1.jpg",
			status: "pending",
			nextAttemptAt: now,
		});
		const inserted = captured[0];
		expect(inserted).toBeDefined();
		if (!inserted) throw new Error("Expected one captured cleanup intent");
		expect((inserted.deadlineAt as Date).getTime()).toBe(
			now.getTime() + EXTERNAL_SUBJECT_CLEANUP_DEADLINE_MS,
		);
	});

	it("rejects unsafe or cross-bucket locators before writing", async () => {
		const captured: Record<string, unknown>[] = [];
		await expect(
			enqueueExternalSubjectCleanup(insertStub(captured), {
				subjectKind: "contact",
				subjectId: "ct_1",
				organizationId: "org_1",
				operation: "delete_exact",
				bucket: "media",
				objectLocator: "../avatar.jpg",
			}),
		).rejects.toThrow("Invalid media cleanup exact locator");
		await expect(
			enqueueExternalSubjectCleanup(insertStub(captured), {
				subjectKind: "contact",
				subjectId: "ct_1",
				organizationId: "org_1",
				operation: "delete_exact",
				bucket: "media",
				objectLocator: "user/u_1/avatar.jpg",
			}),
		).rejects.toThrow("belongs to another bucket family");
		expect(captured).toHaveLength(0);
	});

	it("persists provider identity plus temporary credential for erasure-safe short-link cleanup", async () => {
		const captured: Record<string, unknown>[] = [];
		await enqueueShortLinkProviderCleanup(insertStub(captured), {
			subjectKind: "organization",
			subjectId: "org_1",
			organizationId: "org_1",
			provider: "dub",
			providerRef: {
				provider: "dub",
				externalId: "sl_1",
				linkId: "dub_1",
			},
			credentialCiphertext: "enc:v2:key:nonce:ciphertext",
		});
		expect(captured[0]).toMatchObject({
			operation: "delete_short_link",
			bucket: "short_link_provider",
			externalProvider: "dub",
			providerRef: {
				provider: "dub",
				externalId: "sl_1",
				linkId: "dub_1",
			},
			credentialCiphertext: "enc:v2:key:nonce:ciphertext",
		});
	});

	it("pins claim fencing, manual review, receipt pruning, and supporting indexes", async () => {
		expect(EXTERNAL_SUBJECT_CLEANUP_BATCH_SIZE).toBe(25);
		expect(EXTERNAL_SUBJECT_CLEANUP_TENANT_CAP).toBe(5);
		expect(EXTERNAL_SUBJECT_CLEANUP_LEASE_MS).toBe(5 * 60 * 1_000);
		expect(EXTERNAL_SUBJECT_CLEANUP_DEADLINE_MS).toBe(7 * 24 * 60 * 60 * 1_000);
		expect(EXTERNAL_SUBJECT_CLEANUP_RECEIPT_MS).toBe(90 * 24 * 60 * 60 * 1_000);
		const table = getTableConfig(externalSubjectCleanupJobs);
		expect(table.indexes.map(({ config }) => config.name)).toEqual(
			expect.arrayContaining([
				"external_subject_cleanup_jobs_identity_uniq",
				"external_subject_cleanup_jobs_due_idx",
				"external_subject_cleanup_jobs_deadline_idx",
				"external_subject_cleanup_jobs_lease_idx",
				"external_subject_cleanup_jobs_manual_review_idx",
				"external_subject_cleanup_jobs_retention_idx",
			]),
		);

		const source = await Bun.file(
			new URL("../services/external-subject-cleanup.ts", import.meta.url),
		).text();
		for (const marker of [
			"FOR UPDATE SKIP LOCKED",
			"lease_token = lease_token + 1",
			"automatic_cleanup_deadline_exceeded",
			"status = 'manual_review'",
			"status = 'completed'",
			"purge_at <= $" + "{now}",
			"LIMIT $" + "{limit}",
		]) {
			expect(source).toContain(marker);
		}
	});

	it("permits terminal credential shredding and applies it to automatic and operator completion", async () => {
		const [schemaSource, cleanupSource, operatorSource] = await Promise.all([
			Bun.file(
				new URL("../../../../packages/db/src/schema.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL("../services/external-subject-cleanup.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL("../services/operator-resolution.ts", import.meta.url),
			).text(),
		]);
		expect(schemaSource).toMatch(
			/\(\$\{table\.status\} = 'completed'\s+AND \$\{table\.credentialCiphertext\} IS NULL\)/,
		);
		expect(cleanupSource).toContain("credentialCiphertext: null");
		expect(operatorSource).toContain("credentialCiphertext: null");
	});

	it("tenant-ranks both claims and deadline escalation so two tenants share a batch", async () => {
		const source = await Bun.file(
			new URL("../services/external-subject-cleanup.ts", import.meta.url),
		).text();
		expect(source.match(/row_number\(\) OVER \(/g)).toHaveLength(2);
		expect(
			source.match(
				/PARTITION BY COALESCE\([\s\S]*?organization_id,[\s\S]*?subject_kind \|\| ':' \|\| candidate\.subject_id/g,
			),
		).toHaveLength(2);
		expect(
			source.match(
				/ranked\.tenant_rank <= \$\{EXTERNAL_SUBJECT_CLEANUP_TENANT_CAP\}/g,
			),
		).toHaveLength(2);
		expect(
			source.match(
				/ORDER BY ranked\.tenant_rank, ranked\.(?:deadline_at|next_attempt_at), job\.id/g,
			),
		).toHaveLength(2);
		expect(source).not.toMatch(
			/WHERE job\.id = due\.id\s+WHERE job\.id = due\.id/,
		);
	});
});
