import {
	accountRevocationJobs,
	apikey,
	automationBindings,
	automationRuns,
	automationScheduledJobs,
	automations,
	autoPostRules,
	broadcasts,
	connectionLogs,
	createDb,
	crossPostActions,
	type Database,
	invitation,
	member,
	organization,
	organizationSubscriptions,
	postRecyclingConfigs,
	posts,
	session,
	socialAccounts,
	tenantDeletionJobs,
	tenantDeletionSteps,
	webhookEndpoints,
	workspaces,
} from "@relayapi/db";
import { and, count, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import Stripe from "stripe";
import { buildAccountCacheKeys } from "../lib/delete-account";
import { isSelfHosted } from "../lib/deployment-mode";
import type { Env } from "../types";
import {
	countIncompletePhoneReleases,
	processDuePhoneReleases,
	stageTenantPhoneReleases,
} from "./phone-number-operations";

const LEASE_MS = 10 * 60_000;
const WAIT_MS = 60_000;
const MAX_JOBS_PER_TICK = 5;
const MAX_R2_OBJECTS_PER_BUCKET = 1000;
const MAX_AVATARS_PER_TICK = 100;
const TENANT_DELETE_BATCH_SIZE = 250;
const MAX_WORK_UNITS_PER_JOB = 8;
const TENANT_MEMBERSHIP_LOCK_RETRIES = 3;

class TenantMembershipSetChangedError extends Error {
	constructor() {
		super("Tenant membership set changed while acquiring deletion locks");
		this.name = "TenantMembershipSetChangedError";
	}
}

function sameSortedIds(
	left: ReadonlyArray<{ id: string }>,
	right: ReadonlyArray<{ id: string }>,
): boolean {
	return (
		left.length === right.length &&
		left.every((row, index) => row.id === right[index]?.id)
	);
}

/**
 * Explicit child-first deletion graph for every auth/public table that carries
 * an organization ownership column. Tables without that column are reached by
 * their declared CASCADE/SET NULL relationships. `tenant_deletion_jobs` is
 * deliberately absent so the final receipt and audit snapshot survive.
 */
function tenantPurgeTable<
	const Schema extends "auth" | "public",
	const Table extends string,
>(schema: Schema, table: Table) {
	return {
		schema,
		table,
		organizationColumn:
			schema === "auth"
				? ("organizationId" as const)
				: ("organization_id" as const),
	};
}

export const TENANT_PURGE_TABLES = [
	tenantPurgeTable("public", "account_revocation_jobs"),
	tenantPurgeTable("public", "ad_audiences"),
	tenantPurgeTable("public", "ad_creation_operations"),
	tenantPurgeTable("public", "ad_sync_logs"),
	tenantPurgeTable("public", "ads"),
	tenantPurgeTable("public", "ad_campaigns"),
	tenantPurgeTable("public", "ad_accounts"),
	tenantPurgeTable("public", "ai_agents"),
	tenantPurgeTable("public", "ai_knowledge_chunks"),
	tenantPurgeTable("public", "ai_knowledge_documents"),
	tenantPurgeTable("public", "ai_knowledge_bases"),
	tenantPurgeTable("public", "api_request_logs"),
	tenantPurgeTable("public", "auto_post_feed_items"),
	tenantPurgeTable("public", "auto_post_rules"),
	tenantPurgeTable("public", "automation_contact_controls"),
	tenantPurgeTable("public", "automation_conversion_events"),
	tenantPurgeTable("public", "automation_effects"),
	tenantPurgeTable("public", "automation_node_executions"),
	tenantPurgeTable("public", "automation_runs"),
	tenantPurgeTable("public", "automation_bindings"),
	tenantPurgeTable("public", "automation_secrets"),
	tenantPurgeTable("public", "automation_webhook_receipts"),
	tenantPurgeTable("public", "automation_entrypoint_daily_counts"),
	tenantPurgeTable("public", "automation_entrypoints"),
	tenantPurgeTable("public", "billing_operations"),
	tenantPurgeTable("public", "billing_outbox"),
	tenantPurgeTable("public", "broadcast_recipients"),
	tenantPurgeTable("public", "broadcasts"),
	tenantPurgeTable("public", "byos_configs"),
	tenantPurgeTable("public", "connection_logs"),
	tenantPurgeTable("public", "contact_channels"),
	tenantPurgeTable("public", "contact_consent_states"),
	tenantPurgeTable("public", "contact_segment_memberships"),
	tenantPurgeTable("public", "contact_subscriptions"),
	tenantPurgeTable("public", "contact_suppressions"),
	tenantPurgeTable("public", "contact_consent_events"),
	tenantPurgeTable("public", "content_templates"),
	tenantPurgeTable("public", "cross_post_actions"),
	tenantPurgeTable("public", "custom_field_values"),
	tenantPurgeTable("public", "custom_field_definitions"),
	tenantPurgeTable("public", "dunning_events"),
	tenantPurgeTable("public", "external_posts"),
	tenantPurgeTable("public", "idea_media"),
	tenantPurgeTable("public", "idea_conversion_operations"),
	tenantPurgeTable("public", "idea_tags"),
	tenantPurgeTable("public", "ideas"),
	tenantPurgeTable("public", "idea_groups"),
	tenantPurgeTable("public", "idempotency_receipts"),
	tenantPurgeTable("public", "inbox_conversation_notes"),
	tenantPurgeTable("public", "inbox_event_effects"),
	tenantPurgeTable("public", "inbox_messages"),
	tenantPurgeTable("public", "inbox_conversations"),
	tenantPurgeTable("public", "contacts"),
	tenantPurgeTable("auth", "invitation"),
	tenantPurgeTable("public", "invite_tokens"),
	tenantPurgeTable("public", "landing_pages"),
	tenantPurgeTable("public", "media"),
	tenantPurgeTable("public", "notification_preferences"),
	tenantPurgeTable("public", "notifications"),
	tenantPurgeTable("auth", "member"),
	tenantPurgeTable("public", "one_time_capabilities"),
	tenantPurgeTable("public", "org_streaks"),
	tenantPurgeTable("public", "organization_settings"),
	tenantPurgeTable("public", "telegram_connection_challenges"),
	tenantPurgeTable("auth", "apikey"),
	tenantPurgeTable("public", "organization_subscriptions"),
	tenantPurgeTable("public", "post_tags"),
	tenantPurgeTable("public", "post_targets"),
	tenantPurgeTable("public", "publish_outbox"),
	tenantPurgeTable("public", "qr_codes"),
	tenantPurgeTable("public", "recycling_occurrences"),
	tenantPurgeTable("public", "post_recycling_configs"),
	tenantPurgeTable("public", "ref_urls"),
	tenantPurgeTable("public", "automations"),
	tenantPurgeTable("public", "segments"),
	tenantPurgeTable("public", "short_link_configs"),
	tenantPurgeTable("public", "short_links"),
	tenantPurgeTable("public", "posts"),
	tenantPurgeTable("public", "signatures"),
	tenantPurgeTable("public", "social_account_sync_state"),
	tenantPurgeTable("public", "subscription_checkout_operations"),
	tenantPurgeTable("public", "subscription_lists"),
	tenantPurgeTable("public", "tags"),
	tenantPurgeTable("public", "thread_executions"),
	tenantPurgeTable("public", "post_threads"),
	tenantPurgeTable("public", "usage_bucket_settlements"),
	tenantPurgeTable("public", "invoices"),
	tenantPurgeTable("public", "usage_records"),
	tenantPurgeTable("public", "usage_reservations"),
	tenantPurgeTable("public", "usage_buckets"),
	tenantPurgeTable("public", "webhook_deliveries"),
	tenantPurgeTable("public", "webhook_logs"),
	tenantPurgeTable("public", "webhook_endpoints"),
	tenantPurgeTable("public", "webhook_events"),
	tenantPurgeTable("public", "whatsapp_phone_numbers"),
	tenantPurgeTable("public", "social_accounts"),
	tenantPurgeTable("public", "workspace_erasure_steps"),
	tenantPurgeTable("public", "workspace_erasure_jobs"),
	tenantPurgeTable("public", "workspace_tombstones"),
	tenantPurgeTable("public", "workspaces"),
] as const;

const TENANT_EXTERNAL_STEP = "external_resources";
const TENANT_SHARED_RECEIPTS_STEP = "shared_receipts";
const TENANT_DELETE_ORGANIZATION_STEP = "delete_organization";

function tenantPurgeStepKey(
	table: (typeof TENANT_PURGE_TABLES)[number],
): string {
	return `purge:${table.schema}.${table.table}`;
}

export function tenantDeletionStepKeys(): string[] {
	return [
		TENANT_EXTERNAL_STEP,
		TENANT_SHARED_RECEIPTS_STEP,
		...TENANT_PURGE_TABLES.map(tenantPurgeStepKey),
		TENANT_DELETE_ORGANIZATION_STEP,
	];
}

interface CleanupPayload {
	stripe_subscription_id?: string | null;
	stripe_customer_id?: string | null;
	r2_prefix?: string;
	provider_accounts?: string[];
	media_prefix_complete?: boolean;
	thumbnail_prefix_complete?: boolean;
	queue_rescue_prefix_complete?: boolean;
}

export interface TenantDeletionRequestResult {
	status: "tombstoned";
	apiKeyHashes: string[];
	dashboardPrincipalIds: string[];
	workspaceIds: string[];
	accountCacheKeys: string[];
}

export class TenantDeletionNotFoundError extends Error {
	constructor() {
		super("Organization not found");
		this.name = "TenantDeletionNotFoundError";
	}
}

/**
 * Atomically fence a tenant from new work and durably stage every cleanup
 * operation before credentials or membership are removed. Provider calls and
 * bounded R2 cleanup remain on the scheduled worker path.
 */
export async function requestTenantDeletion(
	db: Database,
	organizationId: string,
	requestedBy: string,
): Promise<TenantDeletionRequestResult> {
	for (
		let attempt = 1;
		attempt <= TENANT_MEMBERSHIP_LOCK_RETRIES;
		attempt += 1
	) {
		try {
			return await db.transaction(
				async (tx) => {
					// PostgreSQL locks a member tuple before its row-level BEFORE trigger
					// runs. Use that universally enforceable order everywhere:
					// member tuple(s) -> owner advisory lock -> organization row. Locking
					// the tenant's complete membership set first prevents a concurrent
					// identity deletion or raw member mutation from forming an org/member
					// cycle with tenant erasure.
					const lockedMemberships = await tx
						.select({ id: member.id })
						.from(member)
						.where(eq(member.organizationId, organizationId))
						.orderBy(member.id)
						.for("update");
					await tx.execute(
						sql`select pg_advisory_xact_lock(hashtext(${`relayapi:org-owner:${organizationId}`}))`,
					);

					const [org] = await tx
						.select({
							id: organization.id,
							name: organization.name,
							slug: organization.slug,
							lifecycleStatus: organization.lifecycleStatus,
						})
						.from(organization)
						.where(eq(organization.id, organizationId))
						.for("update")
						.limit(1);
					if (!org) throw new TenantDeletionNotFoundError();

					// A member insert can commit between the first row scan and the parent
					// lock. READ COMMITTED gives this recheck a fresh snapshot; retrying the
					// whole transaction then locks the expanded set before any mutation.
					// Once the parent FOR UPDATE lock is held, FK validation blocks further
					// member inserts until this transaction finishes.
					const currentMemberships = await tx
						.select({ id: member.id })
						.from(member)
						.where(eq(member.organizationId, organizationId))
						.orderBy(member.id);
					if (!sameSortedIds(lockedMemberships, currentMemberships)) {
						throw new TenantMembershipSetChangedError();
					}

					const [keyRows, workspaceRows] = await Promise.all([
						tx
							.select({ key: apikey.key, referenceId: apikey.referenceId })
							.from(apikey)
							.where(eq(apikey.organizationId, organizationId)),
						tx
							.select({ id: workspaces.id })
							.from(workspaces)
							.where(eq(workspaces.organizationId, organizationId)),
					]);

					const accounts = await tx
						.select()
						.from(socialAccounts)
						.where(eq(socialAccounts.organizationId, organizationId))
						.for("update");

					const result: TenantDeletionRequestResult = {
						status: "tombstoned",
						apiKeyHashes: keyRows.map(({ key }) => key),
						dashboardPrincipalIds: [
							...new Set(
								keyRows.flatMap(({ referenceId }) =>
									referenceId ? [referenceId] : [],
								),
							),
						],
						workspaceIds: workspaceRows.map(({ id }) => id),
						accountCacheKeys: accounts.flatMap((account) =>
							buildAccountCacheKeys({
								accountId: account.id,
								platform: account.platform,
								platformAccountId: account.platformAccountId,
								webhookAccountId: account.webhookAccountId,
							}),
						),
					};
					if (org.lifecycleStatus === "tombstoned") return result;
					const [subscription] = await tx
						.select({
							stripeSubscriptionId:
								organizationSubscriptions.stripeSubscriptionId,
							stripeCustomerId: organizationSubscriptions.stripeCustomerId,
						})
						.from(organizationSubscriptions)
						.where(eq(organizationSubscriptions.organizationId, organizationId))
						.limit(1);

					await tx
						.insert(tenantDeletionJobs)
						.values({
							organizationId,
							status: "pending",
							requestedBy,
							auditSnapshot: {
								organization_id: org.id,
								name: org.name,
								slug: org.slug,
								account_ids: accounts.map((account) => account.id),
								requested_at: new Date().toISOString(),
							},
							cleanupPayload: {
								stripe_subscription_id:
									subscription?.stripeSubscriptionId ?? null,
								stripe_customer_id: subscription?.stripeCustomerId ?? null,
								r2_prefix: `${organizationId}/`,
								provider_accounts: accounts.map((account) => account.id),
							},
							nextAttemptAt: new Date(),
						})
						.onConflictDoUpdate({
							target: tenantDeletionJobs.organizationId,
							set: {
								status: "pending",
								requestedBy,
								attempts: 0,
								nextAttemptAt: new Date(),
								leaseExpiresAt: null,
								lastError: null,
								completedAt: null,
								updatedAt: new Date(),
							},
						});
					await tx
						.insert(tenantDeletionSteps)
						.values(
							tenantDeletionStepKeys().map((stepKey) => ({
								organizationId,
								stepKey,
							})),
						)
						.onConflictDoNothing({
							target: [
								tenantDeletionSteps.organizationId,
								tenantDeletionSteps.stepKey,
							],
						});

					// Snapshot every paid phone-provider resource while its exact provisioning
					// grant is still available. Nested transactions are savepoints on Postgres.
					await stageTenantPhoneReleases(
						tx as unknown as Database,
						organizationId,
					);

					const now = new Date();
					await tx
						.update(organization)
						.set({ lifecycleStatus: "deleting", deletionRequestedAt: now })
						.where(eq(organization.id, organizationId));
					await tx
						.update(apikey)
						.set({ enabled: false, updatedAt: now })
						.where(eq(apikey.organizationId, organizationId));

					for (const account of accounts) {
						if (account.lifecycleStatus === "disconnected") continue;
						await tx
							.insert(accountRevocationJobs)
							.values({
								accountId: account.id,
								organizationId,
								platform: account.platform,
								accessTokenCiphertext: account.accessToken,
								refreshTokenCiphertext: account.refreshToken,
								sourceTokenVersion: account.tokenVersion,
								status: "pending",
								nextAttemptAt: now,
							})
							.onConflictDoUpdate({
								target: accountRevocationJobs.accountId,
								set: {
									accessTokenCiphertext: account.accessToken,
									refreshTokenCiphertext: account.refreshToken,
									sourceTokenVersion: account.tokenVersion,
									status: "pending",
									attempts: 0,
									nextAttemptAt: now,
									leaseExpiresAt: null,
									lastError: null,
									providerResponse: null,
									completedAt: null,
									updatedAt: now,
								},
							});
						if (account.lifecycleStatus === "active") {
							await tx.insert(connectionLogs).values({
								organizationId,
								socialAccountId: account.id,
								platform: account.platform,
								event: "disconnecting",
								message: "Tenant deletion requested",
								snapshot: {
									account_id: account.id,
									reason: "tenant_deleted",
									requested_at: now.toISOString(),
								},
							});
						}
					}

					await tx
						.update(socialAccounts)
						.set({
							lifecycleStatus: "disconnecting",
							disconnectRequestedAt: now,
							disconnectReason: "tenant_deleted",
							tokenExpiresAt: null,
							updatedAt: now,
						})
						.where(
							and(
								eq(socialAccounts.organizationId, organizationId),
								ne(socialAccounts.lifecycleStatus, "disconnected"),
							),
						);
					await tx
						.update(posts)
						.set({
							status: "failed",
							revision: sql`${posts.revision} + 1`,
							updatedAt: now,
						})
						.where(
							and(
								eq(posts.organizationId, organizationId),
								inArray(posts.status, ["scheduled", "publishing"]),
							),
						);
					await tx
						.update(postRecyclingConfigs)
						.set({ enabled: false, updatedAt: now })
						.where(eq(postRecyclingConfigs.organizationId, organizationId));
					await tx
						.update(autoPostRules)
						.set({ status: "paused", leaseExpiresAt: null, updatedAt: now })
						.where(eq(autoPostRules.organizationId, organizationId));
					await tx
						.update(broadcasts)
						.set({
							status: "cancelled",
							completedAt: now,
							leaseExpiresAt: null,
							revision: sql`${broadcasts.revision} + 1`,
							updatedAt: now,
						})
						.where(
							and(
								eq(broadcasts.organizationId, organizationId),
								inArray(broadcasts.status, ["draft", "scheduled", "sending"]),
							),
						);
					await tx
						.update(webhookEndpoints)
						.set({ enabled: false, updatedAt: now })
						.where(eq(webhookEndpoints.organizationId, organizationId));
					await tx
						.update(crossPostActions)
						.set({
							status: "cancelled",
							leaseExpiresAt: null,
							completedAt: now,
							error: "Tenant deletion requested",
						})
						.where(
							and(
								inArray(
									crossPostActions.postId,
									tx
										.select({ id: posts.id })
										.from(posts)
										.where(eq(posts.organizationId, organizationId)),
								),
								inArray(crossPostActions.status, [
									"pending",
									"processing",
									"retry",
								]),
							),
						);
					await tx
						.update(automations)
						.set({ status: "paused", updatedAt: now })
						.where(eq(automations.organizationId, organizationId));
					await tx
						.update(automationBindings)
						.set({ status: "inactive", updatedAt: now })
						.where(eq(automationBindings.organizationId, organizationId));
					const tenantAutomationIds = tx
						.select({ id: automations.id })
						.from(automations)
						.where(eq(automations.organizationId, organizationId));
					await tx
						.update(automationRuns)
						.set({
							status: "exited",
							exitReason: "tenant_deleted",
							waitingFor: null,
							waitingUntil: null,
							completedAt: now,
							revision: sql`${automationRuns.revision} + 1`,
							updatedAt: now,
						})
						.where(
							and(
								inArray(automationRuns.automationId, tenantAutomationIds),
								inArray(automationRuns.status, ["active", "waiting"]),
							),
						);
					await tx
						.update(automationScheduledJobs)
						.set({ status: "failed", error: "Tenant deletion requested" })
						.where(
							and(
								inArray(
									automationScheduledJobs.automationId,
									tenantAutomationIds,
								),
								eq(automationScheduledJobs.status, "pending"),
							),
						);
					await tx
						.update(session)
						.set({ activeOrganizationId: null, updatedAt: now })
						.where(eq(session.activeOrganizationId, organizationId));
					await tx
						.delete(invitation)
						.where(eq(invitation.organizationId, organizationId));
					await tx
						.delete(member)
						.where(eq(member.organizationId, organizationId));
					await tx
						.update(organization)
						.set({ lifecycleStatus: "tombstoned", tombstonedAt: now })
						.where(eq(organization.id, organizationId));
					await tx
						.update(tenantDeletionJobs)
						.set({
							status: "tombstoned",
							nextAttemptAt: now,
							leaseExpiresAt: null,
							completedAt: null,
							updatedAt: now,
						})
						.where(eq(tenantDeletionJobs.organizationId, organizationId));

					return result;
				},
				{ isolationLevel: "read committed" },
			);
		} catch (error) {
			if (
				!(error instanceof TenantMembershipSetChangedError) ||
				attempt === TENANT_MEMBERSHIP_LOCK_RETRIES
			) {
				throw error;
			}
		}
	}

	throw new TenantMembershipSetChangedError();
}

async function deleteBucketPrefixPage(
	bucket: R2Bucket,
	prefix: string,
): Promise<boolean> {
	const page = await bucket.list({
		prefix,
		limit: MAX_R2_OBJECTS_PER_BUCKET,
	});
	if (page.objects.length > 0) {
		await bucket.delete(page.objects.map((object) => object.key));
	}
	return !page.truncated;
}

async function getAccountRevocationState(
	db: ReturnType<typeof createDb>,
	organizationId: string,
): Promise<{ incomplete: number; manualReview: number }> {
	const [incomplete, manual] = await Promise.all([
		db
			.select({ value: count() })
			.from(accountRevocationJobs)
			.where(
				and(
					eq(accountRevocationJobs.organizationId, organizationId),
					ne(accountRevocationJobs.status, "succeeded"),
				),
			),
		db
			.select({ value: count() })
			.from(accountRevocationJobs)
			.where(
				and(
					eq(accountRevocationJobs.organizationId, organizationId),
					eq(accountRevocationJobs.status, "manual_required"),
				),
			),
	]);
	return {
		incomplete: incomplete[0]?.value ?? 0,
		manualReview: manual[0]?.value ?? 0,
	};
}

type TenantDeletionDb = ReturnType<typeof createDb>;
type TenantDeletionJob = typeof tenantDeletionJobs.$inferSelect;
type TenantDeletionStep = typeof tenantDeletionSteps.$inferSelect;

type TenantStepResult =
	| { kind: "completed"; rowsDeleted?: number; cleanupPayload?: CleanupPayload }
	| {
			kind: "pending";
			rowsDeleted?: number;
			cursor?: Record<string, unknown> | null;
			delayMs?: number;
			reason?: string;
			cleanupPayload?: CleanupPayload;
			jobStatus?: "tombstoned" | "waiting_external";
	  }
	| { kind: "manual_review"; reason: string };

interface SharedReceiptCursor {
	table_index?: number;
	action?: "delete_single_owner" | "remove_shared_scope";
}

function parseTenantCursor<T extends object>(value: unknown): Partial<T> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Partial<T>)
		: {};
}

function tenantRetryDelay(attempts: number): number {
	return Math.min(86_400_000, 2 ** Math.min(attempts, 10) * 60_000);
}

async function ensureTenantDeletionSteps(
	db: TenantDeletionDb,
	organizationId: string,
): Promise<void> {
	await db
		.insert(tenantDeletionSteps)
		.values(
			tenantDeletionStepKeys().map((stepKey) => ({
				organizationId,
				stepKey,
			})),
		)
		.onConflictDoNothing({
			target: [tenantDeletionSteps.organizationId, tenantDeletionSteps.stepKey],
		});
}

async function claimTenantDeletionStep(
	db: TenantDeletionDb,
	job: TenantDeletionJob,
	stepKey: string,
): Promise<TenantDeletionStep | null> {
	const now = new Date();
	const [step] = await db
		.update(tenantDeletionSteps)
		.set({
			status: "processing",
			attempts: sql`${tenantDeletionSteps.attempts} + 1`,
			leaseToken: sql`${tenantDeletionSteps.leaseToken} + 1`,
			leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
			lastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(tenantDeletionSteps.organizationId, job.organizationId),
				eq(tenantDeletionSteps.stepKey, stepKey),
				lte(tenantDeletionSteps.nextAttemptAt, now),
				or(
					inArray(tenantDeletionSteps.status, ["pending", "failed"]),
					and(
						eq(tenantDeletionSteps.status, "processing"),
						lte(tenantDeletionSteps.leaseExpiresAt, now),
					),
				),
			),
		)
		.returning();
	return step ?? null;
}

async function persistTenantStepResult(
	db: TenantDeletionDb,
	job: TenantDeletionJob,
	step: TenantDeletionStep,
	result: TenantStepResult,
): Promise<boolean> {
	const now = new Date();
	const rowsDeleted = "rowsDeleted" in result ? (result.rowsDeleted ?? 0) : 0;
	const ownedStep = and(
		eq(tenantDeletionSteps.id, step.id),
		eq(tenantDeletionSteps.status, "processing"),
		eq(tenantDeletionSteps.leaseToken, step.leaseToken),
	);
	if (result.kind === "completed") {
		const updated = await db
			.update(tenantDeletionSteps)
			.set({
				status: "completed",
				cursor: null,
				rowsDeleted: sql`${tenantDeletionSteps.rowsDeleted} + ${rowsDeleted}`,
				leaseExpiresAt: null,
				lastError: null,
				completedAt: now,
				updatedAt: now,
			})
			.where(ownedStep)
			.returning({ id: tenantDeletionSteps.id });
		if (result.cleanupPayload) {
			await db
				.update(tenantDeletionJobs)
				.set({ cleanupPayload: result.cleanupPayload, updatedAt: now })
				.where(
					and(
						eq(tenantDeletionJobs.organizationId, job.organizationId),
						eq(tenantDeletionJobs.status, "processing"),
						eq(tenantDeletionJobs.leaseToken, job.leaseToken),
					),
				);
		}
		return updated.length === 1;
	}
	if (result.kind === "manual_review") {
		await db.transaction(async (tx) => {
			await tx
				.update(tenantDeletionSteps)
				.set({
					status: "manual_review",
					leaseExpiresAt: null,
					lastError: result.reason,
					updatedAt: now,
				})
				.where(ownedStep);
			await tx
				.update(tenantDeletionJobs)
				.set({
					status: "manual_review",
					leaseExpiresAt: null,
					lastError: result.reason,
					updatedAt: now,
				})
				.where(
					and(
						eq(tenantDeletionJobs.organizationId, job.organizationId),
						eq(tenantDeletionJobs.status, "processing"),
						eq(tenantDeletionJobs.leaseToken, job.leaseToken),
					),
				);
		});
		return true;
	}

	const nextAttemptAt = new Date(now.getTime() + (result.delayMs ?? 0));
	const updated = await db
		.update(tenantDeletionSteps)
		.set({
			status: "pending",
			cursor: result.cursor ?? step.cursor,
			rowsDeleted: sql`${tenantDeletionSteps.rowsDeleted} + ${rowsDeleted}`,
			leaseExpiresAt: null,
			nextAttemptAt,
			lastError: result.reason ?? null,
			updatedAt: now,
		})
		.where(ownedStep)
		.returning({ id: tenantDeletionSteps.id });
	if (result.cleanupPayload) {
		await db
			.update(tenantDeletionJobs)
			.set({ cleanupPayload: result.cleanupPayload, updatedAt: now })
			.where(
				and(
					eq(tenantDeletionJobs.organizationId, job.organizationId),
					eq(tenantDeletionJobs.status, "processing"),
					eq(tenantDeletionJobs.leaseToken, job.leaseToken),
				),
			);
	}
	return updated.length === 1;
}

async function processTenantExternalResources(
	db: TenantDeletionDb,
	env: Env,
	stripe: Stripe | undefined,
	job: TenantDeletionJob,
): Promise<TenantStepResult> {
	await processDuePhoneReleases(env, {
		organizationId: job.organizationId,
		limit: 5,
	});
	const [phones, accounts] = await Promise.all([
		countIncompletePhoneReleases(db, job.organizationId),
		getAccountRevocationState(db, job.organizationId),
	]);
	if (phones.manualReview > 0 || accounts.manualReview > 0) {
		return {
			kind: "manual_review",
			reason: `External cleanup requires manual review (phones=${phones.manualReview}, accounts=${accounts.manualReview})`,
		};
	}
	if (phones.incomplete > 0 || accounts.incomplete > 0) {
		return {
			kind: "pending",
			jobStatus: "waiting_external",
			delayMs: WAIT_MS,
			reason: `Waiting for external cleanup (phones=${phones.incomplete}, accounts=${accounts.incomplete})`,
		};
	}

	const payload = { ...((job.cleanupPayload ?? {}) as CleanupPayload) };
	if (payload.stripe_subscription_id) {
		if (!stripe) {
			return {
				kind: "manual_review",
				reason:
					"A Stripe subscription is attached, but billing is disabled for this self-hosted deployment",
			};
		}
		try {
			await stripe.subscriptions.cancel(
				payload.stripe_subscription_id,
				{},
				{
					idempotencyKey: `relayapi:tenant-delete:${job.organizationId}:subscription`,
				},
			);
		} catch (error) {
			if (
				!(
					error instanceof Stripe.errors.StripeInvalidRequestError &&
					error.statusCode === 404
				)
			) {
				throw error;
			}
		}
		payload.stripe_subscription_id = null;
	}

	const prefix = payload.r2_prefix ?? `${job.organizationId}/`;
	const avatarBatch = (payload.provider_accounts ?? []).slice(
		0,
		MAX_AVATARS_PER_TICK,
	);
	const avatarKeys = avatarBatch.map((id) => `avatars/${id}`);
	const [mediaComplete, thumbnailComplete, queueRescueComplete] =
		await Promise.all([
			payload.media_prefix_complete
				? Promise.resolve(true)
				: deleteBucketPrefixPage(env.MEDIA_BUCKET, prefix),
			payload.thumbnail_prefix_complete
				? Promise.resolve(true)
				: deleteBucketPrefixPage(env.THUMBNAIL_BUCKET, prefix),
			payload.queue_rescue_prefix_complete
				? Promise.resolve(true)
				: deleteBucketPrefixPage(
						env.QUEUE_RESCUE_BUCKET,
						`queue-rescue/by-organization/${job.organizationId}/`,
					),
			avatarKeys.length > 0
				? Promise.all([
						env.AVATAR_BUCKET.delete(avatarKeys),
						env.MEDIA_BUCKET.delete(avatarKeys),
					])
				: Promise.resolve(),
		]);
	payload.media_prefix_complete = mediaComplete;
	payload.thumbnail_prefix_complete = thumbnailComplete;
	payload.queue_rescue_prefix_complete = queueRescueComplete;
	payload.provider_accounts = (payload.provider_accounts ?? []).slice(
		avatarBatch.length,
	);
	const cleanupComplete =
		mediaComplete &&
		thumbnailComplete &&
		queueRescueComplete &&
		payload.provider_accounts.length === 0;
	return cleanupComplete
		? { kind: "completed", cleanupPayload: payload }
		: {
				kind: "pending",
				jobStatus: "waiting_external",
				delayMs: WAIT_MS,
				reason: "Bounded object-storage cleanup has more pages",
				cleanupPayload: payload,
			};
}

async function processSharedReceiptBatch(
	db: TenantDeletionDb,
	job: TenantDeletionJob,
	step: TenantDeletionStep,
): Promise<TenantStepResult> {
	const tables = ["queue_failures", "inbound_webhook_events"] as const;
	const cursor = parseTenantCursor<SharedReceiptCursor>(step.cursor);
	const tableIndex = cursor.table_index ?? 0;
	const table = tables[tableIndex];
	if (!table) return { kind: "completed" };
	const action = cursor.action ?? "delete_single_owner";

	if (action === "delete_single_owner") {
		const deleted = await db.execute<{ deleted: number }>(sql`
			WITH candidates AS (
				SELECT target.ctid
				FROM public.${sql.identifier(table)} AS target
				WHERE target.organization_ids @> ARRAY[${job.organizationId}]::text[]
				  AND cardinality(target.organization_ids) = 1
				ORDER BY target.ctid
				LIMIT ${TENANT_DELETE_BATCH_SIZE}
				FOR UPDATE OF target SKIP LOCKED
			)
			DELETE FROM public.${sql.identifier(table)} AS target
			USING candidates
			WHERE target.ctid = candidates.ctid
			RETURNING 1 AS deleted
		`);
		return {
			kind: "pending",
			rowsDeleted: deleted.length,
			cursor: {
				table_index: tableIndex,
				action:
					deleted.length < TENANT_DELETE_BATCH_SIZE
						? "remove_shared_scope"
						: action,
			},
		};
	}

	const updated = await db.execute<{ updated: number }>(sql`
		WITH candidates AS (
			SELECT target.ctid
			FROM public.${sql.identifier(table)} AS target
			WHERE target.organization_ids @> ARRAY[${job.organizationId}]::text[]
			  AND cardinality(target.organization_ids) > 1
			ORDER BY target.ctid
			LIMIT ${TENANT_DELETE_BATCH_SIZE}
			FOR UPDATE OF target SKIP LOCKED
		)
		UPDATE public.${sql.identifier(table)} AS target
		SET organization_ids = array_remove(target.organization_ids, ${job.organizationId})
			${
				table === "queue_failures"
					? sql`, payload = jsonb_strip_nulls(jsonb_build_object(
						'redacted', true,
						'reason', 'deleted_tenant_scope_removed',
						'operation_id', target.operation_id
					))`
					: sql``
			}
		FROM candidates
		WHERE target.ctid = candidates.ctid
		RETURNING 1 AS updated
	`);
	return {
		kind: "pending",
		rowsDeleted: updated.length,
		cursor: {
			table_index:
				updated.length < TENANT_DELETE_BATCH_SIZE ? tableIndex + 1 : tableIndex,
			action:
				updated.length < TENANT_DELETE_BATCH_SIZE
					? "delete_single_owner"
					: action,
		},
	};
}

async function deleteTenantTableBatch(
	db: TenantDeletionDb,
	organizationId: string,
	table: (typeof TENANT_PURGE_TABLES)[number],
): Promise<number> {
	const deleted = await db.execute<{ deleted: number }>(sql`
		WITH candidates AS (
			SELECT target.ctid
			FROM ${sql.identifier(table.schema)}.${sql.identifier(table.table)} AS target
			WHERE target.${sql.identifier(table.organizationColumn)} = ${organizationId}
			ORDER BY target.ctid
			LIMIT ${TENANT_DELETE_BATCH_SIZE}
			FOR UPDATE OF target SKIP LOCKED
		)
		DELETE FROM ${sql.identifier(table.schema)}.${sql.identifier(table.table)} AS target
		USING candidates
		WHERE target.ctid = candidates.ctid
		RETURNING 1 AS deleted
	`);
	return deleted.length;
}

async function completeTenantDeletion(
	db: TenantDeletionDb,
	job: TenantDeletionJob,
	step: TenantDeletionStep,
): Promise<void> {
	await db.transaction(async (tx) => {
		const [ownedJob] = await tx
			.select({ organizationId: tenantDeletionJobs.organizationId })
			.from(tenantDeletionJobs)
			.where(
				and(
					eq(tenantDeletionJobs.organizationId, job.organizationId),
					eq(tenantDeletionJobs.status, "processing"),
					eq(tenantDeletionJobs.leaseToken, job.leaseToken),
				),
			)
			.for("update")
			.limit(1);
		if (!ownedJob) throw new Error("Tenant deletion lease was lost");

		await tx
			.delete(organization)
			.where(eq(organization.id, job.organizationId));
		const completedAt = new Date();
		const completedStep = await tx
			.update(tenantDeletionSteps)
			.set({
				status: "completed",
				cursor: null,
				leaseExpiresAt: null,
				lastError: null,
				completedAt,
				updatedAt: completedAt,
			})
			.where(
				and(
					eq(tenantDeletionSteps.id, step.id),
					eq(tenantDeletionSteps.status, "processing"),
					eq(tenantDeletionSteps.leaseToken, step.leaseToken),
				),
			)
			.returning({ id: tenantDeletionSteps.id });
		if (completedStep.length !== 1) {
			throw new Error("Tenant final deletion step lease was lost");
		}
		const completedJob = await tx
			.update(tenantDeletionJobs)
			.set({
				status: "purged",
				requestedBy: null,
				auditSnapshot: {
					redacted: true,
					organization_id: job.organizationId,
				},
				cleanupPayload: { redacted: true },
				leaseExpiresAt: null,
				lastError: null,
				completedAt,
				updatedAt: completedAt,
			})
			.where(
				and(
					eq(tenantDeletionJobs.organizationId, job.organizationId),
					eq(tenantDeletionJobs.status, "processing"),
					eq(tenantDeletionJobs.leaseToken, job.leaseToken),
				),
			)
			.returning({ organizationId: tenantDeletionJobs.organizationId });
		if (completedJob.length !== 1) {
			throw new Error("Tenant deletion lease was lost during completion");
		}
	});
}

async function processClaimedTenantJob(
	db: TenantDeletionDb,
	env: Env,
	stripe: Stripe | undefined,
	job: TenantDeletionJob,
): Promise<void> {
	await ensureTenantDeletionSteps(db, job.organizationId);
	const orderedKeys = tenantDeletionStepKeys();
	let releaseStatus: "tombstoned" | "waiting_external" = "tombstoned";
	let releaseAt = new Date();
	let releaseReason: string | null = null;

	for (let unit = 0; unit < MAX_WORK_UNITS_PER_JOB; unit += 1) {
		const steps = await db
			.select()
			.from(tenantDeletionSteps)
			.where(eq(tenantDeletionSteps.organizationId, job.organizationId));
		const byKey = new Map(
			steps.map((candidate) => [candidate.stepKey, candidate]),
		);
		const nextKey = orderedKeys.find(
			(key) => byKey.get(key)?.status !== "completed",
		);
		if (!nextKey) {
			throw new Error(
				"Tenant deletion completed without deleting the organization",
			);
		}
		if (byKey.get(nextKey)?.status === "manual_review") return;
		const step = await claimTenantDeletionStep(db, job, nextKey);
		if (!step) break;
		if (nextKey === TENANT_DELETE_ORGANIZATION_STEP) {
			await completeTenantDeletion(db, job, step);
			return;
		}

		let result: TenantStepResult;
		if (nextKey === TENANT_EXTERNAL_STEP) {
			result = await processTenantExternalResources(db, env, stripe, job);
		} else if (nextKey === TENANT_SHARED_RECEIPTS_STEP) {
			result = await processSharedReceiptBatch(db, job, step);
		} else {
			const table = TENANT_PURGE_TABLES.find(
				(candidate) => tenantPurgeStepKey(candidate) === nextKey,
			);
			if (!table) throw new Error(`Unknown tenant purge step: ${nextKey}`);
			const deleted = await deleteTenantTableBatch(
				db,
				job.organizationId,
				table,
			);
			result =
				deleted < TENANT_DELETE_BATCH_SIZE
					? { kind: "completed", rowsDeleted: deleted }
					: { kind: "pending", rowsDeleted: deleted };
		}

		const persisted = await persistTenantStepResult(db, job, step, result);
		if (!persisted || result.kind === "manual_review") return;
		if (result.kind === "pending") {
			releaseStatus = result.jobStatus ?? "tombstoned";
			releaseAt = new Date(Date.now() + (result.delayMs ?? 0));
			releaseReason = result.reason ?? null;
			if ((result.delayMs ?? 0) > 0 || nextKey === TENANT_EXTERNAL_STEP) break;
		}
	}

	const releasedAt = new Date();
	await db
		.update(tenantDeletionJobs)
		.set({
			status: releaseStatus,
			leaseExpiresAt: null,
			nextAttemptAt: releaseAt,
			lastError: releaseReason,
			updatedAt: releasedAt,
		})
		.where(
			and(
				eq(tenantDeletionJobs.organizationId, job.organizationId),
				eq(tenantDeletionJobs.status, "processing"),
				eq(tenantDeletionJobs.leaseToken, job.leaseToken),
			),
		);
}

async function failTenantDeletionJob(
	db: TenantDeletionDb,
	job: TenantDeletionJob,
	error: unknown,
): Promise<void> {
	const attempts = job.attempts + 1;
	const now = new Date();
	const nextAttemptAt = new Date(now.getTime() + tenantRetryDelay(attempts));
	const message = error instanceof Error ? error.message : String(error);
	await db.transaction(async (tx) => {
		await tx
			.update(tenantDeletionSteps)
			.set({
				status: "failed",
				leaseExpiresAt: null,
				lastError: message,
				nextAttemptAt,
				updatedAt: now,
			})
			.where(
				and(
					eq(tenantDeletionSteps.organizationId, job.organizationId),
					eq(tenantDeletionSteps.status, "processing"),
				),
			);
		await tx
			.update(tenantDeletionJobs)
			.set({
				status: "failed",
				attempts,
				leaseExpiresAt: null,
				lastError: message,
				nextAttemptAt,
				completedAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(tenantDeletionJobs.organizationId, job.organizationId),
					eq(tenantDeletionJobs.status, "processing"),
					eq(tenantDeletionJobs.leaseToken, job.leaseToken),
				),
			);
	});
}

export async function processTenantDeletionJobs(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const stripe = isSelfHosted(env)
		? undefined
		: new Stripe(env.STRIPE_SECRET_KEY);
	const now = new Date();
	const candidates = await db
		.select({ organizationId: tenantDeletionJobs.organizationId })
		.from(tenantDeletionJobs)
		.where(
			and(
				inArray(tenantDeletionJobs.status, [
					"tombstoned",
					"waiting_external",
					"failed",
					"processing",
				]),
				lte(tenantDeletionJobs.nextAttemptAt, now),
				or(
					inArray(tenantDeletionJobs.status, [
						"tombstoned",
						"waiting_external",
						"failed",
					]),
					and(
						eq(tenantDeletionJobs.status, "processing"),
						lte(tenantDeletionJobs.leaseExpiresAt, now),
					),
				),
			),
		)
		.orderBy(
			tenantDeletionJobs.nextAttemptAt,
			tenantDeletionJobs.organizationId,
		)
		.limit(MAX_JOBS_PER_TICK);

	for (const candidate of candidates) {
		const claimedAt = new Date();
		const [job] = await db
			.update(tenantDeletionJobs)
			.set({
				status: "processing",
				leaseToken: sql`${tenantDeletionJobs.leaseToken} + 1`,
				leaseExpiresAt: new Date(claimedAt.getTime() + LEASE_MS),
				lastError: null,
				updatedAt: claimedAt,
			})
			.where(
				and(
					eq(tenantDeletionJobs.organizationId, candidate.organizationId),
					lte(tenantDeletionJobs.nextAttemptAt, claimedAt),
					inArray(tenantDeletionJobs.status, [
						"tombstoned",
						"waiting_external",
						"failed",
						"processing",
					]),
					or(
						inArray(tenantDeletionJobs.status, [
							"tombstoned",
							"waiting_external",
							"failed",
						]),
						and(
							eq(tenantDeletionJobs.status, "processing"),
							lte(tenantDeletionJobs.leaseExpiresAt, claimedAt),
						),
					),
				),
			)
			.returning();
		if (!job) continue;
		try {
			await processClaimedTenantJob(db, env, stripe, job);
		} catch (error) {
			await failTenantDeletionJob(db, job, error);
		}
	}
}
