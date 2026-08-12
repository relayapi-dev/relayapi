/**
 * Executable trace from the non-keep decisions in audit §3 to implementation
 * evidence. The companion test parses the Markdown ledger, compares it to this
 * inventory, checks every source assertion, verifies physical table
 * presence/absence, and resolves every retention store.
 *
 * `gap` is deliberately a first-class state. It is better for the freeze gate
 * to name unfinished decisive work than to point at an adjacent file and call
 * that coverage. `not_applicable` is reserved for a layer that the capability
 * genuinely does not expose (most commonly an internal receipt with no public
 * API/SDK surface).
 */

export type SchemaFreezeAuditAction = "reshape" | "complete" | "remove" | "fix";

export interface SchemaFreezeSourceAssertion {
	readonly path: string;
	readonly contains?: readonly string[];
	readonly excludes?: readonly string[];
}

export type SchemaFreezeLayerEvidence =
	| {
			readonly status: "verified";
			readonly note: string;
			readonly sources: readonly SchemaFreezeSourceAssertion[];
	  }
	| {
			readonly status: "gap";
			readonly reason: string;
	  }
	| {
			readonly status: "not_applicable";
			readonly reason: string;
	  };

export interface SchemaFreezeCapabilityTrace {
	readonly table: string;
	readonly capability: string;
	readonly actions: readonly SchemaFreezeAuditAction[];
	/** Replacement authority for a removed table. */
	readonly replacementTable?: string;
	/** Active table store, or replacement store when this table was removed. */
	readonly retentionStore: `postgres:${string}`;
	readonly schema: SchemaFreezeLayerEvidence;
	readonly runtime: SchemaFreezeLayerEvidence;
	readonly apiSdk: SchemaFreezeLayerEvidence;
	readonly retention: SchemaFreezeLayerEvidence;
	readonly tests: SchemaFreezeLayerEvidence;
}

const DB_SCHEMA = "packages/db/src/schema.ts";
const RETENTION_REGISTRY = "packages/db/src/privacy-retention-registry.ts";
const EXECUTABLE_RETENTION_REGISTRY =
	"packages/db/src/executable-retention-contracts.ts";
const EXECUTABLE_RETENTION_REGISTRY_TEST =
	"packages/db/src/executable-retention-contracts.test.ts";

function source(
	path: string,
	contains: readonly string[] = [],
	excludes: readonly string[] = [],
): SchemaFreezeSourceAssertion {
	return { path, contains, excludes };
}

function verified(
	note: string,
	...sources: readonly SchemaFreezeSourceAssertion[]
): SchemaFreezeLayerEvidence {
	return { status: "verified", note, sources };
}

function schema(
	note: string,
	...contains: readonly string[]
): SchemaFreezeLayerEvidence {
	return verified(note, source(DB_SCHEMA, contains));
}

function retention(note: string): SchemaFreezeLayerEvidence {
	return verified(
		note,
		source(RETENTION_REGISTRY),
		source(EXECUTABLE_RETENTION_REGISTRY, [
			"EXECUTABLE_POSTGRES_RETENTION_CONTRACTS",
		]),
		source(EXECUTABLE_RETENTION_REGISTRY_TEST, [
			"names real exported handlers, executable tests, and scheduled tasks",
			"pins a real supporting index for every executable drain",
		]),
		source("apps/api/src/services/executable-retention.ts", [
			"EXECUTABLE_RETENTION_HANDLERS",
			"validateExecutableRetentionHandlerCoverage",
		]),
		source("apps/api/src/__tests__/executable-retention.test.ts", [
			"has exactly one runtime handler and SQL plan for every owned contract",
		]),
		source("apps/api/src/scheduled/index.ts", [
			'name: "executable_postgres_retention"',
			"runExecutablePostgresRetention(env)",
		]),
	);
}

function testEvidence(
	path: string,
	...contains: readonly string[]
): SchemaFreezeLayerEvidence {
	return verified("Focused executable contract.", source(path, contains));
}

function notApplicable(reason: string): SchemaFreezeLayerEvidence {
	return { status: "not_applicable", reason };
}

export const SCHEMA_FREEZE_CAPABILITY_TRACE: readonly SchemaFreezeCapabilityTrace[] =
	[
		{
			table: "auth.verification",
			capability: "Verification/reset tokens",
			actions: ["reshape"],
			retentionStore: "postgres:auth.verification",
			schema: schema(
				"Expiry and identity-erasure access paths are represented.",
				"verification_value_idx",
				"verification_expires_idx",
			),
			runtime: verified(
				"Expired rows have a total ordered drain and user erasure has a direct locator.",
				source("apps/api/src/services/operational-retention.ts", [
					".delete(verification)",
					"verification.expiresAt",
				]),
				source("apps/app/src/lib/user-deletion.ts", [".delete(verification)"]),
			),
			apiSdk: notApplicable(
				"Verification rows are Better Auth internals; exposing their bearer material through the product API/SDK would be a security defect.",
			),
			retention: verified(
				"Expired bearer rows are never hold-paused and are deleted in bounded ordered daily passes.",
				source(RETENTION_REGISTRY, ["auth.verification"]),
				source("apps/api/src/services/operational-retention.ts", [
					"export async function pruneExpiredAuthState",
					"AUTH_EPHEMERAL_MAX_DELETE_PASSES",
					".orderBy(verification.expiresAt",
				]),
				source("apps/api/src/scheduled/index.ts", [
					'name: "auth_ephemeral_retention"',
					"pruneExpiredAuthState(env)",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/auth-ephemeral-retention.test.ts",
				"has a total bounded expiry drain independent of token reads",
				"removes both user-id and canonical-email capability forms during erasure",
			),
		},
		{
			table: "auth.apikey",
			capability: "API credentials and workspace grants",
			actions: ["reshape"],
			retentionStore: "postgres:auth.apikey",
			schema: schema(
				"Rotating credentials bind to a stable tenant principal.",
				'principalId: text("principalId").notNull()',
				"apikey_principal_org_fk",
				"principal_workspace_grants",
			),
			runtime: verified(
				"Authorization resolves principal lifecycle and grants rather than key-local workspace lists.",
				source("apps/api/src/middleware/auth.ts", [
					"organizationPrincipals",
					"principalWorkspaceGrants",
				]),
			),
			apiSdk: verified(
				"API-key lifecycle remains a public API/SDK capability.",
				source("apps/api/src/routes/api-keys.ts", ["principalId"]),
				source("packages/sdk/src/resources/api-keys.ts", ["/v1/api-keys"]),
			),
			retention: retention("Credential material is never hold-paused."),
			tests: testEvidence(
				"packages/db/src/organization-principals-contract.test.ts",
				"organization authority uses tenant-safe principal and workspace grant FKs",
			),
		},
		{
			table: "auth.member",
			capability: "Organization membership/roles",
			actions: ["reshape"],
			retentionStore: "postgres:auth.member",
			schema: schema(
				"Membership has a stable principal projection and closed role/grant tuples.",
				"organization_principals",
				"organization_principals_member_org_fk",
				"principal_workspace_grants",
			),
			runtime: verified(
				"Bearer redemption creates/upgrades the member, principal, and grants atomically.",
				source("apps/api/src/routes/invite-redeem.ts", [
					"tx.insert(member)",
					"organizationPrincipals",
					"principalWorkspaceGrants",
				]),
			),
			apiSdk: verified(
				"Owner bearer invites expose the supported membership creation path.",
				source("apps/api/src/routes/invite-redeem.ts", [
					"creates or upgrades membership",
				]),
				source("packages/sdk/src/resources/invite-tokens.ts", [
					"upgrades membership",
				]),
			),
			retention: retention(
				"Member/principal authority follows typed identity erasure.",
			),
			tests: testEvidence(
				"packages/db/src/organization-principals-contract.test.ts",
				"organization authority uses tenant-safe principal and workspace grant FKs",
			),
		},
		{
			table: "public.invite_tokens",
			capability: "Shareable single-use API bearer invitations",
			actions: ["reshape", "complete"],
			retentionStore: "postgres:public.invite_tokens",
			schema: schema(
				"Bearer authority has normalized grants and constrained consumption.",
				"invite_token_workspaces",
				"invite_tokens_consumption_tuple_check",
				"invite_tokens_expiry_window_check",
			),
			runtime: verified(
				"Redeem locks, validates, consumes, and projects grants in one transaction.",
				source("apps/api/src/routes/invite-redeem.ts", [
					'.for("update")',
					".update(inviteTokens)",
					"principalWorkspaceGrants",
				]),
			),
			apiSdk: verified(
				"Mint/list/revoke/redeem are present in both API and SDK.",
				source("apps/api/src/routes/invite.ts", [
					'operationId: "createInviteToken"',
				]),
				source("packages/sdk/src/resources/invite-tokens.ts", [
					"/v1/invite/tokens/redeem",
				]),
			),
			retention: retention(
				"Usable token material is minimized and never hold-extended.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/invite-token-authority.test.ts",
				"redemption contains the body before its atomic authority changes",
			),
		},
		{
			table: "public.account_revocation_jobs",
			capability: "Provider-side account disconnect",
			actions: ["reshape"],
			retentionStore: "postgres:public.account_revocation_jobs",
			schema: schema(
				"Revocation has a fenced lease, request boundary, and terminal shred clock.",
				'leaseToken: integer("lease_token")',
				"requestMayHaveBeenSentAt",
				"account_revocation_jobs_terminal_redaction_check",
			),
			runtime: verified(
				"Revocation retry and terminal policy use the persisted fence.",
				source("apps/api/src/services/account-revocation.ts", [
					"leaseToken",
					"requestMayHaveBeenSentAt",
				]),
			),
			apiSdk: verified(
				"Account deletion/disconnect remains represented by account API/SDK methods.",
				source("apps/api/src/routes/accounts.ts", [
					"deleteConnectedAccountGraph",
					'operationId: "disconnectAccount"',
				]),
				source("packages/sdk/src/resources/accounts/accounts.ts", [
					"/v1/accounts/",
				]),
			),
			retention: retention("Credential grant shreds on its ordinary clock."),
			tests: testEvidence(
				"apps/api/src/__tests__/account-revocation-policy.test.ts",
				"has an explicit lease token and provider request boundary",
			),
		},
		{
			table: "public.media",
			capability: "Media metadata and object ownership",
			actions: ["reshape"],
			retentionStore: "postgres:public.media",
			schema: schema(
				"Every original and durable thumbnail pins its complete physical locator; BYOS additionally pins the immutable location and credential version.",
				'storageProvider: storageProviderEnum("storage_provider")',
				'storageBucketLocator: text("storage_bucket_locator").notNull()',
				'storageRegion: text("storage_region").notNull()',
				'storageLocationId: text("storage_location_id")',
				'storageCredentialVersion: integer("storage_credential_version")',
				'"thumbnail_storage_bucket_locator"',
				'"thumbnail_storage_region"',
				"media_storage_locator_check",
				"media_thumbnail_storage_locator_check",
				'uniqueIndex("media_storage_key_uniq")',
			),
			runtime: verified(
				"Creation persists the selected topology and all lifecycle reads/deletes reconstruct typed original and thumbnail locators from the row.",
				source("apps/api/src/services/storage-locator.ts", [
					"storageLocatorForMedia",
					"storageLocatorForThumbnailObject",
					"row.storageBucketLocator",
					"row.storageRegion",
				]),
				source("apps/api/src/routes/media.ts", [
					"storageBucketLocator: storageTarget.bucket",
					"storageRegion: storageTarget.region",
					"storageLocatorForMedia",
				]),
				source("apps/api/src/services/media-reliability.ts", [
					"deleteStoredObject",
					"storageLocatorForMedia(row)",
					"result.storage.bucket",
				]),
			),
			apiSdk: verified(
				"Media CRUD remains present in API and SDK.",
				source("apps/api/src/routes/media.ts", ['operationId: "uploadMedia"']),
				source("packages/sdk/src/resources/media.ts", ["/v1/media"]),
			),
			retention: verified(
				"Entity-lifetime metadata retains its exact locator; explicit deletion and erasure delete the correctly routed physical object before row removal.",
				source(RETENTION_REGISTRY, ["public.media"]),
				source("apps/api/src/services/workspace-erasure.ts", [
					"deleteStoredObject",
					"storageLocatorForMedia",
					"storageLocatorForThumbnailObject",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/byos-optimality.test.ts",
				"pins an exact tenant-safe location and credential version on every BYOS media row",
				"routes every media lifecycle boundary through the shared locator",
			),
		},
		{
			table: "public.webhook_logs",
			capability: "Customer-visible per-HTTP-attempt history",
			actions: ["reshape"],
			retentionStore: "postgres:public.webhook_logs",
			schema: schema(
				"Test sends and durable retries share one exact-attempt model with parent-safe delivery identity.",
				'deliveryId: text("delivery_id")',
				'attemptOrdinal: integer("attempt_ordinal").notNull()',
				"webhook_logs_attempt_identity_check",
				"webhook_logs_delivery_attempt_uniq",
			),
			runtime: verified(
				"Both send paths persist kind, ordinal, and outcome; the public response derives its legacy success flag.",
				source("apps/api/src/routes/webhooks.ts", [
					'attemptKind: "test"',
					"attemptOrdinal: 1",
					"success: l.outcome ===",
				]),
				source("apps/api/src/services/webhook-delivery.ts", [
					'attemptKind: "delivery"',
					"const attemptOrdinal = delivery.attempts + 1",
					'outcome: "unknown"',
				]),
			),
			apiSdk: verified(
				"Customer-visible log listing remains available.",
				source("apps/api/src/routes/webhooks.ts", [
					'operationId: "getWebhookLogs"',
				]),
				source("packages/sdk/src/resources/webhooks.ts", ["/v1/webhooks/logs"]),
			),
			retention: retention("Webhook attempt history is bounded to seven days."),
			tests: testEvidence(
				"apps/api/src/__tests__/schema-construction-optimality.test.ts",
				"writes explicit test and durable delivery attempt identities",
				"exposes the exact typed webhook attempt",
			),
		},
		{
			table: "public.post_analytics",
			capability: "Historical post-metric observations",
			actions: ["reshape"],
			retentionStore: "postgres:public.post_analytics",
			schema: schema(
				"Observation identity is deterministic per target/window.",
				"observation_window_start",
				"post_analytics_target_window_uniq",
			),
			runtime: verified(
				"One producer records cumulative snapshots and readers derive interval deltas.",
				source("apps/api/src/lib/analytics-observations.ts", [
					"cumulativeSnapshotsToDecay",
					"cumulativeTimelineByDay",
				]),
				source("apps/api/src/services/analytics-refresh.ts", [
					"analyticsObservationWindowStart",
					".insert(postAnalytics)",
				]),
			),
			apiSdk: verified(
				"Timeline and analytics readers are represented in API and SDK.",
				source("apps/api/src/routes/analytics.ts", ["post-timeline"]),
				source("packages/sdk/src/resources/analytics/analytics.ts", [
					"/v1/analytics/post-timeline",
				]),
			),
			retention: retention("Historical observations have a 25-month bound."),
			tests: testEvidence(
				"apps/api/src/__tests__/analytics-observation-durability.test.ts",
				"uses a deterministic five-minute observation identity",
			),
		},
		{
			table: "public.queue_failures",
			capability: "Replayable failed-message ledger",
			actions: ["reshape"],
			retentionStore: "postgres:public.queue_failures",
			schema: schema(
				"Replay bodies are context-bound ciphertext with typed subject locators, explicit redaction state, and non-renewable 30/90-day clocks.",
				'payloadCiphertext: text("payload_ciphertext")',
				'payloadExpiresAt: timestamp("payload_expires_at"',
				'purgeAt: timestamp("purge_at"',
				'workspaceIds: text("workspace_ids")',
				'contactIds: text("contact_ids")',
				"queue_failures_payload_lifecycle_check",
				"queue_failures_retention_clock_check",
			),
			runtime: verified(
				"Writers encrypt with stable context, remove inactive tenant scope, never resurrect redacted payloads, and replay decrypts only within the recorded scope.",
				source("apps/api/src/queues/failures.ts", [
					"encryptQueueFailurePayload",
					"queueFailurePayloadContext",
					"inactive_tenant_scope_removed",
					`LEAST(\${queueFailures.payloadExpiresAt}, excluded.payload_expires_at)`,
					`WHEN \${queueFailures.payloadRedactedAt} IS NOT NULL`,
				]),
				source("apps/api/src/services/queue-replay.ts", [
					"queueFailures.organizationIds",
					"decryptQueueFailurePayload",
				]),
			),
			apiSdk: notApplicable(
				"Queue-failure replay is an operator-only recovery surface and is intentionally absent from the customer SDK.",
			),
			retention: verified(
				"Daily bounded passes shred payloads at 30 days and delete minimized receipts at 90 days, with holds applying only to the minimized receipt.",
				source("apps/api/src/services/operational-retention.ts", [
					"export async function retainQueueFailures",
					"QUEUE_FAILURE_RETENTION_MAX_PASSES",
					"queueFailures.payloadExpiresAt",
					"queueFailures.purgeAt",
					"hold.released_at IS NULL",
				]),
				source("apps/api/src/scheduled/index.ts", [
					'name: "queue_failure_retention"',
					"retainQueueFailures(env)",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/queue-failure-lifecycle.test.ts",
				"retains a scoped failure while its organization is active",
				"has typed subject locators and hard payload/receipt clocks",
				"redacts and drains in bounded pages without allowing redelivery to renew privacy clocks",
			),
		},
		{
			table: "public.email_deliveries",
			capability: "Idempotent transactional email state",
			actions: ["reshape"],
			retentionStore: "postgres:public.email_deliveries",
			schema: schema(
				"Email work is tenant/subject located with encrypted envelope and drain clocks.",
				"envelope_ciphertext",
				"subject_user_id",
				"email_deliveries_envelope_lifecycle_check",
			),
			runtime: verified(
				"Producer persists before queue dispatch; consumer crosses a fenced provider boundary.",
				source("apps/api/src/lib/email-queue/producer.ts", [
					".insert(emailDeliveries)",
					"dispatchEmailDelivery",
				]),
				source("apps/api/src/queues/email.ts", [
					"requestMayHaveBeenSentAt",
					"leaseToken",
				]),
			),
			apiSdk: notApplicable(
				"Transactional email is an internal side effect of product workflows, not a customer-managed API resource.",
			),
			retention: retention(
				"Envelope redacts at 30 days and the receipt purges at 90 days.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/email-durability-optimality.test.ts",
				"keeps personal email content out of Cloudflare Queue",
			),
		},
		{
			table: "public.stripe_events",
			capability: "Stripe webhook replay/processing ledger",
			actions: ["reshape"],
			retentionStore: "postgres:public.stripe_events",
			schema: schema(
				"Stripe receipts have ordered due eligibility, error class, lease, and manual-review clocks.",
				"next_attempt_at",
				"manual_review_at",
				"stripe_events_error_class_check",
			),
			runtime: verified(
				"Webhook handling claims due work, applies backoff, and terminalizes manual review.",
				source("apps/api/src/routes/stripe-webhooks.ts", [
					"nextAttemptAt",
					"manualReviewAt",
					"manual_review",
				]),
			),
			apiSdk: notApplicable(
				"Stripe posts this signed provider webhook; it is not a customer SDK operation.",
			),
			retention: verified(
				"Successful payload is immediately redacted; 90-day operational rows become a one-year global digest receipt, with tenant evidence only from deterministic current billing state.",
				source(RETENTION_REGISTRY, [
					"public.financial_retention_receipts",
					"global SHA-256 Stripe receipts one year",
				]),
				source("apps/api/src/services/financial-retention.ts", [
					"stripeAttributionByCurrentBillingState",
					"stripe_event_global",
					"payload: sql`'{}'::jsonb`",
				]),
				source("apps/api/src/scheduled/index.ts", [
					'name: "financial_retention"',
				]),
				source("apps/api/src/__tests__/financial-retention.test.ts", [
					"keeps every horizon and maintenance loop explicitly bounded",
				]),
				source("packages/db/src/executable-retention-contracts.ts", [
					"FINANCIAL_POSTGRES_RETENTION_CONTRACTS",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/financial-retention.test.ts",
				"never infers Stripe tenant ownership from payload or object IDs",
			),
		},
		{
			table: "public.usage_records",
			capability: "Legacy admin usage projection",
			actions: ["remove"],
			replacementTable: "public.usage_buckets",
			retentionStore: "postgres:public.usage_buckets",
			schema: verified(
				"Legacy projection is absent; the bucket snapshots included units.",
				source(
					DB_SCHEMA,
					["includedUnits", '"usage_buckets"'],
					['"usage_records"'],
				),
			),
			runtime: verified(
				"Metering, billing reads, and invoice settlement use the canonical bucket.",
				source(
					"apps/api/src/services/usage-meter.ts",
					["usageBuckets"],
					["usageRecords"],
				),
				source(
					"apps/api/src/routes/usage.ts",
					["usageBuckets"],
					["usageRecords"],
				),
			),
			apiSdk: verified(
				"Usage reads survive through the bucket-backed API without exposing storage shape.",
				source("apps/api/src/routes/usage.ts", ["usageBuckets"]),
				source("packages/sdk/src/resources/usage.ts", ["/v1/usage"]),
			),
			retention: verified(
				"Usage detail drains after 25 months; tenant erasure first materializes its aggregate receipt.",
				source(RETENTION_REGISTRY, [
					"usage detail 25 months",
					"public.financial_retention_receipts",
				]),
				source("apps/api/src/services/financial-retention.ts", [
					"FINANCIAL_USAGE_DETAIL_RETENTION_MONTHS",
					"pruneExpiredUsageDetail",
				]),
				source("apps/api/src/scheduled/index.ts", [
					'name: "financial_retention"',
				]),
				source("apps/api/src/__tests__/financial-retention.test.ts", [
					"keeps every horizon and maintenance loop explicitly bounded",
				]),
				source("packages/db/src/executable-retention-contracts.ts", [
					"FINANCIAL_POSTGRES_RETENTION_CONTRACTS",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/usage-tracking.test.ts",
				"usage",
			),
		},
		{
			table: "public.byos_configs",
			capability: "Customer-owned object storage configuration",
			actions: ["remove", "reshape"],
			replacementTable: "public.storage_locations",
			retentionStore: "postgres:public.storage_locations",
			schema: verified(
				"The mutable singleton is absent; immutable routing and versioned credentials construction-enforce the replacement.",
				source(
					DB_SCHEMA,
					[
						"export const storageLocations = pgTable(",
						"export const storageCredentials = pgTable(",
						"media_storage_location_org_locator_fk",
						"media_storage_credential_org_version_fk",
					],
					['"byos_configs"'],
				),
			),
			runtime: verified(
				"Shared object operations resolve the exact historical location and credential version pinned to media.",
				source("apps/api/src/services/storage-locator.ts", [
					"storageLocatorForMedia",
					"loadPinnedByosAuthority",
					"PINNED_BYOS_CREDENTIAL_STATES",
					"nextByosCleanupLocator",
				]),
				source("apps/api/src/services/byos-configuration.ts", [
					"stageByosConfiguration",
					"testAndActivateStagedByosConfiguration",
				]),
			),
			apiSdk: verified(
				"The same configuration, probe, object-routing, and removal capability survives through API and SDK.",
				source("apps/api/src/routes/byos.ts", ['operationId: "putByosConfig"']),
				source("packages/sdk/src/resources/byos.ts", [
					"/v1/byos",
					"credential_version",
				]),
			),
			retention: verified(
				"Tenant cleanup walks every exact historical authority before media, credential, and location rows are deleted child-first.",
				source(RETENTION_REGISTRY, [
					"public.storage_locations",
					"public.storage_credentials",
				]),
				source("apps/api/src/services/tenant-deletion.ts", [
					"nextByosCleanupLocator",
					'tenantPurgeTable("public", "storage_credentials")',
					'tenantPurgeTable("public", "storage_locations")',
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/byos-optimality.test.ts",
				"fails a bad rotation without retiring the prior active authority",
				"tenant cleanup walks exact historical credentials",
			),
		},
		{
			table: "public.storage_locations",
			capability: "Immutable customer-owned object routing",
			actions: ["complete", "reshape"],
			retentionStore: "postgres:public.storage_locations",
			schema: verified(
				"Location definitions are immutable, topology changes append, and media has exact tenant-safe locator foreign keys.",
				source(DB_SCHEMA, [
					"storage_locations_media_locator_uniq",
					"media_storage_location_org_locator_fk",
				]),
				source("packages/db/scripts/render-storage-location-invariant-sql.ts", [
					"storage location routing fields are immutable; insert a new location",
					"retired storage locations are terminal",
				]),
			),
			runtime: verified(
				"Staging inserts a changed location and activation retires the prior location rather than overwriting its route.",
				source("apps/api/src/services/byos-configuration.ts", [
					".insert(storageLocations)",
					"oldActive.locationId !== candidate.locationId",
				]),
			),
			apiSdk: verified(
				"The redacted location definition and immutable identity are exposed on the existing BYOS surface.",
				source("apps/api/src/routes/byos.ts", [
					"location_id: location.id",
					'operationId: "putByosConfig"',
				]),
				source("packages/sdk/src/resources/byos.ts", ["location_id: string"]),
			),
			retention: verified(
				"Locations remain while pinned media or cleanup needs their routing definition and are deleted after the tenant prefix drains.",
				source(RETENTION_REGISTRY, ["public.storage_locations"]),
				source("apps/api/src/services/tenant-deletion.ts", [
					'tenantPurgeTable("public", "storage_locations")',
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/byos-optimality.test.ts",
				"inserts location changes and tenant cleanup walks exact historical credentials",
			),
		},
		{
			table: "public.storage_credentials",
			capability: "Fenced customer-owned storage credential rotation",
			actions: ["complete", "reshape"],
			retentionStore: "postgres:public.storage_credentials",
			schema: verified(
				"Credential identity is append-only and only fenced staged, active, failed, and retired lifecycle transitions are legal.",
				source(DB_SCHEMA, [
					"storage_credentials_location_org_version_uniq",
					"storage_credentials_org_active_uniq",
					"storage_credentials_org_staged_uniq",
				]),
				source("packages/db/scripts/render-storage-location-invariant-sql.ts", [
					"storage credential identity is immutable; insert a new version",
					"OLD.state = 'staged' AND NEW.state IN ('active', 'failed')",
					"OLD.state = 'active' AND NEW.state = 'retired'",
				]),
			),
			runtime: verified(
				"A tenant lock and exact probe token serialize rotation; failed probes terminalize only the candidate, while success atomically retires the prior active version.",
				source("apps/api/src/services/byos-configuration.ts", [
					"pg_advisory_xact_lock",
					"claimStagedCredential",
					"failStagedCredential",
					"activateStagedCredential",
				]),
			),
			apiSdk: verified(
				"Credential material remains write-only while version and redacted lifecycle state are available through API and SDK.",
				source("apps/api/src/routes/byos.ts", [
					"credential_id: credential.id",
					"credentials_present: true",
				]),
				source("packages/sdk/src/resources/byos.ts", [
					"credential_id: string",
					"credential_version: number",
				]),
			),
			retention: verified(
				"Encrypted versions survive only for pinned objects or unresolved cleanup and are deleted child-first after provider cleanup.",
				source(RETENTION_REGISTRY, ["public.storage_credentials"]),
				source("apps/api/src/services/tenant-deletion.ts", [
					'tenantPurgeTable("public", "storage_credentials")',
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/byos-optimality.test.ts",
				"keeps retired authorities readable",
				"serializes concurrent stages",
				"fails a bad rotation",
			),
		},
		{
			table: "public.usage_bucket_settlements",
			capability: "Idempotent usage settlement",
			actions: ["remove", "reshape"],
			replacementTable: "public.billing_periods",
			retentionStore: "postgres:public.billing_periods",
			schema: verified(
				"The settlement satellite is absent; period state and one operation per period own the same fence.",
				source(
					DB_SCHEMA,
					[
						"export const billingPeriods = pgTable(",
						'billingPeriodId: text("billing_period_id")',
						".unique()",
					],
					['"usage_bucket_settlements"'],
				),
			),
			runtime: verified(
				"Period claiming snapshots usage once and derives a stable Stripe idempotency key from the period.",
				source(
					"apps/api/src/services/invoice-generator.ts",
					['state: "claimed"', "const idempotencyKey = `relayapi:overage:"],
					["usageBucketSettlements"],
				),
				source("apps/api/src/routes/stripe-webhooks.ts", [
					"reconcileInvoiceBillingPeriods",
					'state: "settled"',
				]),
			),
			apiSdk: notApplicable(
				"Settlement is internal provider-boundary state; the retained invoice and usage capabilities remain the supported API/SDK surfaces.",
			),
			retention: verified(
				"Billing periods retain aggregate evidence only after their child operations and usage detail have drained.",
				source(RETENTION_REGISTRY, ["public.billing_periods"]),
				source("apps/api/src/services/financial-retention.ts", [
					"pruneBillingPeriods",
					"billing_period_id",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/billing-periods.test.ts",
				"keeps period splitting transactional",
				"preserves final settlement eligibility",
			),
		},
		{
			table: "public.billing_periods",
			capability:
				"Authoritative entitlement, quota, price, and settlement window",
			actions: ["complete", "reshape"],
			retentionStore: "postgres:public.billing_periods",
			schema: verified(
				"Exact windows, quota/billing shape, USD price evidence, non-overlap, and transition immutability are enforced.",
				source(DB_SCHEMA, [
					"billing_periods_id_org_window_uniq",
					"billing_periods_quota_shape_check",
					"billing_periods_currency_check",
				]),
				source("packages/db/scripts/render-billing-period-invariant-sql.ts", [
					"usage_buckets_billing_period_window_fk",
					"billing_periods_live_window_excl",
					"billing period authority fields are immutable",
				]),
			),
			runtime: verified(
				"Entitlement changes split a locked period, carry forward remaining cycle allowance, and leave cancellation windows settleable.",
				source("apps/api/src/services/billing-periods.ts", [
					"remainingCycleAllowance",
					"splitBillingPeriod",
					"shortenOpenBillingPeriod",
				]),
				source("apps/api/src/services/invoice-generator.ts", [
					"billingPeriods",
					'state: "claimed"',
				]),
			),
			apiSdk: verified(
				"Usage exposes quota shape and lossless decimal counters without leaking the provider settlement machine.",
				source("apps/api/src/routes/usage.ts", [
					"quota_mode",
					"included_units",
				]),
				source("packages/sdk/src/resources/usage.ts", [
					"quota_mode: 'hard' | 'metered' | 'unlimited'",
					"included_units: string | null",
				]),
			),
			retention: verified(
				"Period aggregates use the explicit 25-month usage-detail horizon and a bounded child-first drain.",
				source(RETENTION_REGISTRY, ["public.billing_periods"]),
				source("apps/api/src/services/financial-retention.ts", [
					"FINANCIAL_USAGE_DETAIL_RETENTION_MONTHS",
					"pruneBillingPeriods",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/billing-periods.test.ts",
				"grants only the unconsumed cycle allowance to a successor",
				"keeps period splitting transactional",
			),
		},
		{
			table: "public.billing_operations",
			capability: "Serialized billing mutations",
			actions: ["reshape"],
			retentionStore: "postgres:public.billing_operations",
			schema: schema(
				"Billing mutation due time, lease, attempts, error class, and manual state are explicit.",
				"billing_operations_status_due_idx",
				"billing_operations_error_class_check",
				"manualReviewAt",
			),
			runtime: verified(
				"Reconciliation uses stored due time and bounded automatic attempts.",
				source("apps/api/src/services/billing-operations.ts", [
					"nextAttemptAt",
					"manual_review",
					"BILLING_OPERATION_MAX_ATTEMPTS",
				]),
			),
			apiSdk: verified(
				"Billing mutations and current state are API-owned and SDK-backed.",
				source("apps/api/src/routes/billing.ts", [
					'operationId: "getBillingStatus"',
				]),
				source("packages/sdk/src/resources/billing.ts", ["/v1/billing"]),
			),
			retention: verified(
				"Operational detail drains at 90 days only after a normalized seven-year receipt is written in the same transaction.",
				source(RETENTION_REGISTRY, [
					"Operational payload, provider identifiers",
					"public.financial_retention_receipts",
				]),
				source("apps/api/src/services/financial-retention.ts", [
					"pruneBillingOperations",
					"writeReceiptCandidates",
					"financial_7_years",
				]),
				source("apps/api/src/scheduled/index.ts", [
					'name: "financial_retention"',
				]),
				source("apps/api/src/__tests__/financial-retention.test.ts", [
					"keeps every horizon and maintenance loop explicitly bounded",
				]),
				source("packages/db/src/executable-retention-contracts.ts", [
					"FINANCIAL_POSTGRES_RETENTION_CONTRACTS",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/financial-retention.test.ts",
				"runs the receipt snapshot before every operational billing purge",
			),
		},
		{
			table: "public.user_preferences",
			capability: "User timezone/language preferences",
			actions: ["complete"],
			retentionStore: "postgres:public.user_preferences",
			schema: schema(
				"One user-owned preference row stores timezone and language.",
				"export const userPreferences",
				'timezone: text("timezone")',
				'language: text("language")',
				"user_preferences_timezone_shape_check",
				"user_preferences_language_check",
			),
			runtime: verified(
				"The authenticated app validates/upserts both fields; timezone drives calendar rendering and language updates every dashboard document.",
				source("apps/app/src/pages/api/user-preferences.ts", [
					"isValidTimezone",
					"VALID_LANGUAGES.has",
					"target: userPreferences.userId",
				]),
				source("apps/app/src/hooks/use-timezone.ts", [
					'fetch("/api/user-preferences")',
					"localStorage.setItem(CACHE_KEY",
				]),
				source("apps/app/src/hooks/use-user-language.ts", [
					"document.documentElement.lang = language",
					'fetch("/api/user-preferences")',
				]),
				source("apps/app/src/components/dashboard/dashboard-shell.tsx", [
					"useUserLanguage()",
				]),
			),
			apiSdk: notApplicable(
				"Preferences are user-local authenticated dashboard state, intentionally served by the app rather than the organization API/SDK.",
			),
			retention: verified(
				"Preferences are never held and the user foreign key cascades them with the canonical identity.",
				source(DB_SCHEMA, [
					"export const userPreferences",
					'.references(() => user.id, { onDelete: "cascade" })',
				]),
				source(RETENTION_REGISTRY, ["public.user_preferences"]),
			),
			tests: testEvidence(
				"apps/app/src/lib/user-preferences.test.ts",
				"validates and atomically upserts both preference dimensions",
				"offers language in profile and applies it to every dashboard document",
			),
		},
		{
			table: "public.inbound_webhook_events",
			capability: "Shared inbound provider receipt",
			actions: ["reshape"],
			retentionStore: "postgres:public.inbound_webhook_events",
			schema: schema(
				"Shared receipt stores encrypted payload, owner array, bounded clocks, and redaction state.",
				"payload_ciphertext",
				"organization_ids",
				"inbound_webhook_events_retention_check",
			),
			runtime: verified(
				"Tenant deletion removes one owner or minimizes the last/shared payload.",
				source("apps/api/src/services/tenant-deletion.ts", [
					"processSharedReceiptBatch",
					"inbound_webhook_events",
				]),
				source("apps/api/src/services/inbound-webhook-acceptance.ts", [
					"acceptInboundWebhook",
					"payloadCiphertext",
				]),
			),
			apiSdk: notApplicable(
				"This is an internal signed-provider ingress receipt, not a customer resource.",
			),
			retention: retention(
				"Complete/failed/manual payload clocks are bounded and shared-owner aware.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/inbound-webhook-durability.test.ts",
				"persists only context-bound ciphertext with a bounded unresolved TTL",
			),
		},
		{
			table: "public.whatsapp_phone_numbers",
			capability: "Phone resource plus provisioning/release",
			actions: ["reshape"],
			retentionStore: "postgres:public.whatsapp_phone_numbers",
			schema: schema(
				"The durable phone entity is lean; provisioning and release are independent one-per-phone operation tables with canonical fences.",
				"export const whatsappPhoneProvisioningOperations",
				"export const whatsappPhoneReleaseOperations",
				"wa_phone_provisioning_detail_retention_check",
				"wa_phone_release_completion_check",
			),
			runtime: verified(
				"Provider claims, boundaries, recovery, and terminal transitions mutate the typed operation rows while parent results update transactionally.",
				source("apps/api/src/services/phone-number-operations.ts", [
					".update(whatsappPhoneProvisioningOperations)",
					".update(whatsappPhoneReleaseOperations)",
					"releaseSourceAccountId: null",
					"provisioningVerifiedName: null",
				]),
			),
			apiSdk: verified(
				"Purchase, verification, listing, and release capability remains available.",
				source("apps/api/src/routes/whatsapp-phone-provisioning.ts", [
					"Purchase a US phone number",
					"Release a phone number",
				]),
				source("packages/sdk/src/resources/whatsapp/phone-numbers.ts", [
					"/v1/whatsapp/phone-numbers",
				]),
			),
			retention: verified(
				"Operation rows have independent policies; terminal provisioning retains checkout recovery for at most seven days, minimizes remaining evidence at one year, and completed release evidence drains after one year while copied credentials still shred immediately.",
				source(RETENTION_REGISTRY, [
					"public.whatsapp_phone_release_operations",
					"public.whatsapp_phone_provisioning_operations",
				]),
				source("apps/api/src/services/phone-number-operations.ts", [
					"PROVISIONING_DETAIL_RETENTION_MS = 7 * 24 * 60 * 60_000",
					"export async function redactExpiredPhoneProvisioningDetails",
					"PHONE_PROVISIONING_DETAIL_REDACTION_MAX_PASSES",
					"stripeCheckoutUrl: null",
					"releaseSourceTokenVersion: null",
					"releaseAccessTokenCiphertext: null",
				]),
				source("apps/api/src/services/timed-domain-retention.ts", [
					"export async function retainTerminalPhoneProvisioningEvidence",
					"export async function retainTerminalPhoneReleaseEvidence",
					"interval '1 year'",
				]),
				source("apps/api/src/scheduled/index.ts", [
					'name: "timed_domain_retention"',
					"retainTimedDomainData(env)",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/phone-operation-shape.test.ts",
				"keeps the durable phone entity free of retry-machine columns",
				"models provisioning and release as independent one-per-phone lifecycles",
				"stores only the minimal durable provisioning source and shreds terminal detail",
			),
		},
		{
			table: "public.custom_field_definitions",
			capability: "Tenant-defined contact schema",
			actions: ["reshape"],
			retentionStore: "postgres:public.custom_field_definitions",
			schema: schema(
				"PostgreSQL requires a non-empty string array exactly for select fields.",
				"custom_field_definitions_options_by_type_check",
				"jsonb_array_length",
				"jsonb_path_exists",
			),
			runtime: verified(
				"Create validation and PATCH both enforce options against the immutable stored type.",
				source("apps/api/src/schemas/custom-fields.ts", [
					"Options are required for select type",
					"Options are allowed only for select type",
				]),
				source("apps/api/src/routes/custom-fields.ts", [
					"type: customFieldDefinitions.type",
					"Options are allowed only for select fields",
				]),
			),
			apiSdk: verified(
				"Custom-field definition CRUD remains in API and SDK.",
				source("apps/api/src/routes/custom-fields.ts", ["CreateFieldBody"]),
				source("packages/sdk/src/resources/custom-fields.ts", [
					"/v1/custom-fields",
				]),
			),
			retention: retention("Definitions follow tenant/entity lifetime."),
			tests: testEvidence(
				"apps/api/src/__tests__/schema-construction-optimality.test.ts",
				"accepts custom-field options exactly when the immutable type is select",
				"enforces immutable custom-field type on PATCH",
			),
		},
		{
			table: "public.contacts",
			capability: "Canonical contact identity/profile",
			actions: ["reshape"],
			retentionStore: "postgres:public.contacts",
			schema: schema(
				"Display phone is encrypted while checked, scope-unique E.164 identity is a tenant-keyed blind hash.",
				'phoneCiphertext: text("phone_ciphertext")',
				'phoneHash: text("phone_hash")',
				"contacts_scope_phone_hash_uniq",
				"contacts_phone_protected_tuple_check",
			),
			runtime: verified(
				"All contact writers/linkers/search paths share one normalizer and protected equality/search authority.",
				source("apps/api/src/lib/contact-phone.ts", [
					"normalizeContactPhone",
					"parsePhoneNumberFromString",
				]),
				source("apps/api/src/services/contact-protection.ts", [
					"deriveContactPhoneHash",
					"deriveContactSearchQuery",
				]),
				source("apps/api/src/routes/contacts.ts", ["contacts.phoneHash"]),
			),
			apiSdk: verified(
				"Contact create/update/bulk/list remains API/SDK-backed.",
				source("apps/api/src/routes/contacts.ts", [
					'operationId: "createContact"',
					"protectContactValues",
				]),
				source("packages/sdk/src/resources/contacts.ts", ["/v1/contacts"]),
			),
			retention: retention(
				"Contact identity follows contact/tenant erasure policy.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/contact-phone-canonical.test.ts",
				"normalizes equivalent international presentation formats to E.164",
			),
		},
		{
			table: "public.contact_consent_events",
			capability: "Ordered consent evidence",
			actions: ["reshape"],
			retentionStore: "postgres:public.contact_consent_events",
			schema: schema(
				"Consent evidence has canonical dimensions, a mergeable HLC tuple, versioned hashes, and redaction fields.",
				"ordering_hlc",
				"ordering_region",
				"logical_identifier_hash",
				"identifier_key_version",
				"contact_consent_events_projection_source_uniq",
			),
			runtime: verified(
				"One consent service creates ordered evidence and supports fenced key rotation.",
				source("apps/api/src/services/contact-consent.ts", [
					"logicalIdentifierHash",
					"identifierKeyVersion",
				]),
			),
			apiSdk: verified(
				"Consent record/list operations remain attached to contact API/SDK.",
				source("apps/api/src/routes/contacts.ts", ["recordContactConsent"]),
				source("packages/sdk/src/resources/contacts.ts", ["consent"]),
			),
			retention: retention(
				"Superseded evidence is redacted, not treated as permanent raw PII.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/consent-identity-rotation.test.ts",
				"allocates a monotonic physical/logical tuple in the home region",
				"canonicalizes dimensions and domain-separates stable identity by organization",
			),
		},
		{
			table: "public.contact_consent_states",
			capability: "Current grant/denial authority",
			actions: ["reshape"],
			retentionStore: "postgres:public.contact_consent_states",
			schema: schema(
				"Current authority keys canonical logical identity and tracks the source HLC/version.",
				"contact_consent_states_identifier_idx",
				"contact_consent_states_versioned_identifier_idx",
				"lastOrderingHlc",
				"lastOrderingRegion",
			),
			runtime: verified(
				"Every send path consults the same state and rotation rewrites with CAS fencing.",
				source("apps/api/src/services/contact-consent.ts", [
					"getAllowedRecipientHashes",
					"rotateContactConsentAuthority",
				]),
				source("apps/api/src/lib/consent-hmac.ts", [
					"deriveConsentLookupHashFromLogical",
					"activeVersion",
				]),
			),
			apiSdk: verified(
				"State is deliberately not mutable directly; contact consent API writes immutable evidence which atomically projects it.",
				source("apps/api/src/routes/contacts.ts", [
					"recordContactConsentInTransaction",
				]),
				source("packages/sdk/src/resources/contacts.ts", ["recordConsent"]),
			),
			retention: retention(
				"Grant follows contact lifetime; minimized denial survives until explicit grant/tenant deletion.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/consent-identity-rotation.test.ts",
				"preserves deny -> rotate -> reimport as an absolute veto",
			),
		},
		{
			table: "public.contact_suppressions",
			capability: "Duplicate absolute opt-out veto",
			actions: ["remove"],
			replacementTable: "public.contact_consent_states",
			retentionStore: "postgres:public.contact_consent_states",
			schema: verified(
				"Duplicate table is absent; denied consent state is the sole veto authority.",
				source(
					DB_SCHEMA,
					["contactConsentStates"],
					["contactSuppressions", '"contact_suppressions"'],
				),
			),
			runtime: verified(
				"Authorization queries canonical denied consent state in central and broadcast paths.",
				source("apps/api/src/services/contact-consent.ts", [
					"contactConsentStates",
				]),
				source("apps/api/src/services/broadcast-processor.ts", [
					"getAllowedRecipientHashes",
				]),
			),
			apiSdk: verified(
				"Existing consent API/SDK preserves opt-out capability without exposing duplicate storage.",
				source("apps/api/src/routes/contacts.ts", ["recordContactConsent"]),
				source("packages/sdk/src/resources/contacts.ts", ["recordConsent"]),
			),
			retention: retention(
				"Only canonical minimized denial authority remains registered.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/consent-identity-rotation.test.ts",
				"central authority on every send path",
			),
		},
		{
			table: "public.social_account_sync_state",
			capability: "Per-account sync cursors/due state",
			actions: ["reshape"],
			retentionStore: "postgres:public.social_account_sync_state",
			schema: schema(
				"Poll generation/lease is distinct from last successful freshness.",
				"poll_generation",
				"poll_lease_expires_at",
				"social_account_sync_state_claim_check",
			),
			runtime: verified(
				"One fair due-state producer claims and fences account sync work.",
				source("apps/api/src/services/external-post-sync/cron.ts", [
					"pollGeneration",
					"pollLeaseExpiresAt",
				]),
			),
			apiSdk: notApplicable(
				"Account polling state is internal scheduling authority; the account API/SDK exposes results, not mutable poll leases.",
			),
			retention: retention(
				"Poll history/error detail follows bounded operational evidence policy.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/analytics-observation-durability.test.ts",
				"keeps freshness separate from producer and consumer claim state",
			),
		},
		{
			table: "public.cross_post_actions",
			capability: "Cross-post mutation lifecycle",
			actions: ["reshape"],
			retentionStore: "postgres:public.cross_post_actions",
			schema: schema(
				"Immutable product scheduling is separate from mutable retry timing and the due index follows the retry clock.",
				'scheduledFor: timestamp("scheduled_for"',
				'nextAttemptAt: timestamp("next_attempt_at"',
				"cross_post_actions_timestamp_order_check",
				'index("cross_post_actions_due_idx")',
			),
			runtime: verified(
				"Creation/re-anchoring sets both clocks together while readiness/provider retries mutate only nextAttemptAt and due scans consume that clock.",
				source("apps/api/src/routes/posts.ts", [
					"scheduledFor,",
					"nextAttemptAt: scheduledFor",
					"scheduledFor: sql`",
					"nextAttemptAt: sql`",
				]),
				source(
					"apps/api/src/services/cross-post-processor.ts",
					[
						"lte(crossPostActions.nextAttemptAt, now)",
						"nextAttemptAt: new Date(",
					],
					["executeAt", "scheduledFor:"],
				),
			),
			apiSdk: verified(
				"Cross-post configuration/execution remains available.",
				source("apps/api/src/routes/cross-post-actions.ts", [
					"crossPostActions",
				]),
				source("packages/sdk/src/resources/cross-post-actions.ts", [
					"/v1/cross-post-actions",
				]),
			),
			retention: retention(
				"Cross-post attempt detail has a bounded operational-evidence policy.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/scheduled-generator-reliability.test.ts",
				"keeps readiness polling separate from provider attempts",
				"crossPostActions.scheduledFor",
				"crossPostActions.nextAttemptAt",
			),
		},
		{
			table: "public.short_link_credentials",
			capability: "Historical provider credential authority",
			actions: ["complete", "reshape"],
			retentionStore: "postgres:public.short_link_credentials",
			schema: schema(
				"Immutable encrypted versions remain addressable by links after provider/config rotation.",
				"export const shortLinkCredentials = pgTable(",
				"short_link_credentials_org_provider_version_uniq",
				"short_link_credentials_org_active_uniq",
				"short_links_credential_version_fk",
			),
			runtime: verified(
				"Configuration changes retire rather than overwrite credentials; click polling and erasure resolve the link-pinned historical version.",
				source(
					"apps/api/src/services/short-link-configuration.ts",
					[
						"updateVersionedShortLinkConfig",
						'state: "retired"',
						"apiKeyCiphertext: input.encryptedApiKey",
						"resolveExternalShortLinkProvider",
					],
					["set({ apiKeyCiphertext"],
				),
				source("apps/api/src/services/short-link-click-sync.ts", [
					"credentialVersion: link.credentialVersion",
					"resolveExternalShortLinkProvider",
				]),
				source("apps/api/src/services/external-subject-cleanup.ts", [
					"enqueueShortLinkProviderCleanup",
					"credentialCiphertext: null",
				]),
			),
			apiSdk: verified(
				"Customers still configure and rotate provider credentials through the same API/SDK capability without exposing historical ciphertext.",
				source("apps/api/src/routes/short-links.ts", [
					'operationId: "updateShortLinkConfig"',
					"updateVersionedShortLinkConfig",
				]),
				source("packages/sdk/src/resources/short-links.ts", [
					"updateConfig(",
					"api_key?: string",
				]),
			),
			retention: verified(
				"Credential versions are never hold-paused and are tenant-purged after pinned links have staged provider cleanup.",
				source(RETENTION_REGISTRY, ["public.short_link_credentials"]),
				source("apps/api/src/services/tenant-deletion.ts", [
					'tenantPurgeTable("public", "short_link_credentials")',
					"enqueueShortLinkProviderCleanup",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/short-link-local-intent.test.ts",
				"pins provider/config/credential identity in DDL",
				"never overwrites credential ciphertext",
				"pinned historical credential",
			),
		},
		{
			table: "public.short_links",
			capability: "Short URL mapping, creation intent, and click state",
			actions: ["reshape"],
			retentionStore: "postgres:public.short_links",
			schema: schema(
				"Creation and polling both have durable fenced state plus provider-specific identity.",
				"provider_config_version",
				"credential_version",
				"provider_ref",
				"creation_status",
				"creation_fence",
				"click_sync_generation",
				"click_sync_lease_expires_at",
				"short_links_click_sync_due_idx",
			),
			runtime: verified(
				"External creation starts from a local pending intent, ambiguous outcomes stop in manual review, and owner erasure durably stages provider cleanup; RelayAPI KV remains a finite derived cache.",
				source("apps/api/src/services/short-link-lifecycle.ts", [
					"createTrackedExternalShortLink",
					'creationStatus: "pending"',
					'creationStatus: "manual_review"',
					"TrackedShortLinkCreationError",
				]),
				source("apps/api/src/services/short-link-providers/relayapi.ts", [
					"RELAY_API_SHORT_LINK_CACHE_TTL_SECONDS",
					"expirationTtl: RELAY_API_SHORT_LINK_CACHE_TTL_SECONDS",
					"invalidateRelayApiShortLinkCaches",
					"Promise.allSettled",
				]),
				source("apps/api/src/services/tenant-deletion.ts", [
					"enqueueShortLinkProviderCleanup",
					"invalidateRelayApiShortLinkCaches(",
					'row.provider === "relayapi"',
				]),
				source("apps/api/src/services/workspace-erasure.ts", [
					"enqueueShortLinkProviderCleanup",
					"invalidateRelayApiShortLinkCaches(",
					'row.provider === "relayapi"',
				]),
			),
			apiSdk: verified(
				"Short-link creation, listing, statistics, and provider configuration remain API/SDK-backed.",
				source("apps/api/src/routes/short-links.ts", [
					'operationId: "shortenUrl"',
				]),
				source("packages/sdk/src/resources/short-links.ts", [
					"/v1/short-links",
				]),
			),
			retention: verified(
				"The derived KV copy expires after 24 hours and owner erasure deletes known cache keys after the authoritative rows are removed.",
				source(RETENTION_REGISTRY, ["kv:short-link"]),
				source("apps/api/src/services/short-link-providers/relayapi.ts", [
					"24 * 60 * 60",
					'assertKvPrivacyStoreKey("kv:short-link", key)',
					"failed KV delete cannot preserve a deleted redirect",
				]),
			),
			tests: verified(
				"Focused tests fault-inject creation durability and pin every provider-specific identity/probe/cleanup contract.",
				source("apps/api/src/__tests__/short-link-local-intent.test.ts", [
					"commits pending state before provider egress",
					"post-provider failure",
					"manual review",
				]),
				source("apps/api/src/__tests__/short-link-provider-lifecycle.test.ts", [
					"durable local intent as externalId",
					"without expand",
					"edited/custom Bitly link",
					"read-only endpoints",
				]),
				source("apps/api/src/__tests__/relayapi-short-links.test.ts", [
					"RELAY_API_SHORT_LINK_CACHE_TTL_SECONDS",
					"best-effort invalidates each unique durable link cache key",
					"invalidates bounded owner-erasure batches after deleting durable rows",
				]),
			),
		},
		{
			table: "public.idea_comments",
			capability: "Collaborative comments",
			actions: ["reshape"],
			retentionStore: "postgres:public.idea_comments",
			schema: schema(
				"Comments use stable principals and parent comments are bound to the same idea.",
				"idea_comments_author_principal_org_fk",
				"idea_comments_parent_idea_org_fk",
			),
			runtime: verified(
				"Idea comment writes resolve the stable actor principal.",
				source("apps/api/src/routes/ideas.ts", ["authorPrincipalId"]),
			),
			apiSdk: verified(
				"Idea comments remain in API and SDK.",
				source("apps/api/src/routes/ideas.ts", ["ideaComments"]),
				source("packages/sdk/src/resources/ideas.ts", ["comments"]),
			),
			retention: retention(
				"Shared comment content survives only with pseudonymous actor attribution.",
			),
			tests: testEvidence(
				"packages/db/src/organization-principals-contract.test.ts",
				"idea attribution is stable, tenant-safe, and parent-bound",
			),
		},
		{
			table: "public.idea_tags",
			capability: "Idea/tag association",
			actions: ["reshape"],
			retentionStore: "postgres:public.idea_tags",
			schema: schema(
				"Association scope is projected only from the authoritative idea tuple.",
				"idea_tags_idea_org_scope_fk",
				"idea_tags_org_tag_idea_idx",
			),
			runtime: verified(
				"Readers and writers use the idea's projected scope and workspace erasure relies on parent cascade.",
				source(
					"apps/api/src/routes/ideas.ts",
					["scopeKey: row.scopeKey", "scopeKey: current.scopeKey"],
					["ideaTags.workspaceId", "scoped_idea_tags.workspace_id"],
				),
				source(
					"apps/api/src/services/workspace-erasure.ts",
					["export const WORKSPACE_PURGE_TABLES"],
					['"idea_tags"'],
				),
			),
			apiSdk: verified(
				"Idea tag capability remains exposed through idea API/SDK.",
				source("apps/api/src/routes/ideas.ts", ["ideaTags"]),
				source("packages/sdk/src/resources/ideas.ts", ["tag"]),
			),
			retention: retention("Association follows its parent idea lifetime."),
			tests: testEvidence(
				"apps/api/src/__tests__/schema-construction-optimality.test.ts",
				"projects idea-tag scope only from its parent idea",
			),
		},
		{
			table: "public.post_tags",
			capability: "Post/tag association",
			actions: ["complete"],
			retentionStore: "postgres:public.post_tags",
			schema: schema(
				"Parent-projected scope has the post-first tenant-safe access index.",
				"post_tags_post_org_scope_fk",
				"post_tags_org_post_tag_idx",
			),
			runtime: verified(
				"Post tag routes bind writes/reads to the authorized post parent.",
				source("apps/api/src/routes/posts.ts", ["postTags"]),
			),
			apiSdk: verified(
				"Post-tag API methods have explicit SDK parity.",
				source("apps/api/src/routes/posts.ts", ["/{id}/tags"]),
				source("packages/sdk/src/resources/posts/tags.ts", ["/tags"]),
			),
			retention: retention(
				"Association cascades with the authoritative post parent.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/subscription-lists-post-tags.test.ts",
				"makes post-tag identity tenant-safe and keeps a post-first access path",
			),
		},
		{
			table: "public.automation_secrets",
			capability: "Encrypted node credentials",
			actions: ["reshape"],
			retentionStore: "postgres:public.automation_secrets",
			schema: schema(
				"Secret kind is closed and ciphertext remains key-versioned.",
				"automation_secrets_kind_check",
				"keyId",
				"ciphertext",
			),
			runtime: verified(
				"Graph writes redact secrets and persist only AAD-bound ciphertext.",
				source("apps/api/src/services/automations/graph-secrets.ts", [
					"redactAutomationGraphSecrets",
					"keyId",
					"ciphertext",
				]),
			),
			apiSdk: verified(
				"Secrets remain write-only through automation API while SDK sees redacted graph shapes.",
				source("apps/api/src/routes/automations.ts", [
					'operationId: "replaceAutomationGraph"',
				]),
				source("packages/sdk/src/resources/automations.ts", [
					"/v1/automations",
				]),
			),
			retention: retention("Credential ciphertext is never hold-paused."),
			tests: testEvidence(
				"apps/api/src/__tests__/automation-secret-redaction.test.ts",
				"persists only AAD-bound ciphertext and a redacted graph",
			),
		},
		{
			table: "public.automation_entrypoints",
			capability: "Trigger configuration",
			actions: ["reshape"],
			retentionStore: "postgres:public.automation_entrypoints",
			schema: schema(
				"One kind-specific CHECK closes both trigger identity and JSON configuration shape.",
				"automation_entrypoints_kind_identity_config_check",
				"socialAccountId",
				"jsonb_typeof",
			),
			runtime: verified(
				"Prospective entrypoint tuples and kind-specific configs are validated before mutation.",
				source("apps/api/src/routes/automation-entrypoints.ts", [
					"prospectiveAccountId",
				]),
				source("apps/api/src/schemas/automation-entrypoints.ts", [
					"EntrypointConfigByKind",
				]),
			),
			apiSdk: verified(
				"Entrypoint CRUD remains API/SDK-backed.",
				source("apps/api/src/routes/automation-entrypoints.ts", [
					'operationId: "createAutomationEntrypoint"',
				]),
				source("packages/sdk/src/resources/automation-entrypoints.ts", [
					"/v1/automations/",
				]),
			),
			retention: retention(
				"Entrypoint configuration follows automation/entity lifetime.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/automation-entrypoint-filters.test.ts",
				"entrypoint config schema",
			),
		},
		{
			table: "public.automation_entrypoint_daily_counts",
			capability: "Daily admission cap",
			actions: ["reshape"],
			retentionStore: "postgres:public.automation_entrypoint_daily_counts",
			schema: schema(
				"Admission identity uses PostgreSQL DATE and retains one atomic nonnegative count per entrypoint/day.",
				'day: date("day", { mode: "string" }).notNull()',
				"automation_entrypoint_daily_counts_entrypoint_day_uniq",
				"automation_entrypoint_daily_counts_count_check",
			),
			runtime: verified(
				"Enrollment derives a UTC calendar day and increments atomically in the run-admission transaction.",
				source("apps/api/src/services/automations/runner.ts", [
					"toISOString().slice(0, 10)",
					"automationEntrypointDailyCounts",
					'EnrollmentBlockedError("daily_cap")',
				]),
			),
			apiSdk: notApplicable(
				"Daily counter rows are internal admission state; users configure the cap on the entrypoint API instead.",
			),
			retention: verified(
				"Daily bounded oldest-first deletion removes counters after 90 UTC days unless an exact active organization/workspace hold preserves the aggregate.",
				source(RETENTION_REGISTRY, [
					"POSTGRES_AUTOMATION_DAILY_COUNTS",
					"bounded oldest-first deletion after 90 days",
				]),
				source("apps/api/src/services/operational-retention.ts", [
					"export const AUTOMATION_DAILY_COUNT_RETENTION_DAYS = 90",
					"export async function pruneAutomationEntrypointDailyCounts",
					"AUTOMATION_DAILY_COUNT_MAX_DELETE_PASSES",
					"hold.released_at IS NULL",
				]),
				source("apps/api/src/scheduled/index.ts", [
					'name: "automation_entrypoint_daily_count_retention"',
					"pruneAutomationEntrypointDailyCounts(env)",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/automation-daily-count-optimality.test.ts",
				"stores an actual PostgreSQL UTC calendar date",
				"has a bounded 90-day drain with legal-hold exclusion",
			),
		},
		{
			table: "public.automation_bindings",
			capability: "Provider-side automation binding",
			actions: ["reshape"],
			retentionStore: "postgres:public.automation_bindings",
			schema: schema(
				"Desired/applied revisions, due time, lease, provider boundary, and outcome are explicit.",
				"syncRevision",
				"lastSyncedRevision",
				"automation_bindings_sync_boundary_check",
				"automation_bindings_sync_due_idx",
			),
			runtime: verified(
				"Binding synchronization is a fenced, revisioned provider operation.",
				source("apps/api/src/services/automations/binding-sync.ts", [
					"syncRevision",
					"requestMayHaveBeenSentAt",
				]),
			),
			apiSdk: verified(
				"Binding configuration and reconciliation remain API/SDK-backed.",
				source("apps/api/src/routes/automation-bindings.ts", [
					"automationBindings",
				]),
				source("packages/sdk/src/resources/automation-bindings.ts", [
					"/v1/automation-bindings",
				]),
			),
			retention: retention(
				"Provider operation detail is minimized on the operational clock.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/automation-binding-sync.test.ts",
				"Meta automation binding synchronization contracts",
			),
		},
		{
			table: "public.automation_effects",
			capability: "External side-effect ambiguity ledger",
			actions: ["reshape"],
			retentionStore: "postgres:public.automation_effects",
			schema: schema(
				"Effect identity is component-scoped with explicit unknown outcome.",
				"automation_effects_execution_key_uniq",
				"automation_effects_provider_idempotency_uniq",
				"automation_effects_state_fields_check",
			),
			runtime: verified(
				"Only actual external message blocks/actions open an effect boundary.",
				source("apps/api/src/services/automations/nodes/message.ts", [
					"effectKey",
					"message-block:",
				]),
				source("apps/api/src/services/automations/runner.ts", [
					"automationEffects",
				]),
			),
			apiSdk: notApplicable(
				"Effect rows are internal ambiguity/fencing authority; public run APIs expose their safe projection, not mutable effect state.",
			),
			retention: retention(
				"Raw effect detail minimizes after the operational horizon.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/automation-effect-accounting.test.ts",
				"one external effect boundary per actual message block",
			),
		},
		{
			table: "public.automation_step_runs",
			capability: "Public run timeline and analytics",
			actions: ["fix"],
			retentionStore: "postgres:public.automation_step_runs",
			schema: schema(
				"Timeline denormalization is fenced to the authoritative run/automation/tenant/scope tuple.",
				"automation_step_runs_run_auto_org_scope_fk",
				"automation_step_runs_org_time_idx",
				"automation_step_runs_org_scope_time_idx",
				"automation_step_runs_outcome_check",
			),
			runtime: verified(
				"Writers project the run tuple and analytical readers apply the direct tenant fence and constrained failure literal.",
				source("apps/api/src/services/automations/runner.ts", [
					"organizationId: run.organizationId",
					"scopeKey: run.scopeKey",
				]),
				source("apps/api/src/routes/_automation-insights.ts", [
					"automationStepRuns.organizationId",
					"AUTOMATION_STEP_FAILURE_OUTCOME",
				]),
			),
			apiSdk: verified(
				"The public run timeline remains available through the scoped run steps API and SDK.",
				source("apps/api/src/routes/automation-runs.ts", [
					'operationId: "listAutomationRunSteps"',
				]),
				source("packages/sdk/src/resources/automation-runs.ts", [
					"/v1/automation-runs/",
					"/steps",
				]),
			),
			retention: retention(
				"Timeline rows have an indexed, bounded retained-evidence drain.",
			),
			tests: verified(
				"Composite identity and failure-vocabulary behavior are executable.",
				source("packages/db/src/automation-step-runs-contract.test.ts", [
					"automation step analytics are fenced to their authoritative run tuple",
				]),
				source("apps/api/src/__tests__/automation-runner-durability.test.ts", [
					"AUTOMATION_STEP_FAILURE_OUTCOME",
					"outcome",
				]),
			),
		},
		{
			table: "public.automation_scheduled_jobs",
			capability: "Resume/delay/input/event/trigger/failure work",
			actions: ["reshape", "complete"],
			retentionStore: "postgres:public.automation_scheduled_jobs",
			schema: schema(
				"Every job projects tenant scope and its kind selects exactly one composite authoritative parent.",
				'organizationId: text("organization_id").notNull()',
				'scopeKey: text("scope_key").notNull()',
				"automation_scheduled_jobs_run_auto_org_scope_fk",
				"automation_scheduled_jobs_entrypoint_auto_org_scope_fk",
				"automation_scheduled_jobs_parent_union_check",
			),
			runtime: verified(
				"Scheduler is fenced and durable webhook reception failures are captured.",
				source("apps/api/src/services/automations/scheduler.ts", [
					"webhook_reception_failure",
					"lease_token",
				]),
				source("apps/api/src/services/automations/webhook-receiver.ts", [
					'jobType: "webhook_reception_failure"',
				]),
			),
			apiSdk: notApplicable(
				"Scheduled jobs are internal orchestration state; automation/entrypoint APIs configure their authoritative parents.",
			),
			retention: retention(
				"Job payload/error follows bounded operational evidence policy.",
			),
			tests: testEvidence(
				"packages/db/src/schema-construction-optimality.test.ts",
				"scheduled jobs project scope and bind each kind to one parent tuple",
			),
		},
		{
			table: "public.subscription_lists",
			capability: "Channel-scoped subscription audience",
			actions: ["complete"],
			retentionStore: "postgres:public.subscription_lists",
			schema: schema(
				"List identity is tenant/scope safe and membership has immutable transition history.",
				"subscription_lists_id_org_scope_uniq",
				"contact_subscription_events",
			),
			runtime: verified(
				"Membership transition service implements unsubscribe/re-add history without mutating consent.",
				source("apps/api/src/services/contact-subscription-transitions.ts", [
					"transitionContactSubscription",
					"contactSubscriptionEvents",
				]),
				source("apps/api/src/routes/subscription-lists.ts", [
					"transitionContactSubscription",
				]),
			),
			apiSdk: verified(
				"List CRUD and membership operations are present in API and SDK.",
				source("apps/api/src/routes/subscription-lists.ts", [
					'operationId: "createSubscriptionList"',
				]),
				source("packages/sdk/src/resources/subscription-lists.ts", [
					"/v1/subscription-lists",
				]),
			),
			retention: retention(
				"Definition follows entity lifetime; membership history is bounded operational evidence.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/subscription-lists-post-tags.test.ts",
				"records history atomically, keeps merges append-only, and never mutates consent",
			),
		},
		{
			table: "public.ai_knowledge_bases",
			capability: "Knowledge configuration",
			actions: ["complete", "reshape"],
			retentionStore: "postgres:public.ai_knowledge_bases",
			schema: schema(
				"Embedding provider/model/dimensions are one closed registry.",
				"ai_knowledge_bases_embedding_registry_check",
				"AI_EMBEDDING_DIMENSIONS",
			),
			runtime: verified(
				"OpenAI embedding requests use the fixed supported registry.",
				source("apps/api/src/services/ai-knowledge.ts", [
					"OPENAI_EMBEDDINGS_URL",
					"AI_EMBEDDING_MODEL",
				]),
			),
			apiSdk: verified(
				"Knowledge-base CRUD is API/SDK-backed.",
				source("apps/api/src/routes/ai-knowledge.ts", ["aiKnowledgeBases"]),
				source("packages/sdk/src/resources/ai-knowledge.ts", [
					"/v1/ai-knowledge",
				]),
			),
			retention: retention("Knowledge configuration follows entity lifetime."),
			tests: testEvidence(
				"apps/api/src/__tests__/ai-optimality.test.ts",
				"sends the fixed OpenAI embedding contract and rejects dimensional drift",
			),
		},
		{
			table: "public.ai_knowledge_documents",
			capability: "Ingestion source/state",
			actions: ["complete"],
			retentionStore: "postgres:public.ai_knowledge_documents",
			schema: schema(
				"Source union, claim lease, attempts, terminal state, and hash are explicit.",
				"ai_knowledge_documents_source_check",
				"ai_knowledge_documents_lease_check",
				"ai_knowledge_documents_content_hash_check",
			),
			runtime: verified(
				"URL/media/text sources are bounded, claimed, classified, and chunked.",
				source("apps/api/src/services/ai-knowledge.ts", [
					"claimKnowledgeDocument",
					"chunkKnowledgeText",
					"isSupportedKnowledgeMediaMimeType",
				]),
			),
			apiSdk: verified(
				"Document ingestion/list/delete is API/SDK-backed.",
				source("apps/api/src/routes/ai-knowledge.ts", ["aiKnowledgeDocuments"]),
				source("packages/sdk/src/resources/ai-knowledge.ts", ["documents"]),
			),
			retention: retention(
				"Documents follow KB/entity lifetime and bounded failure detail.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/ai-optimality.test.ts",
				"normalizes and chunks deterministically with bounded overlap",
			),
		},
		{
			table: "public.ai_knowledge_chunks",
			capability: "Searchable knowledge chunks",
			actions: ["complete", "reshape"],
			retentionStore: "postgres:public.ai_knowledge_chunks",
			schema: schema(
				"Vector width, HNSW cosine index, ordinal uniqueness, and hash are explicit.",
				"dimensions: AI_EMBEDDING_DIMENSIONS",
				"ai_knowledge_chunks_embedding_hnsw_idx",
				"vector_cosine_ops",
			),
			runtime: verified(
				"Chunk writer batches fixed-width embeddings and search uses cosine distance.",
				source("apps/api/src/services/ai-knowledge.ts", [
					"createOpenAiEmbeddings",
					"cosineDistance",
					"aiKnowledgeChunks",
				]),
			),
			apiSdk: verified(
				"Search is represented in knowledge API/SDK.",
				source("apps/api/src/routes/ai-knowledge.ts", ["searchKnowledgeBase"]),
				source("packages/sdk/src/resources/ai-knowledge.ts", ["search"]),
			),
			retention: retention("Chunks cascade with the document/knowledge base."),
			tests: testEvidence(
				"apps/api/src/__tests__/ai-optimality.test.ts",
				"rejects dimensional drift",
			),
		},
		{
			table: "public.ai_agents",
			capability: "Inbox/automation AI agent configuration",
			actions: ["complete", "reshape"],
			retentionStore: "postgres:public.ai_agents",
			schema: schema(
				"Supported model, typed guardrails/handoff, and tenant-safe principal/KB are constrained.",
				"ai_agents_model_registry_check",
				"ai_agents_guardrails_shape_check",
				"ai_agents_handoff_principal_org_fk",
			),
			runtime: verified(
				"Workers AI inference validates persisted model and never silently falls back.",
				source("apps/api/src/services/ai-agent.ts", [
					"unsupported_agent_model",
					"AI_INFERENCE_MODEL",
				]),
			),
			apiSdk: verified(
				"Agent CRUD/run is API/SDK-backed.",
				source("apps/api/src/routes/ai-agents.ts", ["runAiAgent"]),
				source("packages/sdk/src/resources/ai-agents.ts", ["/v1/ai-agents"]),
			),
			retention: retention("Agent configuration follows entity lifetime."),
			tests: testEvidence(
				"apps/api/src/__tests__/ai-optimality.test.ts",
				"rejects unsupported persisted models instead of silently falling back",
			),
		},
		{
			table: "public.ref_urls",
			capability: "Trackable public visit/automation trigger",
			actions: ["reshape", "complete"],
			retentionStore: "postgres:public.ref_urls",
			schema: schema(
				"Destination is a closed HTTPS/landing-page union with scoped slug.",
				"ref_urls_destination_type_check",
				"ref_urls_destination_union_check",
			),
			runtime: verified(
				"Public visits commit an idempotent occurrence, insert-wins counter, and automation outbox state.",
				source("apps/api/src/services/public-growth-events.ts", [
					"recordRefVisit",
					"publicGrowthEvents",
				]),
				source("apps/api/src/routes/public-growth.ts", ["recordRefVisit"]),
			),
			apiSdk: verified(
				"Definition CRUD is represented in API and SDK; anonymous resolution is intentionally public.",
				source("apps/api/src/routes/ref-urls.ts", [
					'operationId: "createRefUrl"',
				]),
				source("packages/sdk/src/resources/ref-urls.ts", ["/v1/ref-urls"]),
			),
			retention: retention(
				"Definition follows entity lifetime; occurrences have their own bounded store.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/public-growth-optimality.test.ts",
				"commits event before insert-wins counters and fences dispatch retries",
			),
		},
		{
			table: "public.qr_codes",
			capability: "Per-placement QR identity and scans",
			actions: ["complete", "reshape"],
			retentionStore: "postgres:public.qr_codes",
			schema: schema(
				"Placement identity remains, while image object state is absent.",
				"public_id",
				"qr_codes_ref_url_label_uniq",
				"qr_codes_public_id_format_check",
			),
			runtime: verified(
				"QR SVG is deterministic and generated on read; erasure no longer has an R2 cursor phase.",
				source("apps/api/src/lib/qr-renderer.ts", ["renderQrSvg"]),
				source("apps/api/src/routes/qr-codes.ts", ["renderQrSvg"]),
				source(
					"apps/api/src/services/tenant-deletion.ts",
					[],
					['qr_codes" | "account_dependents'],
				),
			),
			apiSdk: verified(
				"Placement CRUD/render paths are API/SDK-backed.",
				source("apps/api/src/routes/qr-codes.ts", [
					'operationId: "createQrCode"',
				]),
				source("packages/sdk/src/resources/qr-codes.ts", ["/v1/qr-codes"]),
			),
			retention: retention(
				"QR placement follows entity lifetime; no image object requires a second lifecycle.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/public-growth-optimality.test.ts",
				"renders deterministic, self-contained SVG instead of R2 objects",
			),
		},
		{
			table: "public.landing_pages",
			capability: "Public conversion page linked to automation",
			actions: ["complete"],
			retentionStore: "postgres:public.landing_pages",
			schema: schema(
				"Selected org/workspace slug and versioned config are constrained.",
				"landing_pages_org_scope_slug_uniq",
				"landing_pages_config_version_check",
			),
			runtime: verified(
				"Public render/conversion validates blocks and commits contact, occurrence, counter, and outbox atomically.",
				source("apps/api/src/services/public-growth-events.ts", [
					"recordLandingConversion",
				]),
				source("apps/api/src/routes/public-growth.ts", [
					"LandingPageConversionSpec",
				]),
			),
			apiSdk: verified(
				"Definition CRUD is present in API/SDK; anonymous render/convert remains public.",
				source("apps/api/src/routes/landing-pages.ts", [
					'operationId: "createLandingPage"',
				]),
				source("packages/sdk/src/resources/landing-pages.ts", [
					"/v1/landing-pages",
				]),
			),
			retention: retention(
				"Definition follows entity lifetime; occurrences have independent bounded retention.",
			),
			tests: testEvidence(
				"apps/api/src/__tests__/public-growth-optimality.test.ts",
				"validates a versioned block union and contact-resolvable forms",
			),
		},
		{
			table: "public.operator_resolution_notes",
			capability: "Bounded free-form operator rationale",
			actions: ["complete", "reshape"],
			retentionStore: "postgres:public.operator_resolution_notes",
			schema: schema(
				"Free-form rationale is encrypted outside the append-only evidence perimeter and carries an exact expiry.",
				"export const operatorResolutionNotes = pgTable(",
				"note_ciphertext",
				"operator_resolution_notes_expiry_check",
				"operator_resolution_notes_expiry_idx",
			),
			runtime: verified(
				"Resolution encrypts the note with evidence-bound context, reads decrypt only unexpired notes, rotates ciphertext, and runs a bounded deletion drain.",
				source("apps/api/src/services/operator-resolution.ts", [
					'field: "note_ciphertext"',
					"operatorResolutionNotes",
					"expiresAt",
				]),
				source("apps/api/src/services/encryption-rotation.ts", [
					"operatorNoteRows",
					"operatorResolutionNotes.noteCiphertext",
				]),
				source("apps/api/src/services/timed-domain-retention.ts", [
					"retainOperatorResolutionNotes",
					"DELETE FROM operator_resolution_notes AS note",
				]),
			),
			apiSdk: verified(
				"Operator resolution and evidence listing remain available through the admin API/SDK while expired rationale serializes as absent.",
				source("apps/api/src/routes/admin.ts", [
					'operationId: "adminResolveOperatorResolution"',
					'operationId: "adminListOperatorResolutionEvidence"',
				]),
				source("packages/sdk/src/resources/admin.ts", [
					"resolveOperatorResolution(",
					"listOperatorResolutionEvidence(",
				]),
			),
			retention: verified(
				"Notes are never hold-extended and are deleted on their fixed 90-day clock; the minimized reason code/digest remains in evidence.",
				source(RETENTION_REGISTRY, ["public.operator_resolution_notes"]),
				source("packages/db/src/specialized-retention-contracts.ts", [
					'storeId: "postgres:public.operator_resolution_notes"',
					'handlerId: "retain_operator_resolution_notes"',
				]),
			),
			tests: verified(
				"Focused tests cover the evidence split, encryption, expiry index, and executable drain.",
				source("packages/db/src/operator-resolution-contract.test.ts", [
					"operator resolution evidence has a closed target/action matrix",
					"operator prose is encrypted, independently erasable, and expires after 90 days",
					'"reason_code"',
					'"note_ciphertext"',
				]),
				source("apps/api/src/__tests__/timed-domain-retention.test.ts", [
					"operator_resolution_notes_expiry_idx",
					"DELETE FROM operator_resolution_notes AS note",
				]),
			),
		},
		{
			table: "public.retention_drain_runs",
			capability: "Durable per-handler retention continuation authority",
			actions: ["complete"],
			retentionStore: "postgres:public.retention_drain_runs",
			schema: schema(
				"One bounded fenced row records each executable handler's cursor and backlog state.",
				"retention_drain_runs_handler_id_check",
				"retention_drain_runs_lease_check",
				"retention_drain_runs_cursor_check",
				"retention_drain_runs_continuation_idx",
			),
			runtime: verified(
				"Daily admission and every-minute continuation isolate failures, persist cursor progress, and escalate aged backlog.",
				source("apps/api/src/services/executable-retention.ts", [
					"validateRetentionDrainRunHandlerIds",
					"runRetentionHandlersIsolated",
					"continueExecutablePostgresRetention",
					"RETENTION_BACKLOG_SLO_MS",
				]),
				source("apps/api/src/scheduled/index.ts", [
					"executable_postgres_retention_continuation",
					"continueExecutablePostgresRetention(env)",
				]),
			),
			apiSdk: notApplicable(
				"Retention scheduling is an internal maintenance authority with no customer-facing API or SDK surface.",
			),
			retention: verified(
				"The control relation is cardinality-bounded by the executable handler registry and contains no tenant or personal payload.",
				source(RETENTION_REGISTRY, [
					"POSTGRES_RETENTION_DRAIN_CONTROL",
					"public.retention_drain_runs",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/executable-retention.test.ts",
				"isolates a throwing handler and reports it only after later handlers run",
				"keeps one bounded fenced control row per executable handler",
				"can drain at least the highest sold per-minute request admission",
			),
		},
		{
			table: "public.billing_operation_attempts",
			capability: "Immutable revisioned Stripe settlement attempts",
			actions: ["complete"],
			retentionStore: "postgres:public.billing_operation_attempts",
			schema: schema(
				"Each immutable economic request has a unique operation revision and provider idempotency key, with explicit ambiguous and terminal evidence states.",
				"export const billingOperationAttempts = pgTable(",
				"billing_operation_attempts_operation_revision_uniq",
				"billing_operation_attempts_state_shape_check",
			),
			runtime: verified(
				"Settlement marks the provider boundary before I/O, reconciles the exact revision, and creates a new revision only after evidence that the prior request did not apply.",
				source("apps/api/src/services/billing-operations.ts", [
					"billingOperationAttempts",
					"requestMayHaveBeenSentAt",
					"processCatchupInvoiceOperations",
				]),
				source("apps/api/src/services/operator-resolution.ts", [
					"attemptRevision",
					"billingOperationAttempts",
				]),
			),
			apiSdk: notApplicable(
				"Attempt revisions are internal provider-boundary evidence; customers consume the resulting invoice and usage resources rather than mutating settlement authority directly.",
			),
			retention: verified(
				"Attempts are retained as financial evidence and are minimized child-first before their parent operation can be removed.",
				source(RETENTION_REGISTRY, ["public.billing_operation_attempts"]),
				source("apps/api/src/services/financial-retention.ts", [
					"billingOperationProviderReferences",
					"await tx.delete(billingOperationAttempts)",
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/billing-operations.test.ts",
				"creates with a stable idempotency key and persists the Stripe item ID",
				"audits and writes off an ambiguous operation after 30 days",
			),
		},
		{
			table: "public.stripe_organization_leases",
			capability: "Per-organization Stripe event serialization",
			actions: ["complete"],
			retentionStore: "postgres:public.stripe_organization_leases",
			schema: schema(
				"One organization-owned aggregate row carries a monotonically increasing lease token and a paired owner/expiry fence.",
				"export const stripeOrganizationLeases = pgTable(",
				"stripe_organization_leases_state_check",
				"stripe_organization_leases_expiry_idx",
			),
			runtime: verified(
				"Every Stripe-derived projection claims the aggregate and rechecks the exact owner, token, and live expiry under row lock before commit.",
				source("apps/api/src/services/stripe-organization-lease.ts", [
					"claimStripeOrganizationFence",
					"assertStripeOrganizationFence",
					"releaseStripeOrganizationFence",
				]),
				source("apps/api/src/routes/stripe-webhooks.ts", [
					"claimStripeOrganizationFence",
					"releaseStripeOrganizationFence",
				]),
			),
			apiSdk: notApplicable(
				"The lease is private webhook coordination state; exposing it would let clients influence financial ordering without adding a product capability.",
			),
			retention: verified(
				"The cardinality-bounded coordination row follows its organization and is removed by database cascade and the explicit tenant purge plan.",
				source(RETENTION_REGISTRY, ["public.stripe_organization_leases"]),
				source("apps/api/src/services/tenant-deletion.ts", [
					'tenantPurgeTable("public", "stripe_organization_leases")',
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/stripe-webhooks.test.ts",
				"does not regress a newer canonical active state for a delayed failure",
			),
		},
		{
			table: "public.whatsapp_phone_billing_attempts",
			capability: "Immutable revisioned phone add-on billing attempts",
			actions: ["complete"],
			retentionStore: "postgres:public.whatsapp_phone_billing_attempts",
			schema: schema(
				"Each phone quantity request has a unique revision and Stripe idempotency key, immutable economic fields, append-only provider evidence, and a guarded state transition.",
				"export const whatsappPhoneBillingAttempts = pgTable(",
				"wa_phone_billing_attempts_operation_revision_uniq",
				"wa_phone_billing_attempts_state_shape_check",
			),
			runtime: verified(
				"Phone billing inserts one prepared attempt per authority revision, records the provider boundary atomically, and creates another revision only after canonical or operator proof of non-application.",
				source("apps/api/src/services/phone-number-operations.ts", [
					"insertPhoneBillingAttempt",
					"markPhoneBillingBoundary",
					"resetPhoneBillingAfterConfirmedNotApplied",
				]),
				source("packages/db/scripts/render-billing-period-invariant-sql.ts", [
					"enforce_phone_billing_attempt_authority",
					"phone billing provider identity and evidence are append-only once observed",
				]),
			),
			apiSdk: notApplicable(
				"Attempt revisions are private Stripe-boundary evidence behind the existing phone resource API.",
			),
			retention: verified(
				"Attempts follow their organization authority; tenant erasure first hashes every immutable revision and provider observation into detached seven-year financial evidence, then deletes attempts child-first.",
				source(RETENTION_REGISTRY, [
					"public.whatsapp_phone_billing_attempts",
					"detached seven-year financial receipt digest",
				]),
				source("apps/api/src/services/financial-retention.ts", [
					"phone_billing_operation",
					"phoneBillingProviderReferences",
					"attempt.providerEvidence",
				]),
				source("apps/api/src/services/tenant-deletion.ts", [
					'tenantPurgeTable("public", "whatsapp_phone_billing_attempts")',
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/phone-operation-shape.test.ts",
				"serializes the shared Stripe phone add-on by organization",
			),
		},
		{
			table: "public.whatsapp_phone_billing_operations",
			capability: "Dedicated phone add-on quantity authority",
			actions: ["complete"],
			retentionStore: "postgres:public.whatsapp_phone_billing_operations",
			schema: schema(
				"Exactly one organization row owns desired/applied quantity, the dedicated Stripe add-on identity, and a fenced ambiguous-request lifecycle.",
				"export const whatsappPhoneBillingOperations = pgTable(",
				"wa_phone_billing_boundary_check",
				"wa_phone_billing_status_due_idx",
			),
			runtime: verified(
				"Phone changes converge the authoritative desired quantity while marking the Stripe boundary before provider I/O and waking reconciliation from add-on webhooks.",
				source("apps/api/src/services/phone-number-operations.ts", [
					"wakePhoneAddonBillingReconciliation",
					"desiredQuantity",
					"requestMayHaveBeenSentAt",
				]),
			),
			apiSdk: notApplicable(
				"This is private billing coordination behind the existing WhatsApp phone API/SDK; callers manage phone resources, not provider subscription quantities.",
			),
			retention: verified(
				"The coordination row follows organization lifetime; tenant erasure snapshots its economic state plus every attempt into detached seven-year evidence before removing the live authority.",
				source(RETENTION_REGISTRY, [
					"public.whatsapp_phone_billing_operations",
					"detached seven-year financial receipt digest",
				]),
				source("apps/api/src/services/financial-retention.ts", [
					"phone_billing_operation",
					"phoneBillingProviderReferences",
				]),
				source("apps/api/src/services/tenant-deletion.ts", [
					'tenantPurgeTable("public", "whatsapp_phone_billing_operations")',
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/phone-operation-shape.test.ts",
				"serializes the shared Stripe phone add-on by organization",
			),
		},
		{
			table: "public.ad_mutation_operations",
			capability: "Fenced paid-provider mutation authority",
			actions: ["complete"],
			retentionStore: "postgres:public.ad_mutation_operations",
			schema: schema(
				"One active operation per paid target stores a hashed request identity, provider-boundary timestamps, a fence, and separate provider/projection phases.",
				"export const adMutationOperations = pgTable(",
				"ad_mutation_operations_target_active_uniq",
				"ad_mutation_operations_projection_check",
			),
			runtime: verified(
				"Mutations persist intent and boundary before provider I/O, reconcile ambiguous responses, and project locally only after confirmed provider state.",
				source("apps/api/src/services/ad-mutation-operations.ts", [
					"executeAdMutation",
					"requestMayHaveBeenSentAt",
					"providerConfirmedAt",
					"reconcileAdMutationOperations",
				]),
			),
			apiSdk: notApplicable(
				"The durable operation is an internal safety mechanism behind existing ad and campaign endpoints; it is not a client-controlled resource.",
			),
			retention: verified(
				"The operation follows its paid target and organization lifetime, with explicit tenant purge coverage and classified minimized fields.",
				source(RETENTION_REGISTRY, ["public.ad_mutation_operations"]),
				source("apps/api/src/services/tenant-deletion.ts", [
					'tenantPurgeTable("public", "ad_mutation_operations")',
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/ad-mutation-operations.test.ts",
				"records the boundary before provider I/O and projects only after confirmation",
			),
		},
		{
			table: "public.usage_reservation_carryovers",
			capability: "Settlement-aware cross-period allowance evidence",
			actions: ["complete"],
			retentionStore: "postgres:public.usage_reservation_carryovers",
			schema: schema(
				"A composite edge binds one original reservation to every successor bucket under same-tenant foreign keys, without moving the source economic attribution.",
				"export const usageReservationCarryovers = pgTable(",
				"usage_reservation_carryovers_source_org_fk",
				"usage_reservation_carryovers_successor_org_fk",
			),
			runtime: verified(
				"Every split copies unresolved sources while quota and settlement hold N and debit only eventual K; carryover-linked released idempotency records cannot be resurrected.",
				source("apps/api/src/services/billing-periods.ts", [
					"createUsageReservationCarryovers",
					"sourceBucketIds: cycleBuckets.map",
				]),
				source("apps/api/src/services/usage-meter.ts", [
					"effectiveCarryoverAllowance",
					"Carryover-linked usage reservations are terminal",
				]),
				source("apps/api/src/services/invoice-generator.ts", [
					"carryover.pendingUnits > 0",
					"effectiveCarryoverAllowance",
				]),
			),
			apiSdk: notApplicable(
				"The edge is internal accounting evidence; the usage API exposes only its effective quota result and clients must not control predecessor attribution.",
			),
			retention: verified(
				"The edge follows its two usage parents, is explicitly purged child-first, and tenant erasure refuses to freeze a receipt until pending predecessor evidence terminalizes.",
				source(RETENTION_REGISTRY, [
					"public.usage_reservation_carryovers",
					"Tenant erasure refuses unresolved predecessors",
				]),
				source("apps/api/src/services/financial-retention.ts", [
					"getUsageCarryoverContributions",
					"Usage carryover remains unresolved for bucket",
				]),
				source("apps/api/src/services/tenant-deletion.ts", [
					'tenantPurgeTable("public", "usage_reservation_carryovers")',
				]),
			),
			tests: testEvidence(
				"apps/api/src/__tests__/usage-authority-self-heal-db.test.ts",
				"carries late paid outcomes across grace recovery and a second split without burning released units",
			),
		},
	];

export const SCHEMA_FREEZE_CAPABILITY_GAPS =
	SCHEMA_FREEZE_CAPABILITY_TRACE.flatMap((entry) =>
		(
			[
				["schema", entry.schema],
				["runtime", entry.runtime],
				["apiSdk", entry.apiSdk],
				["retention", entry.retention],
				["tests", entry.tests],
			] as const
		).flatMap(([layer, evidence]) =>
			evidence.status === "gap"
				? [{ table: entry.table, layer, reason: evidence.reason }]
				: [],
		),
	);
