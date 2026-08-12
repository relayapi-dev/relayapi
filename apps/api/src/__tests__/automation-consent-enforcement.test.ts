import { describe, expect, it } from "bun:test";
import {
	contactChannels,
	contactConsentEvents,
	contactConsentStates,
	type Database,
} from "@relayapi/db";
import { subscriptionHandlers } from "../services/automations/actions/subscription";
import type { RunContext } from "../services/automations/types";
import {
	getAllowedRecipientHashes,
	hashRecipientIdentifier,
} from "../services/contact-consent";
import { protectedContactChannelFieldsFixture } from "./helpers/protected-contact-fixtures";

interface ConsentMemory {
	state: {
		logicalIdentifierHash: string;
		identifierHash: string;
		identifierKeyVersion: string;
		identityKeyFingerprint: string;
		status: "granted" | "denied";
	} | null;
	recipients?: Array<{
		id: string;
		organizationId: string;
		identifierCiphertext: string;
		identifierHash: string;
		identityKeyFingerprint: string;
		workspaceId: string;
	}>;
	eventIdentifierHashes?: string[];
}

const TEST_ENCRYPTION_KEY = `active=${"a".repeat(64)},identity=${"b".repeat(64)}`;

async function protectedRecipient(id: string, identifier: string) {
	return {
		id,
		organizationId: "org_1",
		workspaceId: "ws_1",
		...(await protectedContactChannelFieldsFixture(
			{ id, organizationId: "org_1", identifier },
			TEST_ENCRYPTION_KEY,
		)),
	};
}

function queryResult(rows: () => unknown[]) {
	const builder = {
		innerJoin: () => builder,
		where: () => builder,
		orderBy: () => builder,
		limit: async (limit: number) => rows().slice(0, limit),
		// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
		then: (
			resolve: (value: unknown[]) => unknown,
			reject?: (reason: unknown) => unknown,
		) => Promise.resolve(rows()).then(resolve, reject),
	};
	return builder;
}

function consentDb(memory: ConsentMemory): Database {
	const db = {
		select: () => ({
			from: (table: unknown) =>
				queryResult(() => {
					if (table === contactChannels) {
						return memory.recipients ?? [];
					}
					if (table === contactConsentStates) {
						return memory.state ? [memory.state] : [];
					}
					return [];
				}),
		}),
		selectDistinct: () => ({
			from: () =>
				queryResult(() =>
					memory.state
						? [
								{
									identityKeyFingerprint: memory.state.identityKeyFingerprint,
								},
							]
						: [],
				),
		}),
		insert: (table: unknown) => {
			let value: Record<string, unknown> = {};
			const chain = {
				values: (next: Record<string, unknown>) => {
					value = next;
					return chain;
				},
				onConflictDoUpdate: () => {
					if (table === contactConsentStates) {
						memory.state = {
							logicalIdentifierHash: String(value.logicalIdentifierHash),
							identifierHash: String(value.identifierHash),
							identifierKeyVersion: String(value.identifierKeyVersion),
							identityKeyFingerprint: String(value.identityKeyFingerprint),
							status: value.status as "granted" | "denied",
						};
					}
					return chain;
				},
				returning: async () => {
					if (table === contactConsentEvents) {
						memory.eventIdentifierHashes?.push(String(value.identifierHash));
						return [
							{
								...value,
								scopeKey: value.workspaceId
									? `ws/${String(value.workspaceId)}`
									: "org",
							},
						];
					}
					if (table === contactConsentStates) {
						memory.state = {
							logicalIdentifierHash: String(value.logicalIdentifierHash),
							identifierHash: String(value.identifierHash),
							identifierKeyVersion: String(value.identifierKeyVersion),
							identityKeyFingerprint: String(value.identityKeyFingerprint),
							status: value.status as "granted" | "denied",
						};
						return [memory.state];
					}
					return [{ ...value }];
				},
				// biome-ignore lint/suspicious/noThenProperty: Drizzle mutation builders are intentionally awaitable.
				then: (
					resolve: (value: unknown) => unknown,
					reject?: (reason: unknown) => unknown,
				) => Promise.resolve(undefined).then(resolve, reject),
			};
			return chain;
		},
		execute: async () => {},
		transaction: async (callback: (tx: unknown) => unknown) => callback(db),
	};
	return db as unknown as Database;
}

function context(db: Database): RunContext {
	return {
		runId: "arun_1",
		automationId: "auto_1",
		organizationId: "org_1",
		workspaceId: "ws_1",
		contactId: "ct_1",
		conversationId: null,
		channel: "whatsapp",
		graph: { schema_version: 1, root_node_key: null, nodes: [], edges: [] },
		context: {},
		now: new Date("2026-07-13T12:00:00.000Z"),
		db,
		env: { ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
	};
}

describe("automation consent actions feed send-time enforcement", () => {
	it("records channel-wide consent for every matching contact identifier", async () => {
		const memory: ConsentMemory = {
			state: null,
			recipients: await Promise.all([
				protectedRecipient("cc_1", "+44 7700 900123"),
				protectedRecipient("cc_2", "+44 7700 900456"),
			]),
			eventIdentifierHashes: [],
		};
		const ctx = context(consentDb(memory));

		await subscriptionHandlers.opt_in_channel?.(
			{
				id: "action_all",
				type: "opt_in_channel",
				channel: "whatsapp",
				on_error: "abort",
			} as never,
			ctx,
		);

		expect(new Set(memory.eventIdentifierHashes).size).toBe(2);
	});

	it("allows after opt-in and suppresses the same recipient after opt-out", async () => {
		const memory: ConsentMemory = {
			state: null,
			recipients: [await protectedRecipient("cc_1", "+44 7700 900123")],
		};
		const db = consentDb(memory);
		const ctx = context(db);
		const recipient = "+44 7700 900123";
		const recipientHash = await hashRecipientIdentifier(
			TEST_ENCRYPTION_KEY,
			"org_1",
			"whatsapp",
			"automation",
			recipient,
		);

		await subscriptionHandlers.opt_in_channel?.(
			{
				id: "action_in",
				type: "opt_in_channel",
				channel: "whatsapp",
				on_error: "abort",
			} as never,
			ctx,
		);
		const allowedAfterOptIn = await getAllowedRecipientHashes(
			db,
			TEST_ENCRYPTION_KEY,
			"org_1",
			"whatsapp",
			"automation",
			[{ identifier: recipient, contactId: "ct_1" }],
		);
		expect(allowedAfterOptIn).toEqual(new Set([recipientHash]));

		await subscriptionHandlers.opt_out_channel?.(
			{
				id: "action_out",
				type: "opt_out_channel",
				channel: "whatsapp",
				on_error: "abort",
			} as never,
			ctx,
		);
		const allowedAfterOptOut = await getAllowedRecipientHashes(
			db,
			TEST_ENCRYPTION_KEY,
			"org_1",
			"whatsapp",
			"automation",
			[{ identifier: recipient, contactId: "ct_1" }],
		);
		expect(allowedAfterOptOut.size).toBe(0);
		expect(memory.state?.status).toBe("denied");
		expect(memory.state?.logicalIdentifierHash).toBe(recipientHash);
	});
});
