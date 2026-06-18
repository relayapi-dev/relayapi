// Regression guard for POST /v1/contacts/bulk channel attribution.
//
// The bug: bulkCreate inserted a batch with .onConflictDoNothing().returning({id})
// and then zipped channels to contacts by array index (insertedIds[j] vs batch[j]).
// RETURNING only yields rows actually inserted — duplicates skipped by the
// (workspace_id, email) unique index are omitted — so after the first skipped row
// every later batch item was paired with the id of the NEXT contact's row, and the
// trailing items silently lost their channels. The fix pre-generates contact ids
// (generateId("ct_")) so each channel is matched to the exact contact row created
// for its source item, by set membership rather than position.

import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env, Variables } from "../types";

type InsertedContact = { id: string; email: string | null };
type ChannelRow = {
	contactId: string;
	socialAccountId: string;
	platform: string;
	identifier: string;
};

// Stub Drizzle client. The contacts insert resolves only the rows whose email is
// NOT in `existingEmails` (simulating onConflictDoNothing skipping duplicates),
// preserving the client-supplied ids. The contactChannels insert records the
// values it was handed so the test can assert correct contact<->channel pairing.
function makeStubDb(existingEmails: Set<string>) {
	const capturedContactValues: InsertedContact[] = [];
	const capturedChannelValues: ChannelRow[] = [];

	// biome-ignore lint/suspicious/noExplicitAny: minimal query-builder stub
	function contactsInsert(values: any[]) {
		for (const v of values) {
			capturedContactValues.push({ id: v.id, email: v.email ?? null });
		}
		// biome-ignore lint/suspicious/noExplicitAny: chainable stub
		const chain: any = {
			values: () => chain,
			onConflictDoNothing: () => chain,
			returning: async () =>
				values
					.filter((v) => !v.email || !existingEmails.has(v.email))
					.map((v) => ({ id: v.id })),
		};
		return chain;
	}

	// biome-ignore lint/suspicious/noExplicitAny: minimal query-builder stub
	function channelsInsert(values: any[]) {
		for (const v of values) capturedChannelValues.push(v);
		// biome-ignore lint/suspicious/noExplicitAny: chainable stub
		const chain: any = {
			values: () => chain,
			onConflictDoNothing: async () => undefined,
		};
		return chain;
	}

	// First .values() call carries the rows; we route by which table .insert got.
	// Drizzle calls .insert(table).values(rows)..., so capture rows at .values().
	// biome-ignore lint/suspicious/noExplicitAny: minimal query-builder stub
	const db: any = {
		// biome-ignore lint/suspicious/noExplicitAny: drizzle table token
		insert: (table: any) => {
			const tableName = table?.[Symbol.for("drizzle:Name")] ?? "";
			return {
				// biome-ignore lint/suspicious/noExplicitAny: chainable stub
				values: (vals: any[]) =>
					tableName === "contact_channels"
						? channelsInsert(vals)
						: contactsInsert(vals),
			};
		},
	};

	return { db, capturedContactValues, capturedChannelValues };
}

async function makeApp(existingEmails: Set<string>) {
	const { contactsRouter } = await import("../routes/contacts");
	const { db, capturedContactValues, capturedChannelValues } =
		makeStubDb(existingEmails);

	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("orgId", "org_test");
		c.set("workspaceScope", "all");
		// biome-ignore lint/suspicious/noExplicitAny: stub db for route test
		c.set("db", db as any);
		await next();
	});
	app.route("/v1/contacts", contactsRouter);

	return {
		capturedContactValues,
		capturedChannelValues,
		// biome-ignore lint/suspicious/noExplicitAny: test body
		post: (body: any) =>
			app.request(
				"/v1/contacts/bulk",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
				{} as unknown as Env,
			),
	};
}

describe("POST /v1/contacts/bulk channel attribution", () => {
	it("attaches each channel to its own contact even when an earlier email is a duplicate", async () => {
		// First item's email already exists -> its contact row is skipped by the
		// unique index, shifting every positional pairing in the old code.
		const existing = new Set(["dupe@example.com"]);
		const { capturedContactValues, capturedChannelValues, post } =
			await makeApp(existing);

		const res = await post({
			workspace_id: "ws_test",
			contacts: [
				{ email: "dupe@example.com" }, // skipped duplicate, no channel
				{
					email: "second@example.com",
					account_id: "acc_2",
					platform: "whatsapp",
					identifier: "+15551112222",
				},
				{
					email: "third@example.com",
					account_id: "acc_3",
					platform: "instagram",
					identifier: "ig_sender_3",
				},
			],
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { created: number; skipped: number };
		// 3 supplied, 1 skipped as duplicate
		expect(body.created).toBe(2);
		expect(body.skipped).toBe(1);

		// Map the pre-generated contact ids by their email to assert pairing.
		const idByEmail = new Map(
			capturedContactValues.map((c) => [c.email, c.id]),
		);
		const secondId = idByEmail.get("second@example.com");
		const thirdId = idByEmail.get("third@example.com");

		// Exactly two channels, each on the correct contact (no channel for the
		// skipped duplicate, none dropped from the trailing item).
		expect(capturedChannelValues).toHaveLength(2);
		const byIdentifier = new Map(
			capturedChannelValues.map((ch) => [ch.identifier, ch]),
		);
		expect(byIdentifier.get("+15551112222")?.contactId).toBe(secondId);
		expect(byIdentifier.get("ig_sender_3")?.contactId).toBe(thirdId);

		// The duplicate's contact id must never carry a channel.
		const dupeId = idByEmail.get("dupe@example.com");
		expect(
			capturedChannelValues.some((ch) => ch.contactId === dupeId),
		).toBe(false);
	});
});
