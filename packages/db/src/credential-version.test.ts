/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { renderAuthIdentityInvariantSql } from "../scripts/render-auth-identity-invariant-sql";
import { LEGACY_CREDENTIAL_VERSION } from "./credential-version";
import { apikey, invitation, inviteTokens, user } from "./schema";

test("user and API-key credential generations retain their compatibility shape", () => {
	const userVersion = getTableConfig(user).columns.find(
		(column) => column.name === "credentialVersion",
	);
	const keyVersion = getTableConfig(apikey).columns.find(
		(column) => column.name === "credentialVersion",
	);
	const inviteIssuerVersion = getTableConfig(inviteTokens).columns.find(
		(column) => column.name === "issuer_credential_version",
	);
	const organizationInviteIssuerVersion = getTableConfig(
		invitation,
	).columns.find((column) => column.name === "issuerCredentialVersion");
	const invitationIndexes = getTableConfig(invitation).indexes.map(
		(index) => index.config.name,
	);

	expect(LEGACY_CREDENTIAL_VERSION).toBe("legacy-v1");
	expect(userVersion?.notNull).toBe(true);
	expect(userVersion?.default).toBe(LEGACY_CREDENTIAL_VERSION);
	expect(keyVersion?.notNull).toBe(false);
	expect(inviteIssuerVersion?.notNull).toBe(true);
	expect(inviteIssuerVersion?.default).toBe(LEGACY_CREDENTIAL_VERSION);
	expect(organizationInviteIssuerVersion?.notNull).toBe(true);
	expect(organizationInviteIssuerVersion?.default).toBe(
		LEGACY_CREDENTIAL_VERSION,
	);
	expect(invitationIndexes).toContain("invitation_inviter_status_idx");
});

test("the ban rotator covers every inactive-to-active ban transition", () => {
	const sql = renderAuthIdentityInvariantSql();

	expect(sql).toContain("SET search_path = pg_catalog, auth");
	expect(sql).toContain("TG_OP = 'INSERT'");
	expect(sql).toContain("NEW.banned IS TRUE");
	expect(sql).toContain('OLD."banExpires" <= statement_timestamp()');
	expect(sql).toContain('NEW."credentialVersion" := gen_random_uuid()::text;');
	expect(sql).toContain('BEFORE INSERT OR UPDATE OF "banned", "banExpires"');
	expect(sql).toContain("FOR UPDATE SKIP LOCKED");
	expect(sql).toContain(
		'BEFORE INSERT OR UPDATE OF "status", "inviterId", "issuerCredentialVersion"',
	);
	expect(sql).toContain('BEFORE DELETE OR UPDATE OF "role", "organizationId"');
	expect(sql).toContain("ERRCODE = '40001'");
});
