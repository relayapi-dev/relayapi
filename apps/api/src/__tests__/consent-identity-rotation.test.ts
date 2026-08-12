import { describe, expect, it } from "bun:test";
import {
	contactConsentEvents,
	contactConsentStates,
	type Database,
} from "@relayapi/db";
import {
	deriveConsentIdentifierIdentity,
	parseConsentHmacKeyRing,
} from "../lib/consent-hmac";
import {
	CONTACT_CONSENT_ORDERING_REGION,
	ConsentIdentityKeyMismatchError,
	getAllowedRecipientHashes,
	nextConsentOrderingHlc,
	recordContactConsent,
	rotateContactConsentAuthority,
} from "../services/contact-consent";

const IDENTITY_KEY = "b".repeat(64);
const ORIGINAL_KEY_CONFIG = `v1=${"a".repeat(64)},identity=${IDENTITY_KEY}`;
const ROTATED_KEY_CONFIG = `v2=${"c".repeat(64)},identity=${IDENTITY_KEY},v1=${"a".repeat(64)}`;
const REPLACED_IDENTITY_CONFIG = `v2=${"c".repeat(64)},identity=${"d".repeat(64)},v1=${"a".repeat(64)}`;

interface AuthorityState {
	id: string;
	organizationId: string;
	workspaceId: string | null;
	channel: string;
	purpose: string;
	logicalIdentifierHash: string;
	identifierHash: string;
	identifierKeyVersion: string;
	identityKeyFingerprint: string;
	status: "granted" | "denied";
	source: string;
	occurredAt: Date;
	lastEventId: string;
	lastOrderingHlc: bigint;
	lastOrderingRegion: string;
	updatedAt: Date;
}

interface AuthorityMemory {
	activeVersion: string;
	events: Array<Record<string, unknown>>;
	states: AuthorityState[];
}

function queryBuilder(rows: () => unknown[]) {
	let selectedLimit: number | undefined;
	const result = () =>
		selectedLimit === undefined ? rows() : rows().slice(0, selectedLimit);
	const builder = {
		innerJoin: () => builder,
		where: () => builder,
		orderBy: () => builder,
		limit: (limit: number) => {
			selectedLimit = limit;
			return builder;
		},
		for: async () => result(),
		// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
		then: (
			resolve: (value: unknown[]) => unknown,
			reject?: (reason: unknown) => unknown,
		) => Promise.resolve(result()).then(resolve, reject),
	};
	return builder;
}

function authorityDb(memory: AuthorityMemory): Database {
	let stateId = 0;
	const db = {
		selectDistinct: (selection: Record<string, unknown>) => ({
			from: (table: unknown) =>
				queryBuilder(() => {
					if (table !== contactConsentStates) return [];
					const fingerprints = new Map(
						memory.states.map((state) => [
							`${state.organizationId}:${state.identityKeyFingerprint}`,
							state,
						]),
					);
					return [...fingerprints.values()].map((state) =>
						"organizationId" in selection
							? {
									organizationId: state.organizationId,
									identityKeyFingerprint: state.identityKeyFingerprint,
								}
							: {
									identityKeyFingerprint: state.identityKeyFingerprint,
								},
					);
				}),
		}),
		select: (selection: Record<string, unknown>) => ({
			from: (table: unknown) =>
				queryBuilder(() => {
					if (table === contactConsentEvents) {
						return [...memory.events]
							.sort((left, right) => {
								const leftHlc = left.orderingHlc as bigint;
								const rightHlc = right.orderingHlc as bigint;
								return leftHlc === rightHlc
									? String(right.id).localeCompare(String(left.id))
									: leftHlc < rightHlc
										? 1
										: -1;
							})
							.map((event) => ({
								orderingHlc: event.orderingHlc,
							}));
					}
					if (table !== contactConsentStates) return [];
					if ("value" in selection) {
						return [
							{
								value: memory.states.filter(
									(state) =>
										state.identifierKeyVersion !== memory.activeVersion,
								).length,
							},
						];
					}
					if ("id" in selection && "identifierKeyVersion" in selection) {
						return memory.states.filter(
							(state) => state.identifierKeyVersion !== memory.activeVersion,
						);
					}
					return memory.states;
				}),
		}),
		insert: (table: unknown) => {
			let values: Record<string, unknown> = {};
			let conflictSet: Record<string, unknown> | undefined;
			const chain = {
				values: (next: Record<string, unknown>) => {
					values = next;
					return chain;
				},
				onConflictDoUpdate: (options: { set: Record<string, unknown> }) => {
					conflictSet = options.set;
					return chain;
				},
				returning: async () => {
					if (table === contactConsentEvents) {
						const event = {
							...values,
							scopeKey: values.workspaceId
								? `ws/${String(values.workspaceId)}`
								: "org",
						};
						memory.events.push(event);
						return [event];
					}
					if (table !== contactConsentStates) return [];
					let state = memory.states.find(
						(row) =>
							row.organizationId === values.organizationId &&
							row.channel === values.channel &&
							row.purpose === values.purpose &&
							row.logicalIdentifierHash === values.logicalIdentifierHash,
					);
					if (state) {
						Object.assign(state, conflictSet ?? values);
					} else {
						stateId += 1;
						state = {
							id: `ccs_${stateId}`,
							updatedAt: new Date(),
							...values,
						} as AuthorityState;
						memory.states.push(state);
					}
					return [state];
				},
			};
			return chain;
		},
		update: (table: unknown) => {
			let values: Record<string, unknown> = {};
			const chain = {
				set: (next: Record<string, unknown>) => {
					values = next;
					return chain;
				},
				where: () => chain,
				returning: async () => {
					if (table !== contactConsentStates || !memory.states[0]) return [];
					Object.assign(memory.states[0], values);
					return [{ id: memory.states[0].id }];
				},
			};
			return chain;
		},
		execute: async () => [],
		transaction: async (callback: (transaction: unknown) => unknown) =>
			callback(db),
	};
	return db as unknown as Database;
}

function emptyMemory(activeVersion = "v1"): AuthorityMemory {
	return {
		activeVersion,
		events: [],
		states: [],
	};
}

async function denyPhone(db: Database, contactId: string | null = "ct_old") {
	return recordContactConsent(db, ORIGINAL_KEY_CONFIG, {
		organizationId: "org_1",
		workspaceId: "ws_1",
		contactId,
		channel: " SMS ",
		purpose: " Marketing ",
		identifier: "+1 (415) 555-0100",
		status: "denied",
		source: "test",
		occurredAt: new Date("2026-07-27T12:00:00.000Z"),
	});
}

describe("versioned consent identity authority", () => {
	it("allocates a monotonic physical/logical tuple in the home region", () => {
		const now = new Date("2026-07-28T12:00:00.000Z");
		const first = nextConsentOrderingHlc(now, null);
		expect(first).toBe(BigInt(now.getTime()) << 16n);
		expect(nextConsentOrderingHlc(now, first)).toBe(first + 1n);
		expect(
			nextConsentOrderingHlc(new Date(now.getTime() - 60_000), first + 10n),
		).toBe(first + 11n);
		expect(CONTACT_CONSENT_ORDERING_REGION).toBe("home");
	});

	it("canonicalizes dimensions and domain-separates stable identity by organization", async () => {
		const common = {
			channel: " SMS ",
			purpose: " Marketing ",
			normalizedIdentifier: "+14155550100",
		};
		const first = await deriveConsentIdentifierIdentity(ORIGINAL_KEY_CONFIG, {
			organizationId: "org_1",
			...common,
		});
		const equivalent = await deriveConsentIdentifierIdentity(
			ORIGINAL_KEY_CONFIG,
			{
				organizationId: "org_1",
				...common,
				channel: "sms",
				purpose: "marketing",
			},
		);
		const otherOrganization = await deriveConsentIdentifierIdentity(
			ORIGINAL_KEY_CONFIG,
			{ organizationId: "org_2", ...common },
		);

		expect(first.channel).toBe("sms");
		expect(first.purpose).toBe("marketing");
		expect(equivalent.logicalIdentifierHash).toBe(first.logicalIdentifierHash);
		expect(otherOrganization.logicalIdentifierHash).not.toBe(
			first.logicalIdentifierHash,
		);
	});

	it("preserves deny -> rotate -> grant under one canonical logical identity", async () => {
		const memory = emptyMemory();
		const db = authorityDb(memory);
		await denyPhone(db);
		const before = { ...memory.states[0] };
		expect(before.status).toBe("denied");

		memory.activeVersion = "v2";
		const rotation = await rotateContactConsentAuthority(
			db,
			ROTATED_KEY_CONFIG,
		);
		expect(rotation).toEqual({
			activeVersion: "v2",
			rewritten: 1,
			remaining: 0,
		});
		expect(memory.states[0]?.logicalIdentifierHash).toBe(
			before.logicalIdentifierHash,
		);
		expect(memory.states[0]?.identifierHash).not.toBe(before.identifierHash);
		expect(memory.states[0]?.identifierKeyVersion).toBe("v2");

		const whileDenied = await getAllowedRecipientHashes(
			db,
			ROTATED_KEY_CONFIG,
			"org_1",
			"sms",
			"marketing",
			[{ identifier: "14155550100", contactId: "ct_new" }],
			{ requireGrant: false },
		);
		expect(whileDenied.size).toBe(0);

		await recordContactConsent(db, ROTATED_KEY_CONFIG, {
			organizationId: "org_1",
			workspaceId: "ws_2",
			contactId: "ct_new",
			channel: "sms",
			purpose: "marketing",
			identifier: "14155550100",
			status: "granted",
			source: "test_grant",
			occurredAt: new Date("2026-07-27T12:05:00.000Z"),
		});
		const afterGrant = await getAllowedRecipientHashes(
			db,
			ROTATED_KEY_CONFIG,
			"org_1",
			"sms",
			"marketing",
			[{ identifier: "+1 415 555 0100", contactId: "ct_new" }],
		);
		const allowedHash = memory.states[0]?.logicalIdentifierHash;
		expect(allowedHash).toBeDefined();
		expect(afterGrant).toEqual(new Set([allowedHash as string]));
	});

	it("preserves deny -> rotate -> reimport as an absolute veto", async () => {
		const memory = emptyMemory();
		const db = authorityDb(memory);
		await denyPhone(db);
		const logicalIdentifierHash = memory.states[0]?.logicalIdentifierHash;

		// Current authority is identifier-owned, not contact-owned. The event
		// retains contact provenance, while the projection cannot be cascaded by
		// contact deletion or merge.
		expect(memory.events[0]?.contactId).toBe("ct_old");
		expect(memory.states[0]).not.toHaveProperty("contactId");

		memory.activeVersion = "v2";
		await rotateContactConsentAuthority(db, ROTATED_KEY_CONFIG);
		const reimported = await getAllowedRecipientHashes(
			db,
			ROTATED_KEY_CONFIG,
			"org_1",
			"SMS",
			"MARKETING",
			[{ identifier: "+1-415-555-0100", contactId: "ct_reimported" }],
			{ requireGrant: false },
		);

		expect(memory.states[0]?.logicalIdentifierHash).toBe(logicalIdentifierHash);
		expect(memory.states[0]?.status).toBe("denied");
		expect(reimported.size).toBe(0);
	});

	it("fails closed when identity material is removed, activated, or replaced", async () => {
		expect(() =>
			parseConsentHmacKeyRing(`v2=${"c".repeat(64)},v1=${"a".repeat(64)}`),
		).toThrow("must retain an identity");
		expect(() =>
			parseConsentHmacKeyRing(`identity=${IDENTITY_KEY},v2=${"c".repeat(64)}`),
		).toThrow("cannot be the active encryption key");

		const memory = emptyMemory();
		const db = authorityDb(memory);
		await denyPhone(db);
		await expect(
			getAllowedRecipientHashes(
				db,
				REPLACED_IDENTITY_CONFIG,
				"org_1",
				"sms",
				"marketing",
				[{ identifier: "+14155550100" }],
				{ requireGrant: false },
			),
		).rejects.toBeInstanceOf(ConsentIdentityKeyMismatchError);
	});

	it("uses a fenced, compare-and-swap rewrite and central authority on every send path", async () => {
		const repoRoot = new URL("../../../../", import.meta.url);
		const consentSource = await Bun.file(
			new URL("apps/api/src/services/contact-consent.ts", repoRoot),
		).text();
		expect(consentSource).toContain("return db.transaction(async (tx)");
		expect(consentSource).toContain('.for("update", { skipLocked: true })');
		expect(consentSource).toContain(
			"deriveConsentLookupHashFromLogical(keyConfig",
		);
		expect(consentSource).toContain(
			"contactConsentStates.identifierKeyVersion,\n\t\t\t\t\t\t\trow.identifierKeyVersion",
		);
		expect(consentSource).toContain(
			"contactConsentStates.identifierHash, row.identifierHash",
		);

		const sendPaths = new Map([
			[
				"apps/api/src/services/broadcast-processor.ts",
				"getAllowedRecipientHashes(",
			],
			[
				"apps/api/src/services/publisher-runner.ts",
				"getAllowedRecipientHashes(",
			],
			["apps/api/src/routes/whatsapp.ts", "getAllowedRecipientHashes("],
			["apps/api/src/routes/broadcasts.ts", "getAllowedRecipientHashes("],
			[
				"apps/api/src/services/automations/actions/main-menu.ts",
				"getAllowedRecipientHashes(",
			],
			[
				"apps/api/src/services/automations/nodes/message.ts",
				"getAllowedRecipientHashes(",
			],
			["apps/api/src/routes/inbox-feed.ts", "authorizeConversationReply("],
		]);
		for (const [path, authorityCall] of sendPaths) {
			expect(await Bun.file(new URL(path, repoRoot)).text()).toContain(
				authorityCall,
			);
		}
	});
});
