import { describe, expect, it } from "bun:test";
import type { Database } from "@relayapi/db";
import {
	canManageErasureHolds,
	ErasureHoldAuthorizationError,
	erasureHoldCoversTarget,
	executeRetentionOperation,
	getRetentionHoldDecision,
	InvalidErasureHoldInputError,
	MissingRetentionMinimizerError,
	placeErasureHold,
	resolveHoldAction,
} from "../services/privacy-retention-policy";

function dbReturningActiveHold(hold: Record<string, unknown>): Database {
	const terminal = {
		orderBy: () => ({
			limit: async () => [hold],
		}),
	};
	return {
		select: () => ({
			from: () => ({
				where: () => terminal,
			}),
		}),
	} as unknown as Database;
}

describe("privacy retention policy", () => {
	it("never pauses an ordinary clock without an active hold", () => {
		expect(resolveHoldAction("pause", false)).toBe("continue");
		expect(resolveHoldAction("minimize", false)).toBe("continue");
		expect(resolveHoldAction("never", false)).toBe("continue");
	});

	it("distinguishes pause, minimization, and never-held data", () => {
		expect(resolveHoldAction("pause", true)).toBe("pause");
		expect(resolveHoldAction("minimize", true)).toBe("minimize");
		expect(resolveHoldAction("never", true)).toBe("continue");
	});

	it("does not query holds for a secret or ephemeral store", async () => {
		let queried = false;
		const db = {
			select: () => {
				queried = true;
				throw new Error("unexpected query");
			},
		} as unknown as Database;
		await expect(
			getRetentionHoldDecision(db, "kv:dashboard-key", {
				kind: "organization",
				organizationId: "org_1",
			}),
		).resolves.toEqual({
			action: "continue",
			storeId: "kv:dashboard-key",
			activeHoldId: null,
		});
		expect(queried).toBe(false);
	});

	it("pauses eligible content and minimizes mixed secret evidence", async () => {
		const hold = {
			id: "hold_1",
			subjectKind: "organization",
			subjectId: "org_1",
			organizationTombstoneId: "org_1",
		};
		const db = dbReturningActiveHold(hold);
		await expect(
			getRetentionHoldDecision(db, "postgres:public.posts", {
				kind: "workspace",
				organizationId: "org_1",
				workspaceId: "ws_1",
			}),
		).resolves.toMatchObject({
			action: "pause",
			activeHoldId: "hold_1",
		});
		await expect(
			getRetentionHoldDecision(db, "postgres:public.social_accounts", {
				kind: "organization",
				organizationId: "org_1",
			}),
		).resolves.toMatchObject({
			action: "minimize",
			activeHoldId: "hold_1",
		});
	});

	it("enforces pause and minimization before invoking destructive work", async () => {
		const hold = {
			id: "hold_1",
			subjectKind: "organization",
			subjectId: "org_1",
			organizationTombstoneId: "org_1",
		};
		const db = dbReturningActiveHold(hold);
		let destroyed = 0;
		let minimized = 0;
		const target = {
			kind: "organization" as const,
			organizationId: "org_1",
		};

		await expect(
			executeRetentionOperation(db, "postgres:public.posts", target, {
				destroy: async () => {
					destroyed += 1;
					return "deleted";
				},
			}),
		).resolves.toEqual({
			status: "paused",
			action: "pause",
			activeHoldId: "hold_1",
		});
		await expect(
			executeRetentionOperation(db, "postgres:public.social_accounts", target, {
				destroy: async () => {
					destroyed += 1;
					return "deleted";
				},
				minimize: async () => {
					minimized += 1;
					return "credentials_shredded";
				},
			}),
		).resolves.toEqual({
			status: "completed",
			action: "minimize",
			value: "credentials_shredded",
		});
		expect(destroyed).toBe(0);
		expect(minimized).toBe(1);
	});

	it("fails closed when mixed held data has no minimizer", async () => {
		const db = dbReturningActiveHold({
			id: "hold_1",
			subjectKind: "organization",
			subjectId: "org_1",
			organizationTombstoneId: "org_1",
		});
		let destroyed = false;
		await expect(
			executeRetentionOperation(
				db,
				"postgres:public.social_accounts",
				{ kind: "organization", organizationId: "org_1" },
				{
					destroy: async () => {
						destroyed = true;
					},
				},
			),
		).rejects.toBeInstanceOf(MissingRetentionMinimizerError);
		expect(destroyed).toBe(false);
	});

	it("makes an organization hold cover its workspaces without cross-tenant bleed", () => {
		const organizationHold = {
			subjectKind: "organization" as const,
			subjectId: "org_1",
			organizationTombstoneId: "org_1",
		};
		const workspaceHold = {
			subjectKind: "workspace" as const,
			subjectId: "ws_1",
			organizationTombstoneId: "org_1",
		};
		expect(
			erasureHoldCoversTarget(organizationHold, {
				kind: "workspace",
				organizationId: "org_1",
				workspaceId: "ws_2",
			}),
		).toBe(true);
		expect(
			erasureHoldCoversTarget(workspaceHold, {
				kind: "workspace",
				organizationId: "org_1",
				workspaceId: "ws_1",
			}),
		).toBe(true);
		expect(
			erasureHoldCoversTarget(workspaceHold, {
				kind: "workspace",
				organizationId: "org_2",
				workspaceId: "ws_1",
			}),
		).toBe(false);
	});
});

describe("erasure hold administration", () => {
	it("recognizes only the global admin role", () => {
		expect(canManageErasureHolds("admin")).toBe(true);
		expect(canManageErasureHolds("owner")).toBe(false);
		expect(canManageErasureHolds(null)).toBe(false);
	});

	it("bounds human summaries and encrypted evidence before opening a transaction", async () => {
		let transactions = 0;
		const db = {
			transaction: () => {
				transactions += 1;
				throw new Error("unexpected transaction");
			},
		} as unknown as Database;
		const base = {
			target: { kind: "organization" as const, organizationId: "org_1" },
			reasonCode: "legal_dispute",
			reasonSummary: "Preserve evidence",
			legalAuthorityRef: "case-123",
			actorUserId: "usr_admin",
		};

		await expect(
			placeErasureHold(db, {
				...base,
				reasonSummary: "x".repeat(501),
			}),
		).rejects.toBeInstanceOf(InvalidErasureHoldInputError);
		await expect(
			placeErasureHold(db, {
				...base,
				evidenceCiphertext: "x".repeat(65_537),
			}),
		).rejects.toBeInstanceOf(InvalidErasureHoldInputError);
		expect(transactions).toBe(0);
	});

	it("locks and validates a workspace target before inserting its typed tuple", async () => {
		const selectedRows = [
			[{ role: "admin" }],
			[{ id: "org_1" }],
			[{ id: "ws_1" }],
		];
		let selectIndex = 0;
		let inserted: Record<string, unknown> | undefined;
		const updates: Record<string, unknown>[] = [];
		const tx = {
			select: () => ({
				from: () => ({
					where: () => {
						const rows = selectedRows[selectIndex++] ?? [];
						const terminal = {
							for: () => terminal,
							limit: async () => rows,
						};
						return terminal;
					},
				}),
			}),
			insert: () => ({
				values: (values: Record<string, unknown>) => {
					inserted = values;
					return {
						returning: async () => [{ id: "hold_1", ...values }],
					};
				},
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => {
					updates.push(values);
					return { where: async () => [] };
				},
			}),
		};
		const db = {
			transaction: async (
				callback: (transaction: typeof tx) => Promise<unknown>,
			) => callback(tx),
		} as unknown as Database;

		const hold = await placeErasureHold(db, {
			target: {
				kind: "workspace",
				organizationId: "org_1",
				workspaceId: "ws_1",
			},
			reasonCode: "regulatory_request",
			reasonSummary: "Preserve the requested workspace evidence",
			legalAuthorityRef: "case-123",
			actorUserId: "usr_admin",
		});

		expect(hold.id).toBe("hold_1");
		expect(selectIndex).toBe(3);
		expect(inserted).toMatchObject({
			subjectKind: "workspace",
			subjectId: "ws_1",
			organizationTombstoneId: "org_1",
			placedBy: "usr_admin",
		});
		expect(updates.some((update) => update.status === "held")).toBe(true);
		expect(
			updates.some(
				(update) =>
					update.status === "pending" &&
					update.lastError === "paused_by_erasure_hold",
			),
		).toBe(true);
	});

	it("rejects placement before target access when the actor is not a global admin", async () => {
		let selects = 0;
		const tx = {
			select: () => {
				selects += 1;
				return {
					from: () => ({
						where: () => {
							const terminal = {
								for: () => terminal,
								limit: async () => [{ role: "owner" }],
							};
							return terminal;
						},
					}),
				};
			},
		};
		const db = {
			transaction: async (
				callback: (transaction: typeof tx) => Promise<unknown>,
			) => callback(tx),
		} as unknown as Database;

		await expect(
			placeErasureHold(db, {
				target: { kind: "organization", organizationId: "org_1" },
				reasonCode: "legal_dispute",
				reasonSummary: "Preserve evidence",
				legalAuthorityRef: "case-123",
				actorUserId: "usr_owner",
			}),
		).rejects.toBeInstanceOf(ErasureHoldAuthorizationError);
		expect(selects).toBe(1);
	});
});
