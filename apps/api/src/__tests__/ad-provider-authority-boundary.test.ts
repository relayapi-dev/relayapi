import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
	adAccounts,
	adCreationOperations,
	type Database,
	organizationSubscriptions,
	socialAccounts,
} from "@relayapi/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

let authorityLive = true;
let authorityCheckedInsideTransaction = false;
let tokenResolvedInsideTransaction = false;
let inTransaction = false;

mock.module("../lib/durable-credential-authority", () => ({
	revalidateDurableCredentialAuthority: async () => {
		authorityCheckedInsideTransaction = inTransaction;
		return authorityLive
			? { ok: true, value: {} }
			: {
					ok: false,
					status: 401,
					code: "CREDENTIAL_NO_LONGER_AUTHORIZED",
					message: "revoked first",
				};
	},
}));

mock.module("../services/ad-access-token", () => ({
	resolveAdsAccessToken: async (account: { accessToken: string | null }) => {
		tokenResolvedInsideTransaction = inTransaction;
		return account.accessToken ?? "";
	},
}));

const { markAdProviderBoundary } = await import(
	"../services/ad-creation-operations"
);
const { lockAdProviderBoundary } = await import(
	"../services/ad-provider-boundary"
);

function operation() {
	return {
		id: "adop_authority",
		organizationId: "org_authority",
		usageReservationId: null,
		workspaceId: "ws_authority",
		adAccountId: "adacc_authority",
		kind: "create_campaign",
		platform: "meta",
		requestPayload: {},
		status: "processing",
		phase: "campaign",
		leaseToken: 7,
		requestMayHaveBeenSentAt: null as Date | null,
		platformCampaignId: null as string | null,
		platformAdSetId: null as string | null,
		platformCreativeId: null as string | null,
		platformAdId: null as string | null,
		authorityKeyId: "key_authority",
		authorityPrincipalId: "prn_authority",
		authorityPrincipalType: "dashboard_user",
		authorityUserId: "usr_authority",
		authorityMemberId: "mem_authority",
		authoritySessionId: "session_authority",
		authorityWorkspaceId: "ws_authority",
		authorityRequiresAllWorkspaceScope: false,
		authorityCredentialVersion: "generation-1",
		authorityAdmittedAt: new Date("2026-08-03T10:00:00.000Z"),
		authorityRevision: 3,
	};
}

type BoundaryOptions = {
	subscription?: {
		status: string;
		source: "stripe" | "complimentary";
		stripeSubscriptionId: string | null;
		trialEndsAt?: Date | null;
	};
	socialStatus?: "active" | "disconnecting" | "disconnected";
	adAccountStatus?: string | null;
	accessToken?: string | null;
};

function boundaryDatabase(
	row: ReturnType<typeof operation>,
	options: BoundaryOptions = {},
) {
	const updates: Array<{ values: Record<string, unknown>; where: SQL }> = [];
	const locks: string[] = [];
	let subscriptionInserts = 0;
	const subscription = options.subscription ?? {
		status: "active",
		source: "stripe" as const,
		stripeSubscriptionId: "sub_live",
		trialEndsAt: null,
	};
	const socialAccount = {
		id: "social_authority",
		organizationId: row.organizationId,
		workspaceId: row.workspaceId,
		platform: "facebook",
		lifecycleStatus: options.socialStatus ?? "active",
		accessToken: options.accessToken ?? "fresh-boundary-token",
		metadata: {},
	};
	const adAccount = {
		id: row.adAccountId,
		organizationId: row.organizationId,
		workspaceId: row.workspaceId,
		socialAccountId: socialAccount.id,
		platform: "meta",
		platformAdAccountId: "act_authority",
		status: options.adAccountStatus ?? "active",
	};

	const tx = {
		insert: (table: unknown) => ({
			values: (_values: unknown) => ({
				onConflictDoNothing: async (_options: unknown) => {
					if (table === organizationSubscriptions) subscriptionInserts += 1;
				},
			}),
		}),
		select: (projection?: Record<string, unknown>) => {
			let table: unknown;
			const query = {
				from: (value: unknown) => {
					table = value;
					return query;
				},
				where: (_condition: unknown) => query,
				for: (_mode: "share" | "update") => {
					if (table === organizationSubscriptions) locks.push("subscription");
					if (table === socialAccounts) locks.push("social");
					if (table === adAccounts) locks.push("ad_account");
					if (table === adCreationOperations) locks.push("operation");
					return query;
				},
				limit: async (_limit: number) => {
					if (table === adCreationOperations) return [row];
					if (table === organizationSubscriptions) return [subscription];
					if (table === socialAccounts) return [socialAccount];
					if (table === adAccounts) {
						return projection && Object.keys(projection).length === 1
							? [{ socialAccountId: socialAccount.id }]
							: [adAccount];
					}
					return [];
				},
			};
			return query;
		},
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: (where: SQL) => ({
					returning: async () => {
						if (table !== adCreationOperations) return [];
						updates.push({ values, where });
						Object.assign(row, values);
						return [{ id: row.id }];
					},
				}),
			}),
		}),
	};
	const db = {
		transaction: async <T>(run: (value: typeof tx) => Promise<T>) => {
			inTransaction = true;
			try {
				return await run(tx);
			} finally {
				inTransaction = false;
			}
		},
	} as unknown as Database;
	return {
		db,
		tx,
		updates,
		locks,
		getSubscriptionInserts: () => subscriptionInserts,
	};
}

const hostedEnv = { DEPLOYMENT_MODE: "hosted" } as never;
const selfHostedEnv = { DEPLOYMENT_MODE: "self_hosted" } as never;

beforeEach(() => {
	authorityLive = true;
	authorityCheckedInsideTransaction = false;
	tokenResolvedInsideTransaction = false;
	inTransaction = false;
});

describe("ad provider authority linearization", () => {
	it("revocation-first cancels a no-effect row and starts no provider call", async () => {
		authorityLive = false;
		const row = operation();
		const { db, updates } = boundaryDatabase(row);
		let providerCalls = 0;
		try {
			await markAdProviderBoundary(
				hostedEnv,
				db,
				{ row, leaseToken: row.leaseToken } as never,
				"campaign",
			);
			providerCalls += 1;
		} catch (error) {
			expect(error).toMatchObject({
				code: "CREDENTIAL_NO_LONGER_AUTHORIZED",
			});
		}

		expect(authorityCheckedInsideTransaction).toBe(true);
		expect(tokenResolvedInsideTransaction).toBe(false);
		expect(providerCalls).toBe(0);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.values.status).toBe("cancelled");
	});

	it("opens the boundary with a freshly locked token before provider I/O", async () => {
		const row = operation();
		const { db, updates, locks } = boundaryDatabase(row);
		const context = await markAdProviderBoundary(
			hostedEnv,
			db,
			{ row, leaseToken: row.leaseToken } as never,
			"campaign",
		);

		expect(authorityCheckedInsideTransaction).toBe(true);
		expect(tokenResolvedInsideTransaction).toBe(true);
		expect(context.accessToken).toBe("fresh-boundary-token");
		expect(inTransaction).toBe(false);
		expect(locks).toEqual([
			"operation",
			"subscription",
			"social",
			"ad_account",
		]);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.values.status).toBe("request_may_have_been_sent");
		const where = updates[0]?.where;
		if (!where) throw new Error("Boundary CAS was not captured");
		const query = new PgDialect().sqlToQuery(where);
		const normalized = query.sql.replace(/\s+/g, " ");
		expect(normalized).toContain('"ad_creation_operations"."lease_token" =');
		expect(normalized).toContain('"ad_creation_operations"."status" in');
		expect(normalized).toContain(
			'"ad_creation_operations"."authority_revision" =',
		);
	});

	it("denies hosted Stripe Pro that is not currently billable", async () => {
		const row = operation();
		const { db, updates } = boundaryDatabase(row, {
			subscription: {
				status: "trialing",
				source: "stripe",
				stripeSubscriptionId: "sub_trial",
				trialEndsAt: new Date("2099-01-01T00:00:00.000Z"),
			},
		});

		await expect(
			markAdProviderBoundary(
				hostedEnv,
				db,
				{ row, leaseToken: row.leaseToken } as never,
				"campaign",
			),
		).rejects.toMatchObject({ code: "CREDENTIAL_NO_LONGER_AUTHORIZED" });
		expect(updates[0]?.values.status).toBe("cancelled");
	});

	it("allows active complimentary authority and self-host bypasses hosted billing", async () => {
		const complimentary = operation();
		const complimentaryState = boundaryDatabase(complimentary, {
			subscription: {
				status: "active",
				source: "complimentary",
				stripeSubscriptionId: null,
			},
		});
		await expect(
			markAdProviderBoundary(
				hostedEnv,
				complimentaryState.db,
				{ row: complimentary, leaseToken: complimentary.leaseToken } as never,
				"campaign",
			),
		).resolves.toMatchObject({ accessToken: "fresh-boundary-token" });

		const community = operation();
		const communityState = boundaryDatabase(community, {
			subscription: {
				status: "cancelled",
				source: "stripe",
				stripeSubscriptionId: null,
			},
		});
		await expect(
			markAdProviderBoundary(
				selfHostedEnv,
				communityState.db,
				{ row: community, leaseToken: community.leaseToken } as never,
				"campaign",
			),
		).resolves.toMatchObject({ accessToken: "fresh-boundary-token" });
		expect(communityState.getSubscriptionInserts()).toBe(0);
	});

	it("keeps emergency-safe mutations behind provider locks while bypassing billing", async () => {
		const row = operation();
		const state = boundaryDatabase(row, {
			subscription: {
				status: "cancelled",
				source: "stripe",
				stripeSubscriptionId: null,
			},
		});
		const decision = await lockAdProviderBoundary(
			state.tx as never,
			hostedEnv,
			{
				organizationId: row.organizationId,
				workspaceId: row.workspaceId,
				adAccountId: row.adAccountId,
				platform: "meta",
				requiresLiveEntitlement: false,
			},
		);

		expect(decision).toMatchObject({
			ok: true,
			context: { accessToken: "fresh-boundary-token" },
		});
		expect(state.getSubscriptionInserts()).toBe(0);
		expect(state.locks).toEqual(["social", "ad_account"]);
	});

	it("disconnect-first or disabled-ad-account-first denies without returning a token", async () => {
		for (const options of [
			{ socialStatus: "disconnected" as const },
			{ adAccountStatus: "disabled" },
		]) {
			const row = operation();
			const { db, updates } = boundaryDatabase(row, options);
			tokenResolvedInsideTransaction = false;
			await expect(
				markAdProviderBoundary(
					hostedEnv,
					db,
					{ row, leaseToken: row.leaseToken } as never,
					"campaign",
				),
			).rejects.toMatchObject({ code: "CREDENTIAL_NO_LONGER_AUTHORIZED" });
			expect(tokenResolvedInsideTransaction).toBe(false);
			expect(updates[0]?.values.status).toBe("cancelled");
		}
	});

	it("revalidates an open boundary and makes later capability loss operator-visible", async () => {
		const marker = new Date("2026-08-03T10:01:00.000Z");
		const open = operation();
		open.status = "request_may_have_been_sent";
		open.requestMayHaveBeenSentAt = marker;
		const first = boundaryDatabase(open);
		await expect(
			markAdProviderBoundary(
				hostedEnv,
				first.db,
				{ row: open, leaseToken: open.leaseToken } as never,
				"campaign",
			),
		).resolves.toMatchObject({ accessToken: "fresh-boundary-token" });
		expect(open.requestMayHaveBeenSentAt).toEqual(marker);

		const lost = boundaryDatabase(open, { socialStatus: "disconnected" });
		await expect(
			markAdProviderBoundary(
				hostedEnv,
				lost.db,
				{ row: open, leaseToken: open.leaseToken } as never,
				"campaign",
			),
		).rejects.toMatchObject({ code: "MANUAL_REVIEW_REQUIRED" });
		expect(lost.updates[0]?.values.status).toBe("manual_review");
		expect(lost.updates[0]?.values.status).not.toBe("revocation_pending");
	});
});
