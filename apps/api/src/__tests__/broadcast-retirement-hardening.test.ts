import { describe, expect, it } from "bun:test";
import * as schema from "@relayapi/db";
import { broadcastRecipients, broadcasts } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { broadcastFinalStatus } from "../services/broadcast-processor";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("broadcast subsystem retirement and fencing", () => {
	it("classifies persisted recipient outcomes without hiding unknown delivery", () => {
		expect(broadcastFinalStatus(3, 0, 0)).toBe("sent");
		expect(broadcastFinalStatus(0, 3, 0)).toBe("failed");
		expect(broadcastFinalStatus(2, 1, 0)).toBe("partially_failed");
		expect(broadcastFinalStatus(2, 0, 1)).toBe("requires_attention");
	});

	it("has one generic schema with revision/lease state and canonical recipient identity", () => {
		expect("whatsappBroadcasts" in schema).toBe(false);
		expect("whatsappBroadcastRecipients" in schema).toBe(false);
		expect(broadcasts.revision.notNull).toBe(true);
		expect(broadcasts.leaseToken.notNull).toBe(true);
		expect(broadcastRecipients.contactIdentifierHash.notNull).toBe(true);

		const broadcastConfig = getTableConfig(broadcasts);
		expect(
			broadcastConfig.checks.map((constraint) => constraint.name),
		).toContain("broadcasts_status_check");
		expect(
			broadcastConfig.checks.map((constraint) => constraint.name),
		).toContain("broadcasts_content_check");
		expect(broadcastConfig.indexes.map((index) => index.config.name)).toContain(
			"broadcasts_status_lease_idx",
		);

		const recipientConfig = getTableConfig(broadcastRecipients);
		expect(
			recipientConfig.checks.map((constraint) => constraint.name),
		).toContain("broadcast_recipients_status_delivery_check");
		const identity = recipientConfig.indexes.find(
			(index) => index.config.name === "broadcast_recipients_identity_uniq",
		);
		expect(identity?.config.unique).toBe(true);
		expect(
			identity?.config.columns.map((column) =>
				"name" in column ? column.name : null,
			),
		).toEqual([
			"broadcast_id",
			"organization_id",
			"scope_key",
			"contact_identifier_hash",
		]);
	});

	it("keeps WhatsApp bulk send on the generic tables and commits parent plus recipients atomically", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/routes/whatsapp.ts`,
		).text();
		expect(source).toContain('path: "/bulk-send"');
		expect(source).toContain("await db.transaction(async (tx) =>");
		expect(source).toContain("tx.insert(broadcastRecipients)");
		expect(source).toContain("scopeKey: broadcast.scopeKey");
		expect(source).not.toContain("whatsappListBroadcasts");
		expect(source).not.toContain("whatsappCreateBroadcast");
		expect(source).not.toContain('path: "/broadcasts"');
	});

	it("fences every processor phase by parent state, revision, lease, and active account", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/services/broadcast-processor.ts`,
		).text();
		expect(source).toContain("eq(broadcasts.revision, lease.revision)");
		expect(source).toContain("eq(broadcasts.leaseToken, lease.leaseToken)");
		expect(source).toContain("b.lease_expires_at > NOW()");
		expect(source).toContain("a.lifecycle_status = 'active'");
		expect(source).toContain(
			"a.token_version = $" + "{authorization.account.tokenVersion}",
		);
		expect(source).toContain("FOR UPDATE SKIP LOCKED");

		const finalization = source.slice(
			source.indexOf("async function finalizeOrRelease"),
		);
		expect(finalization).toContain('eq(broadcasts.status, "sending")');
		expect(finalization).toContain(".returning({ id: broadcasts.id })");
		expect(
			finalization.indexOf(".returning({ id: broadcasts.id })"),
		).toBeLessThan(finalization.indexOf("await notifyRealtime"));
	});

	it("uses transactions and revision predicates for surviving API mutations", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/routes/broadcasts.ts`,
		).text();
		expect(source).toContain("await db.transaction(async (tx) =>");
		expect(source).toContain("eq(broadcasts.revision, existing.revision)");
		expect(source).toContain("eq(broadcasts.revision, broadcast.revision)");
		expect(source).toContain("leaseExpiresAt: null");
		expect(source).toContain(
			'inArray(broadcasts.status, ["scheduled", "sending"])',
		);
		expect(source).toContain('status: "cancelled"');
		expect(source).toContain('deliveryState: "cancelled"');
		expect(source).toContain(
			'error: "Broadcast cancelled after the provider boundary"',
		);
		expect(source).toContain("inheritOperationalCreateScope(");
		expect(source).toContain("body.workspace_id,");
		expect(source).toContain("[account.workspaceId],");
		expect(source).toContain("account.workspaceId");
	});

	it("removes the retired surface from OpenAPI, SDK, dashboard, and cron", async () => {
		const [
			openapi,
			sdk,
			sdkIndex,
			dashboard,
			dashboardPage,
			genericCreateDialog,
			scheduled,
		] = await Promise.all([
			Bun.file(`${repoRoot}apps/docs/openapi.json`).json() as Promise<{
				paths: Record<string, unknown>;
			}>,
			Bun.file(
				`${repoRoot}packages/sdk/src/resources/whatsapp/whatsapp.ts`,
			).text(),
			Bun.file(
				`${repoRoot}packages/sdk/src/resources/whatsapp/index.ts`,
			).text(),
			Bun.file(
				`${repoRoot}apps/app/src/components/dashboard/pages/whatsapp-page.tsx`,
			).text(),
			Bun.file(`${repoRoot}apps/app/src/pages/app/whatsapp.astro`).text(),
			Bun.file(
				`${repoRoot}apps/app/src/components/dashboard/campaigns/broadcasts-create-dialog.tsx`,
			).text(),
			Bun.file(`${repoRoot}apps/api/src/scheduled/index.ts`).text(),
		]);

		expect(openapi.paths["/v1/whatsapp/broadcasts"]).toBeUndefined();
		expect(
			openapi.paths["/v1/whatsapp/broadcasts/{broadcast_id}"],
		).toBeUndefined();
		expect(openapi.paths["/v1/whatsapp/bulk-send"]).toBeDefined();
		expect(sdk).not.toContain("BroadcastsAPI");
		expect(sdk).not.toContain("broadcasts:");
		expect(sdkIndex).not.toContain("./broadcasts");
		expect(
			await Bun.file(
				`${repoRoot}packages/sdk/src/resources/whatsapp/broadcasts.ts`,
			).exists(),
		).toBe(false);
		expect(dashboard).not.toContain('activeTab === "broadcasts"');
		expect(dashboardPage).not.toContain('"broadcasts"');
		expect(genericCreateDialog).toContain("createDraftWithRecipients");
		expect(genericCreateDialog).toContain("contact_ids:");
		expect(genericCreateDialog).toContain('accountPlatform === "whatsapp"');
		expect(genericCreateDialog).toContain("templateName");
		expect(genericCreateDialog).toContain(
			'const action = scheduleEnabled ? "schedule" : "send"',
		);
		expect(scheduled).not.toContain("processScheduledWhatsAppBroadcasts");
	});
});
