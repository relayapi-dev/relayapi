/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
	apikey,
	ideaActivity,
	ideaComments,
	ideas,
	inviteTokens,
	inviteTokenWorkspaces,
	member,
	organizationPrincipals,
	principalWorkspaceGrants,
	workspaces,
} from "./schema";

function columns(
	table: PgTable,
	foreignTable: PgTable,
): Array<{ local: string[]; foreign: string[]; name: string | undefined }> {
	return getTableConfig(table)
		.foreignKeys.filter(
			(foreignKey) => foreignKey.reference().foreignTable === foreignTable,
		)
		.map((foreignKey) => {
			const reference = foreignKey.reference();
			return {
				local: reference.columns.map((column) => column.name),
				foreign: reference.foreignColumns.map((column) => column.name),
				name: reference.name,
			};
		});
}

test("organization authority uses tenant-safe principal and workspace grant FKs", () => {
	expect(columns(organizationPrincipals, member)).toContainEqual({
		local: ["member_id", "organization_id"],
		foreign: ["id", "organizationId"],
		name: "organization_principals_member_org_fk",
	});
	expect(
		columns(principalWorkspaceGrants, organizationPrincipals),
	).toContainEqual({
		local: ["principal_id", "organization_id", "scope_mode"],
		foreign: ["id", "organization_id", "scope_mode"],
		name: "principal_workspace_grants_selected_principal_fk",
	});
	expect(columns(principalWorkspaceGrants, workspaces)).toContainEqual({
		local: ["workspace_id", "organization_id"],
		foreign: ["id", "organization_id"],
		name: "principal_workspace_grants_workspace_org_fk",
	});
	expect(columns(apikey, organizationPrincipals)).toContainEqual({
		local: ["principalId", "organizationId"],
		foreign: ["id", "organization_id"],
		name: "apikey_principal_org_fk",
	});
	const memberPrincipalFk = getTableConfig(
		organizationPrincipals,
	).foreignKeys.find(
		(foreignKey) =>
			foreignKey.reference().name === "organization_principals_member_org_fk",
	);
	expect(memberPrincipalFk?.onDelete).toBe("no action");
});

test("idea attribution is stable, tenant-safe, and parent-bound", () => {
	expect(columns(ideaComments, ideas)).toContainEqual({
		local: ["idea_id", "organization_id"],
		foreign: ["id", "organization_id"],
		name: "idea_comments_idea_org_fk",
	});
	expect(columns(ideaComments, organizationPrincipals)).toContainEqual({
		local: ["author_principal_id", "organization_id"],
		foreign: ["id", "organization_id"],
		name: "idea_comments_author_principal_org_fk",
	});
	expect(columns(ideaComments, ideaComments)).toContainEqual({
		local: ["parent_id", "idea_id", "organization_id"],
		foreign: ["id", "idea_id", "organization_id"],
		name: "idea_comments_parent_idea_org_fk",
	});
	expect(columns(ideaActivity, ideas)).toContainEqual({
		local: ["idea_id", "organization_id"],
		foreign: ["id", "organization_id"],
		name: "idea_activity_idea_org_fk",
	});
	expect(columns(ideaActivity, organizationPrincipals)).toContainEqual({
		local: ["actor_principal_id", "organization_id"],
		foreign: ["id", "organization_id"],
		name: "idea_activity_actor_principal_org_fk",
	});
	expect(
		getTableConfig(ideaComments).columns.map((column) => column.name),
	).not.toContain("author_id");
	expect(
		getTableConfig(ideaActivity).columns.map((column) => column.name),
	).not.toContain("actor_id");
});

test("invite scope evidence is normalized and tenant-safe", () => {
	const tokenColumns = getTableConfig(inviteTokens).columns.map(
		(column) => column.name,
	);
	expect(tokenColumns).not.toContain("scoped_workspace_ids");
	expect(tokenColumns).toEqual(
		expect.arrayContaining([
			"created_by_principal_id",
			"issuer_credential_version",
			"scope_mode",
			"used",
			"used_by",
			"redeemed_by_user_id",
			"used_at",
		]),
	);
	expect(columns(inviteTokens, organizationPrincipals)).toContainEqual({
		local: ["created_by_principal_id", "organization_id"],
		foreign: ["id", "organization_id"],
		name: "invite_tokens_issuer_principal_org_fk",
	});
	expect(columns(inviteTokenWorkspaces, inviteTokens)).toContainEqual({
		local: ["invite_token_id", "organization_id", "scope_mode"],
		foreign: ["id", "organization_id", "scope_mode"],
		name: "invite_token_workspaces_selected_token_fk",
	});
	expect(columns(inviteTokenWorkspaces, workspaces)).toContainEqual({
		local: ["workspace_id", "organization_id"],
		foreign: ["id", "organization_id"],
		name: "invite_token_workspaces_workspace_org_fk",
	});
});

test("invite consumption and expiry are constrained rather than conventional", () => {
	const config = getTableConfig(inviteTokens);
	expect(config.checks.map((constraint) => constraint.name)).toEqual(
		expect.arrayContaining([
			"invite_tokens_hash_check",
			"invite_tokens_consumption_tuple_check",
			"invite_tokens_expiry_window_check",
			"invite_tokens_used_timestamp_order_check",
		]),
	);
	const used = config.columns.find((column) => column.name === "used");
	expect(used?.generated).toBeDefined();

	const principalChecks = getTableConfig(organizationPrincipals).checks.map(
		(constraint) => constraint.name,
	);
	expect(principalChecks).toEqual(
		expect.arrayContaining([
			"organization_principals_identity_tuple_check",
			"organization_principals_lifecycle_check",
			"organization_principals_scope_mode_check",
		]),
	);
});
