// Regression guard for POST /v1/contacts/bulk channel attribution.
//
// The bug: bulkCreate inserted a batch with .onConflictDoNothing().returning({id})
// and then zipped channels to contacts by array index (insertedIds[j] vs batch[j]).
// RETURNING only yields rows actually inserted — duplicates skipped by the
// scoped email blind-hash unique index are omitted — so after the first skipped row
// every later batch item was paired with the id of the NEXT contact's row, and the
// trailing items silently lost their channels. The fix pre-generates contact ids
// (generateId("ct_")) so each channel is matched to the exact contact row created
// for its source item, by set membership rather than position.

import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
	decryptContactRow,
	deriveContactChannelIdentifierHash,
	deriveContactEmailHash,
	deriveContactPhoneHash,
} from "../services/contact-protection";
import type { Env, Variables } from "../types";

const TEST_ENCRYPTION_KEY = `test=${"11".repeat(32)},identity=${"12".repeat(32)}`;

type InsertedContact = {
	id: string;
	organizationId: string;
	nameCiphertext: string | null;
	nameHash: string | null;
	nameSearchTokens: string[];
	emailCiphertext: string | null;
	emailHash: string | null;
	emailSearchTokens: string[];
	phoneCiphertext: string | null;
	phoneHash: string | null;
	phoneSearchTokens: string[];
	metadataCiphertext: string | null;
	searchIdentityKeyFingerprint: string;
};
type ChannelRow = {
	contactId: string;
	socialAccountId: string;
	platform: string;
	identifierHash: string;
};

// Stub Drizzle client. The contacts insert resolves only the rows whose email is
// NOT in `existingEmails` (simulating onConflictDoNothing skipping duplicates),
// preserving the client-supplied ids. The contactChannels insert records the
// values it was handed so the test can assert correct contact<->channel pairing.
function makeStubDb(
	existingEmailHashes: Set<string>,
	existingPhoneHashes: Set<string> = new Set(),
) {
	const capturedContactValues: InsertedContact[] = [];
	const capturedChannelValues: ChannelRow[] = [];

	// biome-ignore lint/suspicious/noExplicitAny: minimal query-builder stub
	function contactsInsert(values: any[]) {
		for (const v of values) {
			capturedContactValues.push(v);
		}
		const seenEmails = new Set(existingEmailHashes);
		const seenPhones = new Set(existingPhoneHashes);
		// biome-ignore lint/suspicious/noExplicitAny: chainable stub
		const chain: any = {
			values: () => chain,
			onConflictDoNothing: () => chain,
			returning: async () => {
				const inserted = [];
				for (const value of values) {
					if (
						(value.emailHash && seenEmails.has(value.emailHash)) ||
						(value.phoneHash && seenPhones.has(value.phoneHash))
					) {
						continue;
					}
					if (value.emailHash) seenEmails.add(value.emailHash);
					if (value.phoneHash) seenPhones.add(value.phoneHash);
					inserted.push({ id: value.id });
				}
				return inserted;
			},
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
		select: () => ({
			// biome-ignore lint/suspicious/noExplicitAny: drizzle table token
			from: (table: any) => {
				const tableName = table?.[Symbol.for("drizzle:Name")] ?? "";
				if (tableName === "social_accounts") {
					return {
						where: async () => [
							{
								id: "acc_2",
								platform: "whatsapp",
								workspaceId: "ws_test",
							},
							{
								id: "acc_3",
								platform: "instagram",
								workspaceId: "ws_test",
							},
						],
					};
				}
				// biome-ignore lint/suspicious/noExplicitAny: chainable stub
				const chain: any = {
					where: () => chain,
					for: () => chain,
					limit: async () =>
						tableName === "organization_settings"
							? [{ requireWorkspaceId: false, revision: 0 }]
							: [{ id: "ws_test", lifecycleStatus: "active" }],
				};
				return chain;
			},
		}),
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
		// biome-ignore lint/suspicious/noExplicitAny: transaction callback stub
		transaction: async (callback: (tx: any) => unknown) => callback(db),
	};

	return { db, capturedContactValues, capturedChannelValues };
}

async function makeApp(
	existingEmails: Set<string>,
	existingPhones: Set<string> = new Set(),
) {
	const { contactsRouter } = await import("../routes/contacts");
	const existingEmailHashes = new Set(
		await Promise.all(
			[...existingEmails].map((email) =>
				deriveContactEmailHash(TEST_ENCRYPTION_KEY, "org_test", email),
			),
		),
	);
	const existingPhoneHashes = new Set(
		(
			await Promise.all(
				[...existingPhones].map((phone) =>
					deriveContactPhoneHash(TEST_ENCRYPTION_KEY, "org_test", phone),
				),
			)
		).filter((hash): hash is string => hash !== null),
	);
	const { db, capturedContactValues, capturedChannelValues } = makeStubDb(
		existingEmailHashes,
		existingPhoneHashes,
	);

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
				{ ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } as unknown as Env,
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
		const [dupeHash, secondHash, thirdHash] = await Promise.all([
			deriveContactEmailHash(
				TEST_ENCRYPTION_KEY,
				"org_test",
				"dupe@example.com",
			),
			deriveContactEmailHash(
				TEST_ENCRYPTION_KEY,
				"org_test",
				"second@example.com",
			),
			deriveContactEmailHash(
				TEST_ENCRYPTION_KEY,
				"org_test",
				"third@example.com",
			),
		]);
		const idByEmailHash = new Map(
			capturedContactValues.map((c) => [c.emailHash, c.id]),
		);
		const secondId = idByEmailHash.get(secondHash);
		const thirdId = idByEmailHash.get(thirdHash);

		// Exactly two channels, each on the correct contact (no channel for the
		// skipped duplicate, none dropped from the trailing item).
		expect(capturedChannelValues).toHaveLength(2);
		const [whatsappHash, instagramHash] = await Promise.all([
			deriveContactChannelIdentifierHash(
				TEST_ENCRYPTION_KEY,
				"org_test",
				"+15551112222",
			),
			deriveContactChannelIdentifierHash(
				TEST_ENCRYPTION_KEY,
				"org_test",
				"ig_sender_3",
			),
		]);
		const byIdentifierHash = new Map(
			capturedChannelValues.map((ch) => [ch.identifierHash, ch]),
		);
		expect(byIdentifierHash.get(whatsappHash)?.contactId).toBe(secondId);
		expect(byIdentifierHash.get(instagramHash)?.contactId).toBe(thirdId);

		// The duplicate's contact id must never carry a channel.
		const dupeId = idByEmailHash.get(dupeHash);
		expect(capturedChannelValues.some((ch) => ch.contactId === dupeId)).toBe(
			false,
		);
	});

	it("normalizes phone variants before scoped duplicate skipping", async () => {
		const { capturedContactValues, post } = await makeApp(new Set());
		const res = await post({
			contacts: [
				{ name: "Formatted", phone: "+1 (415) 555-2671" },
				{ name: "Equivalent", phone: "001 415 555 2671" },
			],
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { created: number; skipped: number };
		expect(body).toEqual({ created: 1, skipped: 1 });
		const plaintext = await Promise.all(
			capturedContactValues.map((row) =>
				decryptContactRow(TEST_ENCRYPTION_KEY, row),
			),
		);
		expect(plaintext.map((row) => row.phone)).toEqual([
			"+1 (415) 555-2671",
			"001 415 555 2671",
		]);
		expect(capturedContactValues[0]?.phoneHash).toBe(
			capturedContactValues[1]?.phoneHash,
		);
	});
});
