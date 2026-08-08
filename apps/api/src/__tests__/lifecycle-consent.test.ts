import { describe, expect, it } from "bun:test";
import {
	accountRevocationJobs,
	broadcastRecipients,
	contactConsentEvents,
	contactConsentStates,
	contactSubscriptions,
	contacts,
	socialAccounts,
	tenantDeletionJobs,
	workspaceErasureJobs,
	workspaces,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { RecipientResponse } from "../schemas/broadcasts";
import {
	hashRecipientIdentifier,
	isConsentOccurrenceTimeAllowed,
	normalizeRecipientIdentifier,
} from "../services/contact-consent";

function contactForeignKey(table: Parameters<typeof getTableConfig>[0]) {
	return getTableConfig(table).foreignKeys.find(
		(foreignKey) =>
			foreignKey.reference().foreignTable === contacts &&
			foreignKey
				.reference()
				.columns.some((column) => column.name === "contact_id"),
	);
}

describe("lifecycle and consent invariants", () => {
	it("keeps account and workspace lifecycle operations durable", () => {
		expect(socialAccounts.lifecycleStatus.default).toBe("active");
		expect(accountRevocationJobs.accountId.isUnique).toBe(true);
		expect(tenantDeletionJobs.organizationId.primary).toBe(true);
		expect(workspaces.lifecycleStatus.default).toBe("active");
		expect(workspaceErasureJobs.workspaceId.primary).toBe(true);
		expect(
			getTableConfig(workspaces).indexes.map((index) => index.config.name),
		).toContain("workspaces_org_lifecycle_idx");
	});

	it("deletes subscriptions and nulls historical recipient links with contacts", () => {
		expect(contactForeignKey(contactSubscriptions)?.onDelete).toBe("cascade");
		expect(contactForeignKey(broadcastRecipients)?.onDelete).toBe("set null");
	});

	it("defaults marketing opt-in conservatively and has durable consent projections", () => {
		expect(contacts.optedIn.default).toBe(false);
		expect(getTableConfig(contactConsentEvents).indexes.length).toBeGreaterThan(
			0,
		);
		expect(
			getTableConfig(contactConsentStates).indexes.some(
				(index) =>
					index.config.name === "contact_consent_states_identifier_idx" &&
					index.config.unique,
			),
		).toBe(true);
		expect(
			getTableConfig(contactConsentStates).columns.some(
				(column) => column.name === "contact_id",
			),
		).toBe(false);
		expect(contactForeignKey(contactConsentEvents)?.onDelete).toBe("set null");
	});

	it("uses one organization-global consent identity across workspace provenance", async () => {
		const identityColumns = (
			table: Parameters<typeof getTableConfig>[0],
			indexName: string,
		) =>
			getTableConfig(table)
				.indexes.find((index) => index.config.name === indexName)
				?.config.columns.map((column) => "name" in column && column.name);

		expect(
			identityColumns(
				contactConsentStates,
				"contact_consent_states_identifier_idx",
			),
		).toEqual([
			"organization_id",
			"channel",
			"purpose",
			"logical_identifier_hash",
		]);

		const [consentSource, replySource] = await Promise.all([
			Bun.file(
				new URL("../services/contact-consent.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL(
					"../services/conversation-reply-authorization.ts",
					import.meta.url,
				),
			).text(),
		]);
		const authorizationLookup = consentSource.slice(
			consentSource.indexOf("export async function getAllowedRecipientHashes"),
		);
		expect(authorizationLookup).not.toContain("scopeKey");
		expect(replySource).not.toContain("contactSuppressions");
		expect(consentSource).not.toContain("contactSuppressions");
	});

	it("accepts at most five minutes of future consent clock skew", async () => {
		const now = new Date("2026-07-15T12:00:00.000Z");
		expect(
			isConsentOccurrenceTimeAllowed(new Date("2026-07-15T12:05:00.000Z"), now),
		).toBe(true);
		expect(
			isConsentOccurrenceTimeAllowed(new Date("2026-07-15T12:05:00.001Z"), now),
		).toBe(false);

		const [routeSource, schemaSource] = await Promise.all([
			Bun.file(new URL("../routes/contacts.ts", import.meta.url)).text(),
			Bun.file(
				new URL("../../../../packages/db/src/schema.ts", import.meta.url),
			).text(),
		]);
		expect(routeSource).toContain("isConsentOccurrenceTimeAllowed(occurredAt)");
		expect(schemaSource).toContain("+ interval '5 minutes'");
	});

	it("projects explicit marketing opt-in and opt-out without a wildcard purpose", async () => {
		const source = await Bun.file(
			new URL("../routes/contacts.ts", import.meta.url),
		).text();
		expect(
			source.match(/status: body\.opted_in \? "granted" : "denied"/g),
		).toHaveLength(2);
		expect(source).toContain('"contact_global_opt_in"');
		expect(source).toContain('"contact_global_opt_out"');
		expect(source).not.toContain('purpose: "all"');
	});

	it("normalizes equivalent recipient identifiers to one consent identity", async () => {
		const keyConfig = `active=${"a".repeat(64)},identity=${"b".repeat(64)}`;
		expect(normalizeRecipientIdentifier("email", " User@Example.COM ")).toBe(
			"user@example.com",
		);
		expect(
			normalizeRecipientIdentifier("whatsapp", "+44 (0) 7700-900123"),
		).toBe("+447700900123");
		expect(
			await hashRecipientIdentifier(
				keyConfig,
				"org_1",
				"sms",
				"marketing",
				"+1 (415) 555-0100",
			),
		).toBe(
			await hashRecipientIdentifier(
				keyConfig,
				"org_1",
				"sms",
				"marketing",
				"14155550100",
			),
		);
	});

	it("records consent-blocked recipients in the existing failed status", async () => {
		const [broadcastSource, consentSource] = await Promise.all([
			Bun.file(
				new URL("../services/broadcast-processor.ts", import.meta.url),
			).text(),
			Bun.file(
				new URL("../services/contact-consent.ts", import.meta.url),
			).text(),
		]);

		expect(broadcastSource).not.toContain('status: "suppressed"');
		expect(consentSource).not.toContain("SET status = 'suppressed'");
		expect(
			RecipientResponse.safeParse({
				id: "recipient_1",
				contact_id: null,
				contact_identifier: "+14155550100",
				status: "failed",
				message_id: null,
				error: "Current channel/purpose consent is required",
				sent_at: null,
			}).success,
		).toBe(true);
	});

	it("does not rewrite an in-flight recipient as cancelled on withdrawal", async () => {
		const source = await Bun.file(
			new URL("../services/contact-consent.ts", import.meta.url),
		).text();
		expect(source).not.toContain("r.status IN ('pending', 'sending')");
		expect(source.match(/r\.status = 'pending'/g)).toHaveLength(1);
	});
});
