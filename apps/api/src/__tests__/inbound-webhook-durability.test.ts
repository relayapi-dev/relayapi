import { beforeEach, describe, expect, it, mock } from "bun:test";
import { decryptToken } from "../lib/crypto";

const ENCRYPTION_KEY = `active=${"31".repeat(32)}`;
const columns = (...names: string[]) =>
	Object.fromEntries(names.map((name) => [name, { name }]));

let conflict = false;
let existing: { id: string; status: string; redactedAt: Date | null } | null =
	null;
let persisted: Record<string, unknown> | null = null;
const queued: unknown[] = [];

const db = {
	insert: () => ({
		values: (values: Record<string, unknown>) => {
			persisted = values;
			return {
				onConflictDoNothing: () => ({
					returning: async () => (conflict ? [] : [{ id: String(values.id) }]),
				}),
			};
		},
	}),
	select: () => ({
		from: () => ({
			where: () => ({ limit: async () => (existing ? [existing] : []) }),
		}),
	}),
	update: () => ({
		set: () => ({ where: async () => undefined }),
	}),
};

mock.module("@relayapi/db", () => ({
	createDb: () => db,
	generateId: () => "iwe_test",
	inboundWebhookEvents: columns(
		"id",
		"provider",
		"deliveryKey",
		"status",
		"redactedAt",
	),
}));

const { acceptInboundWebhook } = await import(
	"../services/inbound-webhook-acceptance"
);

function env() {
	return {
		ENCRYPTION_KEY,
		HYPERDRIVE: { connectionString: "postgres://test" },
		INBOX_QUEUE: {
			send: async (message: unknown) => {
				queued.push(message);
			},
		},
	} as never;
}

describe("raw inbound webhook durability", () => {
	beforeEach(() => {
		conflict = false;
		existing = null;
		persisted = null;
		queued.length = 0;
	});

	it("persists only context-bound ciphertext with a bounded unresolved TTL", async () => {
		const before = Date.now();
		const id = await acceptInboundWebhook(env(), {
			provider: "meta",
			payload: '{"secret":"must-not-be-plaintext"}',
			contentType: "application/json",
		});

		expect(id).toBe("iwe_test");
		expect(persisted).not.toBeNull();
		const row = persisted as unknown as {
			payloadCiphertext: string;
			payloadKeyId: string;
			receivedAt: Date;
			expiresAt: Date;
		};
		expect(row.payloadCiphertext).toStartWith("enc:v2:active:");
		expect(row.payloadCiphertext).not.toContain("must-not-be-plaintext");
		expect(row.payloadKeyId).toBe("active");
		expect(
			await decryptToken(row.payloadCiphertext, ENCRYPTION_KEY, {
				recordId: "iwe_test",
				field: "payload_ciphertext",
			}),
		).toBe('{"secret":"must-not-be-plaintext"}');
		expect(row.receivedAt.getTime()).toBeGreaterThanOrEqual(before);
		expect(row.expiresAt.getTime() - row.receivedAt.getTime()).toBe(
			30 * 24 * 60 * 60 * 1000,
		);
		expect(queued).toEqual([
			{
				type: "raw_platform_webhook",
				receipt_id: "iwe_test",
				received_at: expect.any(String),
			},
		]);
	});

	it("does not resurrect a redacted duplicate delivery", async () => {
		conflict = true;
		existing = {
			id: "iwe_existing",
			status: "failed",
			redactedAt: new Date(),
		};

		const id = await acceptInboundWebhook(env(), {
			provider: "meta",
			payload: "same-body",
		});

		expect(id).toBe("iwe_existing");
		expect(queued).toHaveLength(0);
	});
});
