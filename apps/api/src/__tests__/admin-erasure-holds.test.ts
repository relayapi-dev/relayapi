import { describe, expect, it } from "bun:test";
import type { erasureHolds } from "@relayapi/db";
import { serializeErasureHold } from "../routes/admin";
import { AdminErasureHoldCreate } from "../schemas/admin";

type ErasureHoldRow = typeof erasureHolds.$inferSelect;

describe("admin erasure-hold contract", () => {
	it("never returns encrypted evidence through the operator API", () => {
		const row = {
			id: "hold_1",
			subjectKind: "workspace",
			subjectId: "ws_1",
			organizationTombstoneId: "org_1",
			reasonCode: "legal_dispute",
			reasonSummary: "Preserve eligible evidence",
			legalAuthorityRef: "case-123",
			placedBy: "usr_admin",
			placedAt: new Date("2026-07-28T00:00:00.000Z"),
			releasedBy: null,
			releasedAt: null,
			releaseReasonSummary: null,
			evidenceCiphertext: "enc:v2:active:secret",
			evidenceRedactedAt: null,
			createdAt: new Date("2026-07-28T00:00:00.000Z"),
		} satisfies ErasureHoldRow;

		const serialized = serializeErasureHold(row);
		expect(serialized.hasEvidence).toBe(true);
		expect("evidenceCiphertext" in serialized).toBe(false);
	});

	it("requires a typed target and bounds evidence by UTF-8 bytes", () => {
		const common = {
			reasonCode: "legal_dispute",
			reasonSummary: "Preserve eligible evidence",
			legalAuthorityRef: "case-123",
		};
		expect(
			AdminErasureHoldCreate.safeParse({
				...common,
				subjectKind: "workspace",
				organizationId: "org_1",
			}).success,
		).toBe(false);
		expect(
			AdminErasureHoldCreate.safeParse({
				...common,
				subjectKind: "organization",
				organizationId: "org_1",
				evidence: "🧾".repeat(12_000),
			}).success,
		).toBe(false);
	});
});
