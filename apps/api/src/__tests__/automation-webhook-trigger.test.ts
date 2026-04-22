// apps/api/src/__tests__/automation-webhook-trigger.test.ts
//
// Plan 4 / Unit RR3 — regression test for Bug 8: the custom_field contact
// lookup used `findFirst` without a value predicate, so when multiple contacts
// shared a custom field definition the receiver returned an arbitrary row and
// then post-filtered — meaning the wrong contact got enrolled.
//
// The fix pushes the value filter into SQL. This test ensures that when three
// contacts share the same custom field definition, a webhook carrying a
// specific value resolves to the correct contact.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationContactControls,
	automationEntrypoints,
	automationRuns,
	automations,
	contactChannels,
	contacts,
	createDb,
	customFieldDefinitions,
	customFieldValues,
	generateId,
	organization,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Graph } from "../schemas/automation-graph";
import { receiveAutomationWebhook } from "../services/automations/webhook-receiver";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
	"postgres://relayapi:z9scNsSByxEn8QC6Z6PDQLLSKLum3F@localhost:5433/relayapi?sslmode=disable";

const db = createDb(CONN);

let dbAvailable = false;
let orgId = "";
let workspaceId = "";

async function seedFixture() {
	orgId = generateId("org_");
	await db.insert(organization).values({
		id: orgId,
		name: "webhook-trigger-test-org",
		slug: `wh-test-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({ organizationId: orgId, name: "wh-test-ws" })
		.returning();
	if (!ws) throw new Error("workspace insert failed");
	workspaceId = ws.id;

	await db.insert(socialAccounts).values({
		organizationId: orgId,
		workspaceId,
		platform: "telegram",
		platformAccountId: `tg_${generateId("acc_")}`,
		displayName: "Webhook Test Bot",
	});
}

async function teardownFixture() {
	if (!orgId) return;
	await db
		.delete(automationRuns)
		.where(eq(automationRuns.organizationId, orgId));
	await db
		.delete(automationContactControls)
		.where(eq(automationContactControls.organizationId, orgId));
	await db
		.delete(customFieldValues)
		.where(eq(customFieldValues.organizationId, orgId));
	await db
		.delete(customFieldDefinitions)
		.where(eq(customFieldDefinitions.organizationId, orgId));
	await db.delete(automations).where(eq(automations.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await db
		.delete(socialAccounts)
		.where(eq(socialAccounts.organizationId, orgId));
	await db.delete(workspaces).where(eq(workspaces.organizationId, orgId));
	await db.delete(organization).where(eq(organization.id, orgId));
}

async function makeAutomation(name: string) {
	const graph: Graph = {
		schema_version: 1,
		root_node_key: "stop",
		nodes: [
			{
				key: "stop",
				kind: "end",
				config: {},
				ports: [{ key: "in", direction: "input" }],
			},
		],
		edges: [],
	};
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name,
			channel: "telegram",
			status: "active",
			graph: graph as never,
		})
		.returning();
	if (!auto) throw new Error("automation insert failed");
	return auto;
}

async function makeContact(name: string) {
	const [ct] = await db
		.insert(contacts)
		.values({ organizationId: orgId, workspaceId, name })
		.returning();
	if (!ct) throw new Error("contact insert failed");
	return ct;
}

async function hmacHex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(body),
	);
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

beforeAll(async () => {
	try {
		await seedFixture();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-webhook-trigger.test] DB unavailable — tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixture();
});

describe("receiveAutomationWebhook — custom_field contact lookup", () => {
	it("resolves to the contact whose custom field value matches the payload", async () => {
		if (!dbAvailable) return;

		// 1. Create a custom field definition.
		const [def] = await db
			.insert(customFieldDefinitions)
			.values({
				organizationId: orgId,
				workspaceId,
				slug: "external_id",
				name: "External ID",
				type: "text",
			})
			.returning();
		if (!def) throw new Error("definition insert failed");

		// 2. Create three contacts, each with a different external_id.
		const ctA = await makeContact("contact-A");
		const ctB = await makeContact("contact-B");
		const ctC = await makeContact("contact-C");

		await db.insert(customFieldValues).values([
			{
				organizationId: orgId,
				contactId: ctA.id,
				definitionId: def.id,
				value: "abc",
			},
			{
				organizationId: orgId,
				contactId: ctB.id,
				definitionId: def.id,
				value: "xyz",
			},
			{
				organizationId: orgId,
				contactId: ctC.id,
				definitionId: def.id,
				value: "def",
			},
		]);

		// 3. Register a webhook_inbound entrypoint that looks up contacts by
		//    the `external_id` field at `$.user_id`.
		const auto = await makeAutomation("webhook-cf-lookup");
		const slug = `slug-${generateId("").slice(-10)}`;
		const secret = "cf-lookup-secret";
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "telegram",
			kind: "webhook_inbound",
			status: "active",
			socialAccountId: null,
			config: {
				webhook_slug: slug,
				webhook_secret: secret,
				contact_lookup: {
					by: "custom_field",
					custom_field_key: "external_id",
					field_path: "$.user_id",
				},
			},
			specificity: 30,
		});

		// 4. Fire a webhook carrying user_id=xyz — contact B should be enrolled.
		const body = JSON.stringify({ user_id: "xyz" });
		const sig = await hmacHex(secret, body);
		const result = await receiveAutomationWebhook(
			db,
			{ slug, rawBody: body, signatureHeader: `sha256=${sig}` },
			{},
		);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			const run = await db.query.automationRuns.findFirst({
				where: eq(automationRuns.id, result.runId),
			});
			expect(run?.contactId).toBe(ctB.id);
		}
	});

	it("platform_id lookup scopes to the entrypoint's org and ignores other-org contacts", async () => {
		if (!dbAvailable) return;

		// Set up a second org with its own contact sharing the same platform_id
		// identifier as a contact in the primary org. The webhook (registered
		// against the primary org's automation) must only ever return the
		// primary-org contact — even though both contacts have identifier="abc123".
		const otherOrgId = generateId("org_");
		await db.insert(organization).values({
			id: otherOrgId,
			name: "other-org",
			slug: `other-${otherOrgId.slice(-8)}`,
		});
		try {
			const [otherWs] = await db
				.insert(workspaces)
				.values({ organizationId: otherOrgId, name: "other-ws" })
				.returning();
			if (!otherWs) throw new Error("other ws insert failed");

			const [otherSa] = await db
				.insert(socialAccounts)
				.values({
					organizationId: otherOrgId,
					workspaceId: otherWs.id,
					platform: "telegram",
					platformAccountId: `tg_${generateId("acc_")}`,
					displayName: "Other Bot",
				})
				.returning();
			if (!otherSa) throw new Error("other sa insert failed");

			const [primarySa] = await db
				.insert(socialAccounts)
				.values({
					organizationId: orgId,
					workspaceId,
					platform: "telegram",
					platformAccountId: `tg_${generateId("acc_")}`,
					displayName: "Primary Bot",
				})
				.returning();
			if (!primarySa) throw new Error("primary sa insert failed");

			const primaryContact = await makeContact("primary-contact");
			const [otherContact] = await db
				.insert(contacts)
				.values({
					organizationId: otherOrgId,
					workspaceId: otherWs.id,
					name: "other-contact",
				})
				.returning();
			if (!otherContact) throw new Error("other contact insert failed");

			// Both contacts have the same platform_id identifier "abc123" but on
			// their respective org-scoped social accounts.
			await db.insert(contactChannels).values([
				{
					contactId: primaryContact.id,
					socialAccountId: primarySa.id,
					platform: "telegram",
					identifier: "abc123",
				},
				{
					contactId: otherContact.id,
					socialAccountId: otherSa.id,
					platform: "telegram",
					identifier: "abc123",
				},
			]);

			const auto = await makeAutomation("webhook-platform-id-scope");
			const slug = `slug-${generateId("").slice(-10)}`;
			const secret = "platform-id-scope-secret";
			await db.insert(automationEntrypoints).values({
				automationId: auto.id,
				channel: "telegram",
				kind: "webhook_inbound",
				status: "active",
				socialAccountId: null,
				config: {
					webhook_slug: slug,
					webhook_secret: secret,
					contact_lookup: {
						by: "platform_id",
						field_path: "$.user_id",
						platform: "telegram",
					},
				},
				specificity: 30,
			});

			const body = JSON.stringify({ user_id: "abc123" });
			const sig = await hmacHex(secret, body);
			const result = await receiveAutomationWebhook(
				db,
				{ slug, rawBody: body, signatureHeader: `sha256=${sig}` },
				{},
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				const run = await db.query.automationRuns.findFirst({
					where: eq(automationRuns.id, result.runId),
				});
				expect(run?.contactId).toBe(primaryContact.id);
				expect(run?.contactId).not.toBe(otherContact.id);
			}
		} finally {
			// Explicit cleanup for the second org — not covered by teardownFixture.
			// contactChannels cascade-delete from contacts / socialAccounts, so
			// we just need to wipe contacts + socialAccounts + workspace + org.
			await db
				.delete(automationRuns)
				.where(eq(automationRuns.organizationId, otherOrgId));
			await db
				.delete(contacts)
				.where(eq(contacts.organizationId, otherOrgId));
			await db
				.delete(socialAccounts)
				.where(eq(socialAccounts.organizationId, otherOrgId));
			await db
				.delete(workspaces)
				.where(eq(workspaces.organizationId, otherOrgId));
			await db.delete(organization).where(eq(organization.id, otherOrgId));
		}
	});

	it("returns contact_lookup_failed when no contact matches the value", async () => {
		if (!dbAvailable) return;

		const [def] = await db
			.insert(customFieldDefinitions)
			.values({
				organizationId: orgId,
				workspaceId,
				slug: "other_id",
				name: "Other ID",
				type: "text",
			})
			.returning();
		if (!def) throw new Error("definition insert failed");

		const ct = await makeContact("contact-D");
		await db.insert(customFieldValues).values({
			organizationId: orgId,
			contactId: ct.id,
			definitionId: def.id,
			value: "present",
		});

		const auto = await makeAutomation("webhook-cf-miss");
		const slug = `slug-${generateId("").slice(-10)}`;
		const secret = "cf-miss-secret";
		await db.insert(automationEntrypoints).values({
			automationId: auto.id,
			channel: "telegram",
			kind: "webhook_inbound",
			status: "active",
			socialAccountId: null,
			config: {
				webhook_slug: slug,
				webhook_secret: secret,
				contact_lookup: {
					by: "custom_field",
					custom_field_key: "other_id",
					field_path: "$.user_id",
				},
			},
			specificity: 30,
		});

		const body = JSON.stringify({ user_id: "not-present" });
		const sig = await hmacHex(secret, body);
		const result = await receiveAutomationWebhook(
			db,
			{ slug, rawBody: body, signatureHeader: `sha256=${sig}` },
			{},
		);

		expect(result.status).toBe("contact_lookup_failed");
	});
});
