/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AUTH_IDENTITY_INVARIANT_CONTRACTS } from "../src/provisioning-contracts";
import { renderAuthIdentityInvariantSql } from "./render-auth-identity-invariant-sql";

test("renders every auth identity function and trigger from durable contracts", () => {
	const sql = renderAuthIdentityInvariantSql();
	for (const contract of Object.values(AUTH_IDENTITY_INVARIANT_CONTRACTS)) {
		expect(sql).toContain(
			`CREATE OR REPLACE FUNCTION "${contract.functionSchema}"."${contract.functionName}"()`,
		);
		expect(sql).toContain(`"${contract.triggerName}"`);
		expect(sql).toContain(
			`EXECUTE FUNCTION "${contract.functionSchema}"."${contract.functionName}"();`,
		);
	}
	expect(sql).toContain("SET search_path = pg_catalog, auth");
	expect(sql).toContain(
		'CREATE TRIGGER "enforce_active_member_user_before_insert"',
	);
	expect(sql).toContain('BEFORE INSERT ON "auth"."member"');
	expect(sql).toContain("members may only be added for active users");
	const activeMemberUserBranch = sql.slice(
		sql.indexOf("$relay_active_member_user$"),
		sql.indexOf("$relay_owner_invariant$"),
	);
	expect(activeMemberUserBranch).toContain("FOR SHARE;");
	expect(activeMemberUserBranch).toContain("statement_timestamp()");
	expect(sql).toContain("pg_advisory_xact_lock");
	expect(sql).toContain("public.organization_principals AS principal_row");
	expect(sql).toContain('key_row."principalId" = principal_row.id');
	expect(sql).toContain("SET lifecycle_status = 'disabled'");
	expect(sql).toContain("member_id = NULL");
	expect(sql).toContain(
		"DELETE FROM public.principal_workspace_grants AS grant_row",
	);
	expect(sql).not.toContain(
		"DELETE FROM public.organization_principals AS principal_row",
	);
	expect(sql).toContain("UPDATE auth.invitation AS invitation_row");
	expect(sql).toContain("SET status = 'canceled'");
	expect(sql).toContain("FOR UPDATE SKIP LOCKED");
	expect(sql).toContain(
		"invitation authority changed concurrently; retry membership mutation",
	);
	expect(sql).toContain("JOIN auth.member AS issuer_member");
	expect(sql).toContain(
		"FOR SHARE OF issuer_user, issuer_member, issuer_organization",
	);
	const acceptanceBranch = sql.slice(
		sql.indexOf("ELSIF OLD.status = 'pending' AND NEW.status = 'accepted'"),
		sql.indexOf("$relay_invitation_issuer_credential_generation$;"),
	);
	expect(acceptanceBranch).toContain('FROM auth."user" AS issuer_user');
	expect(acceptanceBranch).not.toContain("JOIN auth.member");
	const impersonationContract =
		AUTH_IDENTITY_INVARIANT_CONTRACTS.administratorImpersonationRevocation;
	const originatingSessionContract =
		AUTH_IDENTITY_INVARIANT_CONTRACTS.originatingSessionImpersonationRevocation;
	expect(sql).toContain(
		`CREATE OR REPLACE FUNCTION "${impersonationContract.functionSchema}"."${impersonationContract.functionName}"()`,
	);
	expect(sql).toContain(
		`CREATE TRIGGER "${impersonationContract.triggerName}"`,
	);
	expect(sql).toContain(
		'AFTER DELETE OR UPDATE OF "role", "banned", "banExpires"',
	);
	expect(sql).toContain("DELETE FROM auth.session AS impersonation_session");
	expect(sql).toContain(
		'WHERE impersonation_session."impersonatedBy" = actor_id;',
	);
	expect(sql).toContain(
		'WHERE impersonation_session."impersonatedBy" IS NOT NULL',
	);
	expect(sql).toContain(
		`CREATE OR REPLACE FUNCTION "${originatingSessionContract.functionSchema}"."${originatingSessionContract.functionName}"()`,
	);
	expect(sql).toContain(
		`CREATE TRIGGER "${originatingSessionContract.triggerName}"`,
	);
	expect(sql).toContain('AFTER DELETE ON "auth"."session"');
	expect(sql).toContain('IF OLD."impersonatedBy" IS NOT NULL THEN');
	expect(sql).toContain(
		'WHERE derived_impersonation_session."impersonatedBy" = OLD."userId";',
	);
	expect(sql).toContain(
		"Fail secure at rollout by clearing every row whose provenance cannot be proven.",
	);
	expect(sql).toContain("statement_timestamp()");

	const verifier = readFileSync(
		new URL("./verify-migrations.ts", import.meta.url),
		"utf8",
	);
	expect(verifier).toContain(
		"AUTH_IDENTITY_INVARIANT_CONTRACTS.activeMemberUser.triggerName",
	);
	expect(verifier).toContain("triggerType: BEFORE_INSERT_ROW");
	expect(verifier).toContain(
		"AUTH_IDENTITY_INVARIANT_CONTRACTS.administratorImpersonationRevocation",
	);
	expect(verifier).toContain("triggerType: AFTER_DELETE_OR_UPDATE_ROW");
	expect(verifier).toContain(
		".originatingSessionImpersonationRevocation.triggerName",
	);
	expect(verifier).toContain("triggerType: AFTER_DELETE_ROW");
});
