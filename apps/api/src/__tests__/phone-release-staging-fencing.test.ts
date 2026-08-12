import { describe, expect, it } from "bun:test";
import {
	type Database,
	socialAccounts,
	usageBuckets,
	usageReservations,
	whatsappPhoneNumbers,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DurableCredentialAuthoritySnapshot } from "../lib/durable-credential-authority";
import {
	PhoneOperationError,
	type PhoneRow,
	stagePhoneRelease,
} from "../services/phone-number-operations";
import type { UsageReservation } from "../services/usage-meter";

interface CapturedUpdate {
	table: unknown;
	values: Partial<PhoneRow>;
	where: SQL;
}

function phoneRow(overrides: Partial<PhoneRow> = {}): PhoneRow {
	return {
		id: "wapn_staging_fence_1",
		organizationId: "org_1",
		phoneNumber: "+15555550123",
		status: "provisioning",
		provisioningOperationId: "wpo_1",
		provisioningState: "processing",
		provisioningPhase: "telnyx_order",
		provisioningLeaseToken: 7,
		provisioningLeaseExpiresAt: new Date("2026-08-02T10:05:00.000Z"),
		provisioningRequestMayHaveBeenSentAt: null,
		provisioningSourceAccountId: "acc_source_1",
		provisioningSourceWabaId: "waba_1",
		provisioningVerifiedName: "Relay API",
		telnyxOrderId: null,
		providerNumberId: null,
		socialAccountId: null,
		waPhoneNumberId: null,
		stripePhoneSubscriptionId: null,
		stripeSubscriptionItemId: null,
		stripeCheckoutSessionId: null,
		releaseOperationId: null,
		releaseState: null,
		releasePhase: null,
		releaseLeaseToken: null,
		releaseLeaseExpiresAt: null,
		releaseRequestMayHaveBeenSentAt: null,
		...overrides,
	} as PhoneRow;
}

const releaseAuthority: DurableCredentialAuthoritySnapshot = {
	organizationId: "org_1",
	keyId: "key_1",
	principalId: "principal_1",
	principalType: "dashboard_user",
	userId: "user_1",
	authorityMemberId: "member_1",
	authoritySessionId: "session_1",
	authorityWorkspaceId: null,
	authorityRequiresAllWorkspaceScope: true,
	credentialVersion: "credential-v1",
	admittedAt: new Date("2026-08-02T09:00:00.000Z"),
	revision: 1,
};

const admitReleaseAuthority = async () =>
	({ ok: true, value: releaseAuthority }) as const;

function joined(row: PhoneRow): {
	phone: PhoneRow;
	provisioning: PhoneRow;
	release: PhoneRow | null;
} {
	return {
		phone: row,
		provisioning: row,
		release: row.releaseState ? row : null,
	};
}

function stagingDb(initial: PhoneRow, current: PhoneRow) {
	const updates: CapturedUpdate[] = [];
	let phoneSelects = 0;
	let inserts = 0;
	let phoneUpdates = 0;

	const tx = {
		select: (_projection?: Record<string, unknown>) => {
			let sourceTable: unknown;
			const builder = {
				from: (table: unknown) => {
					sourceTable = table;
					return builder;
				},
				innerJoin: (_table: unknown, _condition: unknown) => builder,
				leftJoin: (_table: unknown, _condition: unknown) => builder,
				where: (_condition: unknown) => builder,
				for: (_mode: "share" | "update") => builder,
				limit: async (_limit: number) => {
					if (sourceTable !== whatsappPhoneNumbers) return [];
					const row = phoneSelects === 0 ? initial : current;
					phoneSelects += 1;
					return [joined(row)];
				},
			};
			return builder;
		},
		update: (table: unknown) => ({
			set: (values: Partial<PhoneRow>) => ({
				where: (where: SQL) => ({
					returning: async (_projection?: unknown) => {
						updates.push({ table, values, where });
						if (table === whatsappPhoneNumbers) phoneUpdates += 1;
						// Both scenarios deliberately model a lost snapshot CAS.
						return [];
					},
				}),
			}),
		}),
		insert: (_table: unknown) => ({
			values: (_values: unknown) => ({
				returning: async () => {
					inserts += 1;
					return [];
				},
			}),
		}),
	};
	const db = {
		transaction: async <T>(
			callback: (transaction: typeof tx) => Promise<T>,
		): Promise<T> => callback(tx),
	} as unknown as Database;

	return {
		db,
		updates,
		getPhoneSelects: () => phoneSelects,
		getInserts: () => inserts,
		getPhoneUpdates: () => phoneUpdates,
	};
}

function userReleaseRow(overrides: Partial<PhoneRow> = {}): PhoneRow {
	return phoneRow({
		status: "releasing",
		provisioningState: "completed",
		provisioningPhase: "completed",
		provisioningLeaseExpiresAt: null,
		waPhoneNumberId: "wa_phone_1",
		releaseOperationId: "wro_takeover_1",
		releaseUsageReservationId: "ur_takeover_1",
		releaseReason: "user_requested",
		releaseState: "pending",
		releasePhase: "meta",
		releaseMetaStatus: "pending",
		releaseStripeStatus: "pending",
		releaseTelnyxStatus: "pending",
		releaseSourceAccountId: "acc_source_1",
		releaseSourceTokenVersion: 7,
		releaseAccessTokenCiphertext: "encrypted-token-v7",
		releaseLeaseToken: 3,
		releaseLeaseExpiresAt: null,
		releaseRequestMayHaveBeenSentAt: null,
		releaseAttempts: 1,
		releaseNextAttemptAt: new Date("2026-08-02T10:10:00.000Z"),
		releaseLastError: null,
		releaseRequestedAt: new Date("2026-08-02T10:00:00.000Z"),
		releasePriorPhoneStatus: "active",
		releaseAuthorityKeyId: releaseAuthority.keyId,
		releaseAuthorityPrincipalId: releaseAuthority.principalId,
		releaseAuthorityPrincipalType: releaseAuthority.principalType,
		releaseAuthorityUserId: releaseAuthority.userId,
		releaseAuthorityMemberId: releaseAuthority.authorityMemberId,
		releaseAuthoritySessionId: releaseAuthority.authoritySessionId,
		releaseAuthorityWorkspaceId: releaseAuthority.authorityWorkspaceId,
		releaseAuthorityRequiresAllWorkspaceScope:
			releaseAuthority.authorityRequiresAllWorkspaceScope,
		releaseAuthorityCredentialVersion: releaseAuthority.credentialVersion,
		releaseAuthorityAdmittedAt: releaseAuthority.admittedAt,
		releaseAuthorityRevision: releaseAuthority.revision,
		releaseAuthorityRevokedAt: null,
		releasedAt: null,
		...overrides,
	});
}

function takeoverDb(
	initial: PhoneRow,
	options: {
		source?: {
			id: string;
			tokenVersion: number;
			accessToken: string;
			metadata: { waba_id: string };
		} | null;
	} = {},
) {
	const updates: Array<{
		table: unknown;
		values: Record<string, unknown>;
		where: SQL;
	}> = [];
	let sourceSelects = 0;
	let usageReservationSelects = 0;

	const tx = {
		select: (_projection?: Record<string, unknown>) => {
			let sourceTable: unknown;
			const builder = {
				from: (table: unknown) => {
					sourceTable = table;
					return builder;
				},
				innerJoin: (_table: unknown, _condition: unknown) => builder,
				leftJoin: (_table: unknown, _condition: unknown) => builder,
				where: (_condition: unknown) => builder,
				for: (_mode: "share" | "update") => builder,
				limit: async (_limit: number) => {
					if (sourceTable === whatsappPhoneNumbers) {
						const parts = joined(initial);
						const provisioning = { ...parts.provisioning } as Record<
							string,
							unknown
						>;
						const release = { ...parts.release } as Record<string, unknown>;
						delete provisioning.status;
						delete release.status;
						return [{ phone: initial, provisioning, release }];
					}
					if (sourceTable === socialAccounts) {
						sourceSelects += 1;
						return options.source ? [options.source] : [];
					}
					if (sourceTable === usageReservations) {
						usageReservationSelects += 1;
						return usageReservationSelects === 1
							? [{ bucketId: "ub_takeover_1" }]
							: [
									{
										id: "ur_takeover_1",
										organizationId: initial.organizationId,
										bucketId: "ub_takeover_1",
										units: 1,
										state: "reserved",
										committedUnits: null,
										requestMayHaveBeenSentAt: null,
									},
								];
					}
					if (sourceTable === usageBuckets) {
						return [{ id: "ub_takeover_1" }];
					}
					return [];
				},
			};
			return builder;
		},
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: (where: SQL) => ({
					returning: async (_projection?: unknown) => {
						updates.push({ table, values, where });
						if (table === whatsappPhoneReleaseOperations) {
							const release = {
								...initial,
								...values,
								releaseLeaseToken: (initial.releaseLeaseToken ?? 0) + 1,
							} as Record<string, unknown>;
							delete release.status;
							return [release];
						}
						if (table === whatsappPhoneNumbers) {
							return [{ ...initial, ...values }];
						}
						if (table === usageReservations) {
							return [{ state: values.state }];
						}
						return [];
					},
				}),
			}),
		}),
	};
	const db = {
		transaction: async <T>(
			callback: (transaction: typeof tx) => Promise<T>,
		): Promise<T> => callback(tx),
	} as unknown as Database;
	return {
		db,
		updates,
		getSourceSelects: () => sourceSelects,
		getUsageReservationSelects: () => usageReservationSelects,
	};
}

function renderedWhere(update: { where: SQL }): {
	sql: string;
	params: unknown[];
} {
	const query = new PgDialect().sqlToQuery(update.where);
	return { sql: query.sql.replace(/\s+/g, " "), params: query.params };
}

describe("phone release staging fences", () => {
	it("aborts staging when provisioning crosses a provider boundary after the read", async () => {
		const initial = phoneRow();
		const boundary = new Date("2026-08-02T10:01:00.000Z");
		const current = phoneRow({
			provisioningState: "request_may_have_been_sent",
			provisioningRequestMayHaveBeenSentAt: boundary,
		});
		const state = stagingDb(initial, current);

		let failure: unknown;
		try {
			await stagePhoneRelease(
				state.db,
				initial.organizationId,
				initial.id,
				"tenant_deleted",
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(PhoneOperationError);
		expect((failure as PhoneOperationError).code).toBe("IN_PROGRESS");
		expect(state.getPhoneSelects()).toBe(2);
		expect(state.getPhoneUpdates()).toBe(0);
		expect(state.getInserts()).toBe(0);
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0]?.table).toBe(whatsappPhoneProvisioningOperations);

		const update = state.updates[0];
		if (!update) throw new Error("provisioning CAS was not captured");
		const query = renderedWhere(update);
		expect(query.sql).toContain(
			'"whatsapp_phone_provisioning_operations"."status" =',
		);
		expect(query.sql).toContain(
			'"whatsapp_phone_provisioning_operations"."phase" =',
		);
		expect(query.sql).toContain(
			'"whatsapp_phone_provisioning_operations"."lease_token" =',
		);
		expect(query.sql).toContain(
			'"whatsapp_phone_provisioning_operations"."lease_expires_at" =',
		);
		expect(query.sql).toContain(
			'"whatsapp_phone_provisioning_operations"."request_may_have_been_sent_at" is null',
		);
		expect(query.params).toContain(initial.provisioningState);
		expect(query.params).toContain(initial.provisioningPhase);
		expect(query.params).toContain(initial.provisioningLeaseToken);
		expect(query.params).toContain(
			initial.provisioningLeaseExpiresAt?.toISOString(),
		);
	});

	it("returns the concurrent claim instead of resetting a stale failed release", async () => {
		const initial = phoneRow({
			status: "releasing",
			provisioningState: "completed",
			provisioningPhase: "completed",
			provisioningLeaseExpiresAt: null,
			releaseOperationId: "wro_1",
			releaseState: "failed",
			releasePhase: "stripe",
			releaseLeaseToken: 11,
			releaseLeaseExpiresAt: null,
			releaseRequestMayHaveBeenSentAt: null,
			releaseReason: "user_requested",
			releaseAuthorityKeyId: releaseAuthority.keyId,
			releaseAuthorityPrincipalId: releaseAuthority.principalId,
			releaseAuthorityPrincipalType: releaseAuthority.principalType,
			releaseAuthorityUserId: releaseAuthority.userId,
			releaseAuthorityMemberId: releaseAuthority.authorityMemberId,
			releaseAuthoritySessionId: releaseAuthority.authoritySessionId,
			releaseAuthorityWorkspaceId: releaseAuthority.authorityWorkspaceId,
			releaseAuthorityRequiresAllWorkspaceScope:
				releaseAuthority.authorityRequiresAllWorkspaceScope,
			releaseAuthorityCredentialVersion: releaseAuthority.credentialVersion,
			releaseAuthorityAdmittedAt: releaseAuthority.admittedAt,
			releaseAuthorityRevision: releaseAuthority.revision,
		});
		const currentLease = new Date("2026-08-02T10:06:00.000Z");
		const current = phoneRow({
			...initial,
			releaseState: "processing",
			releaseLeaseToken: 12,
			releaseLeaseExpiresAt: currentLease,
		});
		const state = stagingDb(initial, current);

		const result = await stagePhoneRelease(
			state.db,
			initial.organizationId,
			initial.id,
			"user_requested",
			undefined,
			admitReleaseAuthority,
		);

		expect(result.releaseState).toBe("processing");
		expect(result.releaseLeaseToken).toBe(12);
		expect(result.releaseLeaseExpiresAt).toEqual(currentLease);
		expect(state.getPhoneSelects()).toBe(2);
		expect(state.getPhoneUpdates()).toBe(0);
		expect(state.getInserts()).toBe(0);
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0]?.table).toBe(whatsappPhoneReleaseOperations);

		const update = state.updates[0];
		if (!update) throw new Error("release retry CAS was not captured");
		const query = renderedWhere(update);
		expect(query.sql).toContain(
			'"whatsapp_phone_release_operations"."status" =',
		);
		expect(query.sql).toContain(
			'"whatsapp_phone_release_operations"."phase" =',
		);
		expect(query.sql).toContain(
			'"whatsapp_phone_release_operations"."lease_token" =',
		);
		expect(query.sql).toContain(
			'"whatsapp_phone_release_operations"."lease_expires_at" is null',
		);
		expect(query.sql).toContain(
			'"whatsapp_phone_release_operations"."request_may_have_been_sent_at" is null',
		);
		expect(query.params).toContain("failed");
		expect(query.params).toContain(initial.releasePhase);
		expect(query.params).toContain(initial.releaseLeaseToken);
	});

	it("restages a revoke-first cancellation with refreshed source, status, and usage authority", async () => {
		const initial = phoneRow({
			status: "active",
			provisioningState: "completed",
			provisioningPhase: "completed",
			provisioningLeaseExpiresAt: null,
			waPhoneNumberId: "wa_phone_1",
			releaseOperationId: "wro_1",
			releaseReason: "user_requested",
			releaseState: "cancelled",
			releasePhase: "meta",
			releaseMetaStatus: "pending",
			releaseStripeStatus: "pending",
			releaseTelnyxStatus: "not_required",
			releaseLeaseToken: 4,
			releasePriorPhoneStatus: "pending_verification",
			releaseUsageReservationId: "ur_old",
			releaseAuthorityRevision: 1,
			releaseSourceAccountId: null,
			releaseSourceTokenVersion: null,
			releaseAccessTokenCiphertext: null,
		});
		const replacementAuthority: DurableCredentialAuthoritySnapshot = {
			...releaseAuthority,
			keyId: "key_2",
			authorityWorkspaceId: "ws_1",
			authorityRequiresAllWorkspaceScope: false,
		};
		const requestReservation = {
			id: "ur_new",
			bucketId: "ub_new",
			organizationId: initial.organizationId,
			units: 1,
			state: "reserved",
			quotaMode: "hard",
			includedUnits: 100,
			committedUnits: 0,
			reservedUnits: 1,
			periodStart: new Date("2026-08-01T00:00:00.000Z"),
			periodEnd: new Date("2026-09-01T00:00:00.000Z"),
		} satisfies UsageReservation;
		const capturedUpdates: Array<{
			table: unknown;
			values: Record<string, unknown>;
		}> = [];
		let sourceSelects = 0;
		let usageSelects = 0;

		const tx = {
			select: (_projection?: Record<string, unknown>) => {
				let sourceTable: unknown;
				const builder = {
					from: (table: unknown) => {
						sourceTable = table;
						return builder;
					},
					innerJoin: (_table: unknown, _condition: unknown) => builder,
					leftJoin: (_table: unknown, _condition: unknown) => builder,
					where: (_condition: unknown) => builder,
					for: (_mode: "share" | "update") => builder,
					limit: async (_limit: number) => {
						if (sourceTable === whatsappPhoneNumbers) {
							const initialJoin = joined(initial);
							const provisioning = { ...initialJoin.provisioning } as Record<
								string,
								unknown
							>;
							const release = { ...initialJoin.release } as Record<
								string,
								unknown
							>;
							delete provisioning.status;
							delete release.status;
							return [{ phone: initial, provisioning, release }];
						}
						if (sourceTable === socialAccounts) {
							sourceSelects += 1;
							return sourceSelects === 1
								? [{ workspaceId: "ws_1" }]
								: [
										{
											id: initial.provisioningSourceAccountId,
											tokenVersion: 9,
											accessToken: "encrypted-token-v9",
											metadata: { waba_id: "waba_1" },
										},
									];
						}
						if (sourceTable === usageBuckets) {
							return [{ id: usageSelects < 2 ? "ub_old" : "ub_new" }];
						}
						if (sourceTable === usageReservations) {
							const old = usageSelects < 2;
							const candidate = usageSelects % 2 === 0;
							usageSelects += 1;
							if (candidate) {
								return [{ bucketId: old ? "ub_old" : "ub_new" }];
							}
							return [
								{
									id: old ? "ur_old" : "ur_new",
									organizationId: initial.organizationId,
									bucketId: old ? "ub_old" : "ub_new",
									units: 1,
									state: "reserved",
									committedUnits: null,
									requestMayHaveBeenSentAt: new Date(),
								},
							];
						}
						return [];
					},
				};
				return builder;
			},
			update: (table: unknown) => ({
				set: (values: Record<string, unknown>) => ({
					where: (_where: SQL) => ({
						returning: async (_projection?: unknown) => {
							capturedUpdates.push({ table, values });
							if (table === whatsappPhoneReleaseOperations) {
								const release = { ...initial, ...values } as Record<
									string,
									unknown
								>;
								delete release.status;
								return [release];
							}
							if (table === whatsappPhoneNumbers) {
								return [{ ...initial, ...values }];
							}
							if (table === usageReservations) {
								return [{ state: values.state }];
							}
							return [];
						},
					}),
				}),
			}),
		};
		const db = {
			transaction: async <T>(
				callback: (transaction: typeof tx) => Promise<T>,
			): Promise<T> => callback(tx),
		} as unknown as Database;

		const result = await stagePhoneRelease(
			db,
			initial.organizationId,
			initial.id,
			"user_requested",
			requestReservation,
			async (_tx, options) => {
				expect(options?.workspaceId).toBe("ws_1");
				return { ok: true, value: replacementAuthority };
			},
		);

		expect(result.releaseState).toBe("pending");
		expect(result.status).toBe("releasing");
		expect(result.releasePriorPhoneStatus).toBe("active");
		expect(result.releaseUsageReservationId).toBe("ur_new");
		expect(result.releaseAuthorityKeyId).toBe("key_2");
		expect(result.releaseAuthorityRevision).toBe(2);
		expect(result.releaseSourceAccountId).toBe(
			initial.provisioningSourceAccountId,
		);
		expect(result.releaseSourceTokenVersion).toBe(9);
		expect(result.releaseAccessTokenCiphertext).toBe("encrypted-token-v9");
		const releaseUpdate = capturedUpdates.find(
			(update) => update.table === whatsappPhoneReleaseOperations,
		);
		expect(releaseUpdate?.values.releaseAttempts).toBe(0);
		expect(releaseUpdate?.values.releaseRequestedAt).toBeInstanceOf(Date);
		expect(
			capturedUpdates.some(
				(update) =>
					update.table === usageReservations &&
					update.values.state === "committed" &&
					update.values.committedUnits === 0,
			),
		).toBe(true);
		expect(
			capturedUpdates.some(
				(update) =>
					update.table === usageReservations &&
					update.values.state === "parked",
			),
		).toBe(true);
	});

	it("lets tenant deletion take over a cancelled user release with K=0 and a fresh source snapshot", async () => {
		const revokedAt = new Date("2026-08-02T10:03:00.000Z");
		const initial = userReleaseRow({
			status: "active",
			releaseState: "cancelled",
			releaseAuthorityRevokedAt: revokedAt,
			releaseSourceAccountId: null,
			releaseSourceTokenVersion: null,
			releaseAccessTokenCiphertext: null,
		});
		const state = takeoverDb(initial, {
			source: {
				id: "acc_source_1",
				tokenVersion: 9,
				accessToken: "encrypted-token-v9",
				metadata: { waba_id: "waba_1" },
			},
		});

		const result = await stagePhoneRelease(
			state.db,
			initial.organizationId,
			initial.id,
			"tenant_deleted",
		);

		expect(result.releaseReason).toBe("tenant_deleted");
		expect(result.releaseState).toBe("pending");
		expect(result.releaseLeaseToken).toBe(4);
		expect(result.releaseUsageReservationId).toBeNull();
		expect(result.releaseAuthorityKeyId).toBeNull();
		expect(result.releaseAuthorityPrincipalId).toBeNull();
		expect(result.releaseAuthorityRevokedAt).toBeNull();
		expect(result.releasePriorPhoneStatus).toBe("active");
		expect(result.status).toBe("releasing");
		expect(result.releaseSourceTokenVersion).toBe(9);
		expect(result.releaseAccessTokenCiphertext).toBe("encrypted-token-v9");
		expect(state.getSourceSelects()).toBe(1);
		expect(state.getUsageReservationSelects()).toBe(3);
		expect(
			state.updates.some(
				(update) =>
					update.table === usageReservations &&
					update.values.state === "committed" &&
					update.values.committedUnits === 0,
			),
		).toBe(true);
		const takeover = state.updates.find(
			(update) => update.table === whatsappPhoneReleaseOperations,
		);
		if (!takeover) throw new Error("release takeover was not captured");
		const fence = renderedWhere(takeover);
		expect(fence.sql).toContain(
			'"whatsapp_phone_release_operations"."reason" =',
		);
		expect(fence.sql).toContain(
			'"whatsapp_phone_release_operations"."lease_token" =',
		);
		expect(fence.sql).toContain(
			'"whatsapp_phone_release_operations"."authority_revision" =',
		);
		expect(fence.params).toContain("user_requested");
		expect(fence.params).toContain("cancelled");
		expect(fence.params).toContain(initial.releaseLeaseToken);
	});

	it("fences an open user provider boundary and preserves it as unknown under system authority", async () => {
		const marker = new Date("2026-08-02T10:04:00.000Z");
		const initial = userReleaseRow({
			releaseState: "request_may_have_been_sent",
			releaseLeaseExpiresAt: new Date("2026-08-02T10:09:00.000Z"),
			releaseRequestMayHaveBeenSentAt: marker,
			releaseLastError: "provider response was not observed",
		});
		const state = takeoverDb(initial);

		const result = await stagePhoneRelease(
			state.db,
			initial.organizationId,
			initial.id,
			"tenant_deleted",
		);

		expect(result.releaseReason).toBe("tenant_deleted");
		expect(result.releaseState).toBe("unknown");
		expect(result.releaseLeaseToken).toBe(4);
		expect(result.releaseLeaseExpiresAt).toBeNull();
		expect(result.releaseRequestMayHaveBeenSentAt).toEqual(marker);
		expect(result.releaseUsageReservationId).toBe("ur_takeover_1");
		expect(result.releaseAuthorityKeyId).toBeNull();
		expect(result.releaseAuthorityRevokedAt).toBeNull();
		expect(state.getSourceSelects()).toBe(0);
		expect(state.getUsageReservationSelects()).toBe(0);
		expect(
			state.updates.some((update) => update.table === whatsappPhoneNumbers),
		).toBe(false);
	});

	it("continues a revocation-pending release without erasing confirmed effect evidence", async () => {
		const initial = userReleaseRow({
			releaseState: "revocation_pending",
			releasePhase: "stripe",
			releaseMetaStatus: "confirmed",
			releaseAuthorityRevokedAt: new Date("2026-08-02T10:05:00.000Z"),
		});
		const state = takeoverDb(initial);

		const result = await stagePhoneRelease(
			state.db,
			initial.organizationId,
			initial.id,
			"tenant_deleted",
		);

		expect(result.releaseReason).toBe("tenant_deleted");
		expect(result.releaseState).toBe("pending");
		expect(result.releasePhase).toBe("stripe");
		expect(result.releaseMetaStatus).toBe("confirmed");
		expect(result.releaseUsageReservationId).toBe("ur_takeover_1");
		expect(result.releaseAuthorityKeyId).toBeNull();
		expect(result.releaseAuthorityRevokedAt).toBeNull();
		expect(state.getUsageReservationSelects()).toBe(0);
	});

	it("preserves a user release already parked for manual review", async () => {
		const initial = userReleaseRow({
			releaseState: "manual_review",
			releaseLastError: "Meta outcome requires operator correlation",
		});
		const state = takeoverDb(initial);

		const result = await stagePhoneRelease(
			state.db,
			initial.organizationId,
			initial.id,
			"tenant_deleted",
		);

		expect(result.releaseReason).toBe("tenant_deleted");
		expect(result.releaseState).toBe("manual_review");
		expect(result.releaseLastError).toBe(
			"Meta outcome requires operator correlation",
		);
		expect(result.releaseUsageReservationId).toBe("ur_takeover_1");
		expect(result.releaseAuthorityKeyId).toBeNull();
		expect(state.getUsageReservationSelects()).toBe(0);
	});

	it("does not restage a pre-existing nonterminal tenant-deletion release", async () => {
		const initial = userReleaseRow({
			releaseReason: "tenant_deleted",
			releaseAuthorityKeyId: null,
			releaseAuthorityPrincipalId: null,
			releaseAuthorityPrincipalType: null,
			releaseAuthorityUserId: null,
			releaseAuthorityMemberId: null,
			releaseAuthoritySessionId: null,
			releaseAuthorityWorkspaceId: null,
			releaseAuthorityRequiresAllWorkspaceScope: false,
			releaseAuthorityCredentialVersion: null,
			releaseAuthorityAdmittedAt: null,
			releaseAuthorityRevokedAt: null,
		});
		const state = takeoverDb(initial);

		const result = await stagePhoneRelease(
			state.db,
			initial.organizationId,
			initial.id,
			"tenant_deleted",
		);

		expect(result.releaseOperationId).toBe(initial.releaseOperationId);
		expect(result.releaseReason).toBe("tenant_deleted");
		expect(result.releaseState).toBe("pending");
		expect(result.releaseLeaseToken).toBe(initial.releaseLeaseToken);
		expect(state.updates).toHaveLength(0);
		expect(state.getSourceSelects()).toBe(0);
		expect(state.getUsageReservationSelects()).toBe(0);
	});
});
