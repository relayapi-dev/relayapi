/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderAuthIdentityInvariantSql } from "./render-auth-identity-invariant-sql";

const migrationSql = readFileSync(
	new URL("../drizzle/0000_baseline.sql", import.meta.url),
	"utf8",
);

test("the reset baseline fences both API credentials and invitation authority", () => {
	const renderedIdentitySql = renderAuthIdentityInvariantSql();
	const activeMemberUserTriggerOffset = migrationSql.indexOf(
		'CREATE TRIGGER "enforce_active_member_user_before_insert"',
	);
	const triggerOffset = migrationSql.indexOf(
		'CREATE TRIGGER "rotate_user_credential_version_on_ban"',
	);

	expect(migrationSql).toContain(
		"\"credentialVersion\" text DEFAULT 'legacy-v1' NOT NULL",
	);
	expect(migrationSql).toContain('"credentialVersion" text');
	expect(migrationSql).toContain(
		'"issuerCredentialVersion" text DEFAULT \'legacy-v1\' NOT NULL',
	);
	expect(migrationSql).toContain(
		'"issuer_credential_version" text DEFAULT \'legacy-v1\' NOT NULL',
	);
	expect(migrationSql).toContain("SET search_path = pg_catalog, auth");
	expect(activeMemberUserTriggerOffset).toBeGreaterThan(0);
	expect(activeMemberUserTriggerOffset).toBeLessThan(triggerOffset);
	expect(migrationSql).toContain(
		'CREATE OR REPLACE FUNCTION "auth"."enforce_active_member_user"()',
	);
	expect(migrationSql).toContain('BEFORE INSERT ON "auth"."member"');
	expect(migrationSql).toContain(
		"MESSAGE = 'members may only be added for active users'",
	);
	expect(migrationSql).toContain("FOR SHARE;");
	const renderedFunctionStart = renderedIdentitySql.indexOf(
		'CREATE OR REPLACE FUNCTION "auth"."enforce_active_member_user"()',
	);
	const renderedFunctionEnd = renderedIdentitySql.indexOf(
		"--> statement-breakpoint",
		renderedFunctionStart,
	);
	const renderedTriggerStart = renderedIdentitySql.indexOf(
		'CREATE TRIGGER "enforce_active_member_user_before_insert"',
		renderedFunctionEnd,
	);
	const renderedTriggerEnd = renderedIdentitySql.indexOf(
		"--> statement-breakpoint",
		renderedTriggerStart,
	);
	expect(migrationSql).toContain(
		renderedIdentitySql
			.slice(renderedFunctionStart, renderedFunctionEnd)
			.trim(),
	);
	expect(migrationSql).toContain(
		renderedIdentitySql.slice(renderedTriggerStart, renderedTriggerEnd).trim(),
	);
	expect(triggerOffset).toBeGreaterThan(0);
	expect(migrationSql).toContain(renderedIdentitySql.trim());
	expect(migrationSql).toContain(
		'BEFORE INSERT OR UPDATE OF "banned", "banExpires"',
	);
	expect(migrationSql).toContain(
		'OLD."banExpires" IS NOT NULL AND OLD."banExpires" <= statement_timestamp()',
	);
	expect(migrationSql).toContain(
		'CREATE TRIGGER "enforce_invitation_issuer_credential_generation"',
	);
	expect(migrationSql).toContain(
		'CREATE TRIGGER "invalidate_member_invitation_authority"',
	);
	expect(migrationSql).toContain(
		'CREATE INDEX "invitation_inviter_status_idx"',
	);
	expect(migrationSql).toContain("FOR UPDATE SKIP LOCKED");
	expect(migrationSql).toContain("ERRCODE = '40001'");
	expect(migrationSql).not.toContain(
		"DELETE FROM auth.invitation AS invitation_row",
	);
});
