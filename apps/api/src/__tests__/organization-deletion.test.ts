import { describe, expect, it } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../../../packages/db/src/schema";
import { canRequestTenantDeletion } from "../routes/organizations";
import {
	requestTenantDeletion,
	TENANT_PURGE_TABLES,
	TenantDeletionNotFoundError,
	tenantDeletionStepKeys,
} from "../services/tenant-deletion";

describe("organization deletion tenant authority", () => {
	it("allows an owner to delete their own organization", () => {
		expect(
			canRequestTenantDeletion({
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
				callerOrganizationId: "org_admin",
				targetOrganizationId: "org_customer",
				membershipRole: null,
				globalRole: "admin",
			}),
		).toBe(true);
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
		const expected = tables
			.filter(({ key, table }) => {
				if (
					key === "auth.organization" ||
					key === "public.tenant_deletion_jobs" ||
					key === "public.tenant_deletion_steps"
				) {
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
		expect(configured.has("public.tenant_deletion_jobs")).toBe(false);
		expect(configured.has("public.tenant_deletion_steps")).toBe(false);

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

	it("uses the database-enforceable member-to-advisory-to-organization lock order", async () => {
		const source = await Bun.file(
			`${new URL("../../../../", import.meta.url).pathname}apps/api/src/services/tenant-deletion.ts`,
		).text();
		const memberLock = source.indexOf("const lockedMemberships = await tx");
		const ownerAdvisoryLock = source.indexOf(
			"select pg_advisory_xact_lock(hashtext(",
			memberLock,
		);
		const organizationLock = source.indexOf(
			"const [org] = await tx",
			ownerAdvisoryLock,
		);
		const membershipRecheck = source.indexOf(
			"const currentMemberships = await tx",
			organizationLock,
		);

		expect(memberLock).toBeGreaterThan(-1);
		expect(ownerAdvisoryLock).toBeGreaterThan(memberLock);
		expect(organizationLock).toBeGreaterThan(ownerAdvisoryLock);
		expect(membershipRecheck).toBeGreaterThan(organizationLock);
		expect(source).toContain('isolationLevel: "read committed"');
		expect(source).toContain("TenantMembershipSetChangedError");
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
			requestTenantDeletion(db as never, "org_1", "user_1"),
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
				columns: ["segment_id", "organization_id", "scope_key"],
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

	it("invalidates every deterministic tenant KV record at the deletion fence", async () => {
		const repoRoot = new URL("../../../../", import.meta.url).pathname;
		const [routeSource, deletionSource] = await Promise.all([
			Bun.file(`${repoRoot}apps/api/src/routes/organizations.ts`).text(),
			Bun.file(`${repoRoot}apps/api/src/services/tenant-deletion.ts`).text(),
		]);

		expect(routeSource).toContain("queue-schedule:");
		expect(routeSource).toContain("org-settings:");
		expect(routeSource).toContain("result.accountCacheKeys.map");
		expect(deletionSource).toContain("buildAccountCacheKeys");
	});

	it("stages workspace-owned phone resources through their exact source account", async () => {
		const repoRoot = new URL("../../../../", import.meta.url).pathname;
		const source = await Bun.file(
			`${repoRoot}apps/api/src/services/phone-number-operations.ts`,
		).text();
		const helper = source.slice(
			source.indexOf("export async function stageWorkspacePhoneReleases"),
			source.indexOf("interface ReleaseClaim"),
		);

		expect(helper).toContain("provisioningSourceAccountId");
		expect(helper).toContain("socialAccounts.workspaceId");
		expect(helper).toContain("isNull(whatsappPhoneNumbers.releaseState)");
		expect(helper).not.toContain(".limit(MAX_NUMBERS_PER_ORG)");
		expect(helper).not.toContain("whatsappPhoneNumbers.workspaceId");
		expect(helper).not.toContain("whatsappPhoneNumbers.socialAccountId");
	});
});
