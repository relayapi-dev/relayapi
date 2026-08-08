import { describe, expect, it } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../../packages/db/src/schema";
import { canRequestTenantDeletion } from "../routes/organizations";
import {
	requestTenantDeletion,
	TENANT_PURGE_TABLES,
	TENANT_RETAINED_TABLES,
	TenantDeletionNotFoundError,
	tenantDeletionStepKeys,
} from "../services/tenant-deletion";

describe("organization deletion tenant authority", () => {
	it("allows an owner to delete their own organization", () => {
		expect(
			canRequestTenantDeletion({
				principalType: "dashboard_user",
				callerOrganizationId: "org_a",
				targetOrganizationId: "org_a",
				membershipRole: "owner",
				globalRole: null,
			}),
		).toBe(true);
	});

	it("does not let an organization admin delete the tenant", () => {
		expect(
			canRequestTenantDeletion({
				principalType: "dashboard_user",
				callerOrganizationId: "org_a",
				targetOrganizationId: "org_a",
				membershipRole: "admin",
				globalRole: null,
			}),
		).toBe(false);
	});

	it("does not treat ownership in one tenant as authority over another", () => {
		expect(
			canRequestTenantDeletion({
				principalType: "dashboard_user",
				callerOrganizationId: "org_a",
				targetOrganizationId: "org_b",
				membershipRole: "owner",
				globalRole: null,
			}),
		).toBe(false);
	});

	it("allows a system administrator to delete a different tenant", () => {
		expect(
			canRequestTenantDeletion({
				principalType: "dashboard_user",
				callerOrganizationId: "org_admin",
				targetOrganizationId: "org_customer",
				membershipRole: null,
				globalRole: "admin",
			}),
		).toBe(true);
	});

	it("does not let a service key inherit its creator's owner or system-admin authority", () => {
		for (const globalRole of [null, "admin"] as const) {
			expect(
				canRequestTenantDeletion({
					principalType: "service",
					callerOrganizationId: "org_a",
					targetOrganizationId: "org_a",
					membershipRole: "owner",
					globalRole,
				}),
			).toBe(false);
		}
	});
});

describe("organization deletion ownership boundary", () => {
	it("keeps an explicit child-first purge graph for every tenant-owned table", () => {
		const configured = new Map(
			TENANT_PURGE_TABLES.map((entry, index) => [
				`${entry.schema}.${entry.table}`,
				{ ...entry, index },
			]),
		);
		const tables = Object.values(schema).flatMap((value) => {
			if (!is(value, PgTable)) return [];
			const table = getTableConfig(value);
			return [{ key: `${table.schema ?? "public"}.${table.name}`, table }];
		});
		const retained = new Set(
			TENANT_RETAINED_TABLES.map((entry) => `${entry.schema}.${entry.table}`),
		);
		const expected = tables
			.filter(({ key, table }) => {
				if (key === "auth.organization" || retained.has(key)) {
					return false;
				}
				return table.columns.some(
					(column) =>
						column.name === "organization_id" ||
						column.name === "organizationId",
				);
			})
			.map(({ key }) => key)
			.sort();

		expect([...configured.keys()].sort()).toEqual(expected);
		for (const key of retained) {
			expect(configured.has(key)).toBe(false);
		}
		expect(
			TENANT_RETAINED_TABLES.map(({ reason }) => reason.trim()).every(Boolean),
		).toBe(true);

		for (const { key: childKey, table } of tables) {
			for (const foreignKey of table.foreignKeys) {
				const parent = getTableConfig(foreignKey.reference().foreignTable);
				const parentKey = `${parent.schema ?? "public"}.${parent.name}`;
				const child = configured.get(childKey);
				const configuredParent = configured.get(parentKey);
				if (child && configuredParent && childKey !== parentKey) {
					expect(child.index).toBeLessThan(configuredParent.index);
				} else if (!child && configuredParent) {
					expect(foreignKey.onDelete).not.toBe("no action");
				}
			}
		}
	});

	it("checkpoints every bounded purge phase and uses indexed array containment", async () => {
		const keys = tenantDeletionStepKeys();
		expect(new Set(keys).size).toBe(keys.length);
		for (const table of TENANT_PURGE_TABLES) {
			expect(keys).toContain(`purge:${table.schema}.${table.table}`);
		}
		const source = await Bun.file(
			`${new URL("../../../../", import.meta.url).pathname}apps/api/src/services/tenant-deletion.ts`,
		).text();
		expect(source).toContain("tenantDeletionSteps");
		expect(source).toContain("TENANT_DELETE_BATCH_SIZE");
		expect(source).toContain("FOR UPDATE OF target SKIP LOCKED");
		expect(source).toContain("organization_ids @> ARRAY[");
		expect(source).not.toContain("ANY(organization_ids)");
	});

	it("uses the actor-to-members-to-organizations-to-credential lock order", async () => {
		const source = await Bun.file(
			`${new URL("../../../../", import.meta.url).pathname}apps/api/src/services/tenant-deletion.ts`,
		).text();
		const actorLock = source.indexOf("await authorityFence.lockActorUser(tx)");
		const memberLock = source.indexOf(
			"const lockedMemberships = await tx",
			actorLock,
		);
		const ownerAdvisoryLock = source.indexOf(
			"select pg_advisory_xact_lock(hashtext(",
			memberLock,
		);
		const organizationLock = source.indexOf(
			"const lockedOrganizations = await tx",
			ownerAdvisoryLock,
		);
		const membershipRecheck = source.indexOf(
			"const currentMemberships = await tx",
			organizationLock,
		);
		const exactAuthority = source.indexOf(
			"await authorityFence.authorize(tx)",
			membershipRecheck,
		);

		expect(actorLock).toBeGreaterThan(-1);
		expect(memberLock).toBeGreaterThan(actorLock);
		expect(ownerAdvisoryLock).toBeGreaterThan(memberLock);
		expect(organizationLock).toBeGreaterThan(ownerAdvisoryLock);
		expect(membershipRecheck).toBeGreaterThan(organizationLock);
		expect(exactAuthority).toBeGreaterThan(membershipRecheck);
		expect(source).toContain('isolationLevel: "read committed"');
		expect(source).toContain("TenantMembershipSetChangedError");
	});

	it("fails closed on security-critical cache invalidation before lifecycle commit", async () => {
		const serviceSource = await Bun.file(
			`${new URL("../../../../", import.meta.url).pathname}apps/api/src/services/tenant-deletion.ts`,
		).text();
		const routeSource = await Bun.file(
			`${new URL("../../../../", import.meta.url).pathname}apps/api/src/routes/organizations.ts`,
		).text();
		const invalidation = serviceSource.indexOf(
			"await beforeCommitInvalidation?.(result)",
		);
		const lifecycleFence = serviceSource.indexOf(
			'lifecycleStatus: "deleting"',
			invalidation,
		);
		expect(invalidation).toBeGreaterThan(-1);
		expect(lifecycleFence).toBeGreaterThan(invalidation);
		expect(routeSource).toContain("await Promise.all([");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: matching source text
		expect(routeSource).toContain("`org-summary:${targetOrganizationId}`");
		expect(routeSource).not.toContain("Promise.allSettled(invalidations)");
	});

	it("retries before mutation when the locked membership set changes", async () => {
		let transactionCalls = 0;
		let memberSelects = 0;
		let organizationSelects = 0;
		let advisoryLocks = 0;
		const query = (rows: Array<{ id: string }>) => {
			const promise = Promise.resolve(rows) as Promise<
				Array<{ id: string }>
			> & {
				for: () => unknown;
				limit: () => unknown;
				orderBy: () => unknown;
			};
			promise.for = () => promise;
			promise.limit = () => promise;
			promise.orderBy = () => promise;
			return promise;
		};
		const tx = {
			select: () => ({
				from: (table: unknown) => ({
					where: () => {
						if (table === schema.member) {
							memberSelects += 1;
							return query(
								memberSelects === 1
									? [{ id: "member_1" }]
									: [{ id: "member_1" }, { id: "member_2" }],
							);
						}
						if (table === schema.organization) {
							organizationSelects += 1;
							return query(organizationSelects === 1 ? [{ id: "org_1" }] : []);
						}
						return query([]);
					},
				}),
			}),
			execute: async () => {
				advisoryLocks += 1;
			},
		};
		const db = {
			transaction: async (
				callback: (transaction: typeof tx) => Promise<unknown>,
			) => {
				transactionCalls += 1;
				return callback(tx);
			},
		};

		await expect(
			requestTenantDeletion(db as never, "org_1", {
				organizationIds: ["org_1"],
				lockActorUser: async () => {},
				authorize: async () => "user_1",
			}),
		).rejects.toBeInstanceOf(TenantDeletionNotFoundError);
		expect(transactionCalls).toBe(2);
		expect(advisoryLocks).toBe(2);
	});

	it("reaches automation step history through its tenant-owned run", () => {
		const stepRuns = getTableConfig(schema.automationStepRuns);
		const runForeignKey = stepRuns.foreignKeys.find((foreignKey) => {
			const parent = getTableConfig(foreignKey.reference().foreignTable);
			return parent.name === "automation_runs";
		});

		expect(runForeignKey).toBeDefined();
		expect(runForeignKey?.onDelete).toBe("cascade");
	});

	it("uses one tenant-composite cascade instead of duplicate foreign keys", () => {
		const cascadeRelations: Array<{
			child: PgTable;
			parent: PgTable;
			columns: string[];
			onDelete: "cascade" | "restrict";
		}> = [
			{
				child: schema.adAccounts,
				parent: schema.socialAccounts,
				columns: ["social_account_id", "organization_id", "scope_key"],
				onDelete: "cascade",
			},
			{
				child: schema.adCampaigns,
				parent: schema.adAccounts,
				columns: ["ad_account_id", "organization_id", "scope_key", "platform"],
				onDelete: "cascade",
			},
			{
				child: schema.adAudiences,
				parent: schema.adAccounts,
				columns: ["ad_account_id", "organization_id", "scope_key", "platform"],
				onDelete: "cascade",
			},
			{
				child: schema.automationBindings,
				parent: schema.socialAccounts,
				columns: ["social_account_id", "organization_id", "scope_key"],
				onDelete: "cascade",
			},
			{
				child: schema.automationBindings,
				parent: schema.automations,
				columns: ["automation_id", "organization_id", "scope_key"],
				onDelete: "cascade",
			},
			{
				child: schema.automationContactControls,
				parent: schema.contacts,
				columns: ["contact_id", "organization_id"],
				onDelete: "cascade",
			},
			{
				child: schema.automationContactControls,
				parent: schema.automations,
				columns: ["automation_id", "organization_id"],
				onDelete: "cascade",
			},
			{
				child: schema.broadcasts,
				parent: schema.socialAccounts,
				columns: [
					"social_account_id",
					"organization_id",
					"scope_key",
					"platform",
				],
				onDelete: "cascade",
			},
			{
				child: schema.contactSegmentMemberships,
				parent: schema.contacts,
				columns: ["contact_id", "organization_id", "scope_key"],
				onDelete: "cascade",
			},
			{
				child: schema.contactSegmentMemberships,
				parent: schema.segments,
				columns: [
					"segment_id",
					"organization_id",
					"scope_key",
					"segment_is_dynamic",
				],
				onDelete: "cascade",
			},
			{
				child: schema.contacts,
				parent: schema.workspaces,
				columns: ["workspace_id", "organization_id"],
				onDelete: "restrict",
			},
			{
				child: schema.customFieldValues,
				parent: schema.customFieldDefinitions,
				columns: ["definition_id", "organization_id", "definition_scope_key"],
				onDelete: "cascade",
			},
			{
				child: schema.customFieldValues,
				parent: schema.contacts,
				columns: ["contact_id", "organization_id", "scope_key"],
				onDelete: "cascade",
			},
			{
				child: schema.inboxConversationNotes,
				parent: schema.inboxConversations,
				columns: ["conversation_id", "organization_id"],
				onDelete: "cascade",
			},
			{
				child: schema.inboxConversations,
				parent: schema.socialAccounts,
				columns: ["account_id", "organization_id", "scope_key", "platform"],
				onDelete: "cascade",
			},
			{
				child: schema.inboxMessages,
				parent: schema.inboxConversations,
				columns: ["conversation_id", "organization_id", "scope_key"],
				onDelete: "cascade",
			},
			{
				child: schema.webhookEndpoints,
				parent: schema.workspaces,
				columns: ["workspace_id", "organization_id"],
				onDelete: "restrict",
			},
		];

		for (const { child, parent, columns, onDelete } of cascadeRelations) {
			const matches = getTableConfig(child).foreignKeys.filter(
				(foreignKey) => foreignKey.reference().foreignTable === parent,
			);
			expect(matches).toHaveLength(1);
			expect(matches[0]?.onDelete).toBe(onDelete);
			expect(
				matches[0]?.reference().columns.map((column) => column.name),
			).toEqual(columns);
		}
	});

	it("does not keep unreferenced tenant-composite unique indexes", () => {
		const uniqueNames = Object.values(schema).flatMap((value) =>
			is(value, PgTable)
				? getTableConfig(value).uniqueConstraints.map(
						(constraint) => constraint.name,
					)
				: [],
		);

		expect(uniqueNames).not.toContain("ad_audiences_id_org_uniq");
		expect(uniqueNames).not.toContain("media_id_org_uniq");
		expect("whatsappBroadcasts" in schema).toBe(false);
		expect("whatsappBroadcastRecipients" in schema).toBe(false);
	});

	it("keeps deletion orchestration in the API and dashboard callers SDK-only", async () => {
		const repoRoot = new URL("../../../../", import.meta.url).pathname;
		const [adminSource, settingsSource, apiSource] = await Promise.all([
			Bun.file(
				`${repoRoot}apps/app/src/pages/api/admin/organizations.ts`,
			).text(),
			Bun.file(
				`${repoRoot}apps/app/src/components/dashboard/pages/settings-page.tsx`,
			).text(),
			Bun.file(`${repoRoot}apps/api/src/app.ts`).text(),
		]);
		const adminDelete = adminSource.slice(
			adminSource.indexOf("export const DELETE"),
		);

		expect(adminDelete).toContain(
			"client.organizations.delete(organizationId)",
		);
		expect(adminDelete).not.toContain(".delete(organization)");
		expect(adminDelete).not.toContain(".delete(member)");
		expect(adminDelete).not.toContain(".delete(organizationSubscriptions)");
		expect(settingsSource).toContain("/api/organizations/");
		expect(settingsSource).not.toContain("orgClient.delete(");
		expect(apiSource).toContain(
			'app.route("/v1/organizations", organizations)',
		);
	});

	it("stages subscription cancellation once and drains it independently of held purge", async () => {
		const repoRoot = new URL("../../../../", import.meta.url).pathname;
		const [tenantDeletionSource, billingOutboxSource] = await Promise.all([
			Bun.file(`${repoRoot}apps/api/src/services/tenant-deletion.ts`).text(),
			Bun.file(`${repoRoot}apps/api/src/services/billing-outbox.ts`).text(),
		]);

		expect(tenantDeletionSource).toContain("stageSubscriptionCancellation(");
		expect(tenantDeletionSource).toContain(
			"Waiting for subscription cancellation outbox",
		);
		expect(tenantDeletionSource).not.toContain("stripe.subscriptions.cancel(");
		expect(billingOutboxSource).toContain('"subscription.cancel"');
		expect(billingOutboxSource).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: matching source text
			"`tenant-delete:${organizationId}:subscription-cancel`",
		);
	});

	it("invalidates every deterministic tenant KV record at the deletion fence", async () => {
		const repoRoot = new URL("../../../../", import.meta.url).pathname;
		const [routeSource, deletionSource] = await Promise.all([
			Bun.file(`${repoRoot}apps/api/src/routes/organizations.ts`).text(),
			Bun.file(`${repoRoot}apps/api/src/services/tenant-deletion.ts`).text(),
		]);

		expect(routeSource).toContain("queue-schedule:");
		expect(routeSource).toContain("org-settings:");
		expect(routeSource).toContain("pending.accountCacheKeys.map");
		expect(routeSource).toContain("org-summary:");
		expect(deletionSource).toContain("buildAccountCacheKeys");
		expect(deletionSource).toContain("beforeCommitInvalidation");
	});

	it("stages workspace-owned phone resources through their exact source account", async () => {
		const repoRoot = new URL("../../../../", import.meta.url).pathname;
		const [source, workspaceErasure] = await Promise.all([
			Bun.file(
				`${repoRoot}apps/api/src/services/phone-number-operations.ts`,
			).text(),
			Bun.file(`${repoRoot}apps/api/src/services/workspace-erasure.ts`).text(),
		]);
		const helper = source.slice(
			source.indexOf("export async function stageWorkspacePhoneReleases"),
			source.indexOf("interface ReleaseClaim"),
		);
		const tenantHelper = source.slice(
			source.indexOf("export async function stageTenantPhoneReleases"),
			source.indexOf("export async function stageWorkspacePhoneReleases"),
		);

		expect(helper).toContain("provisioningSourceAccountId");
		expect(helper).toContain("socialAccounts.workspaceId");
		expect(helper).toContain(
			"isNull(whatsappPhoneReleaseOperations.releaseOperationId)",
		);
		expect(helper).toContain(
			'eq(whatsappPhoneReleaseOperations.releaseReason, "user_requested")',
		);
		expect(helper).toContain(
			'ne(whatsappPhoneReleaseOperations.releaseState, "completed")',
		);
		expect(helper).not.toContain(".limit(MAX_NUMBERS_PER_ORG)");
		expect(helper).not.toContain("whatsappPhoneNumbers.workspaceId");
		expect(helper).not.toContain("whatsappPhoneNumbers.socialAccountId");
		expect(tenantHelper).toContain(
			'eq(whatsappPhoneReleaseOperations.releaseReason, "user_requested")',
		);
		expect(tenantHelper).not.toContain(
			'ne(whatsappPhoneReleaseOperations.releaseReason, "tenant_deleted")',
		);
		const dueAndCount = source.slice(
			source.indexOf("export async function processDuePhoneReleases"),
			source.indexOf(
				"export async function redactExpiredPhoneProvisioningDetails",
			),
		);
		expect(dueAndCount).not.toContain(
			"whatsappPhoneReleaseOperations.releaseReason",
		);
		const batchHelper = workspaceErasure.slice(
			workspaceErasure.indexOf(
				"async function stageWorkspacePhoneReleaseBatch",
			),
			workspaceErasure.indexOf("async function getWorkspaceExternalState"),
		);
		expect(batchHelper).toContain(
			'eq(whatsappPhoneReleaseOperations.releaseReason, "user_requested")',
		);
		expect(batchHelper).toContain(
			'ne(whatsappPhoneReleaseOperations.releaseState, "completed")',
		);

		const processor = workspaceErasure.slice(
			workspaceErasure.indexOf(
				"async function processWorkspaceExternalResources",
			),
			workspaceErasure.indexOf("async function deleteAccountDependentBatch"),
		);
		const phoneStage = processor.indexOf("stageWorkspacePhoneReleaseBatch(");
		const phoneBatchReturn = processor.indexOf("if (stagedPhones > 0)");
		const accountStage = processor.indexOf("stageWorkspaceAccountRevocations(");
		expect(phoneStage).toBeGreaterThanOrEqual(0);
		expect(phoneBatchReturn).toBeGreaterThan(phoneStage);
		expect(accountStage).toBeGreaterThan(phoneBatchReturn);
	});
});
