import { beforeEach, describe, expect, it, mock } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { decryptToken, encryptToken } from "../lib/crypto";

const dbModule = await import("../../../../packages/db/src/index");

type Receipt = {
	id: string;
	organizationId: string;
	automationId: string;
	entrypointId: string;
	requestDigest: string;
	signatureTimestamp: string;
	payloadCiphertext: string;
	status: string;
	attempts: number;
	leaseToken: number;
	nextAttemptAt: Date;
	leaseExpiresAt: Date | null;
	runId: string | null;
	lastError: string | null;
	receivedAt: Date;
	expiresAt: Date;
	completedAt: Date | null;
};

type EnrollmentArgs = {
	triggerOccurrenceId?: string | null;
	contextOverrides?: Record<string, unknown>;
	deferRun?: boolean;
};

type State = {
	receipts: Receipt[];
	enrollmentArgs: EnrollmentArgs[];
};

const ENCRYPTION_KEY = `test=${"11".repeat(32)}`;
const NOW = new Date();
const WEBHOOK_ENTRYPOINT_ID = "aep_webhook";
const WEBHOOK_SECRET = "durability-secret";
const WEBHOOK_SECRET_CIPHERTEXT = await encryptToken(
	WEBHOOK_SECRET,
	ENCRYPTION_KEY,
	{ recordId: WEBHOOK_ENTRYPOINT_ID, field: "webhook_secret" },
);
const WRONG_ENTRYPOINT_CIPHERTEXT = await encryptToken(
	WEBHOOK_SECRET,
	ENCRYPTION_KEY,
	{ recordId: "aep_other", field: "webhook_secret" },
);
const match = {
	entrypoint: {
		id: WEBHOOK_ENTRYPOINT_ID,
		automationId: "auto_webhook",
		channel: "telegram",
		kind: "webhook_inbound",
		status: "active",
		socialAccountId: null,
		config: {
			webhook_slug: "durable-hook",
			webhook_secret: WEBHOOK_SECRET_CIPHERTEXT,
			contact_lookup: {
				by: "contact_id",
				field_path: "$.contact_id",
			},
		},
		specificity: 30,
		createdAt: NOW,
		updatedAt: NOW,
	},
	automation: {
		id: "auto_webhook",
		organizationId: "org_webhook",
		workspaceId: "ws_webhook",
		name: "Durable webhook",
		channel: "telegram",
		status: "active",
		graph: null,
		createdAt: NOW,
		updatedAt: NOW,
	},
};

let state: State;
let activeDb: ReturnType<typeof makeDb>;
let nextReceiptId = 1;
let enrollmentImpl: (args: EnrollmentArgs) => Promise<{ runId: string }>;

function cloneReceipt(receipt: Receipt): Receipt {
	return { ...receipt };
}

function conditionParams(condition: unknown): Map<string, unknown[]> {
	const found = new Map<string, unknown[]>();
	const seen = new WeakSet<object>();
	const visit = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		if (seen.has(value)) return;
		seen.add(value);
		const candidate = value as {
			constructor?: { name?: string };
			encoder?: { name?: string };
			value?: unknown;
			queryChunks?: unknown[];
		};
		if (candidate.constructor?.name === "Param" && candidate.encoder?.name) {
			const values = found.get(candidate.encoder.name) ?? [];
			values.push(candidate.value);
			found.set(candidate.encoder.name, values);
			return;
		}
		for (const chunk of candidate.queryChunks ?? []) visit(chunk);
	};
	visit(condition);
	return found;
}

class Chain<T> implements PromiseLike<T> {
	private promise: Promise<T> | null = null;

	constructor(private readonly execute: () => T | Promise<T>) {}

	from(_table: unknown): this {
		return this;
	}

	innerJoin(_table: unknown, _condition: unknown): this {
		return this;
	}

	where(_condition: unknown): this {
		return this;
	}

	orderBy(..._columns: unknown[]): this {
		return this;
	}

	limit(_limit: number): this {
		return this;
	}

	onConflictDoNothing(_config?: unknown): this {
		return this;
	}

	returning(_selection?: unknown): this {
		return this;
	}

	// biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable.
	then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): PromiseLike<TResult1 | TResult2> {
		this.promise ??= Promise.resolve().then(this.execute);
		return this.promise.then(onfulfilled, onrejected);
	}
}

function makeDb() {
	return {
		query: {
			automationWebhookReceipts: {
				findFirst: async () => state.receipts[0],
			},
			contacts: {
				findFirst: async () => ({
					id: "ct_webhook",
					organizationId: match.automation.organizationId,
				}),
			},
			workspaces: { findFirst: async () => null },
			customFieldDefinitions: { findFirst: async () => null },
			customFieldValues: { findFirst: async () => null },
		},
		select: (selection?: unknown) => {
			let source: unknown;
			const chain = new Chain<unknown[]>(() => {
				if (source === dbModule.automationWebhookReceipts) {
					const now = new Date();
					return state.receipts
						.filter(
							(receipt) =>
								receipt.expiresAt > now &&
								((["pending", "failed"].includes(receipt.status) &&
									receipt.nextAttemptAt <= now) ||
									(receipt.status === "processing" &&
										receipt.leaseExpiresAt !== null &&
										receipt.leaseExpiresAt <= now)),
						)
						.map(cloneReceipt);
				}
				return selection ? [match] : [];
			}) as Chain<unknown[]> & { from(table: unknown): typeof chain };
			chain.from = (table: unknown) => {
				source = table;
				return chain;
			};
			return chain;
		},
		insert: (table: unknown) => ({
			values: (values: Record<string, unknown>) =>
				new Chain<Receipt[]>(() => {
					if (table !== dbModule.automationWebhookReceipts) return [];
					const duplicate = state.receipts.find(
						(receipt) =>
							receipt.entrypointId === values.entrypointId &&
							receipt.requestDigest === values.requestDigest,
					);
					if (duplicate) return [];
					const receivedAt = new Date();
					const receipt: Receipt = {
						id: String(values.id),
						organizationId: String(values.organizationId),
						automationId: String(values.automationId),
						entrypointId: String(values.entrypointId),
						requestDigest: String(values.requestDigest),
						signatureTimestamp: String(values.signatureTimestamp),
						payloadCiphertext: String(values.payloadCiphertext),
						status: "pending",
						attempts: 0,
						leaseToken: 0,
						nextAttemptAt: receivedAt,
						leaseExpiresAt: null,
						runId: null,
						lastError: null,
						receivedAt,
						expiresAt: values.expiresAt as Date,
						completedAt: null,
					};
					state.receipts.push(receipt);
					return [cloneReceipt(receipt)];
				}),
		}),
		update: (table: unknown) => ({
			set: (patch: Record<string, unknown>) => {
				let condition: unknown;
				const chain = new Chain<Receipt[]>(() => {
					if (table !== dbModule.automationWebhookReceipts) return [];
					const params = conditionParams(condition);
					const expectedId = params.get("id")?.[0];
					const receipt = state.receipts.find(
						(row) => expectedId === undefined || row.id === expectedId,
					);
					if (!receipt) return [];

					if (patch.status === "processing") {
						const expectedLease = params.get("lease_token")?.[0];
						if (
							typeof expectedLease === "number" &&
							receipt.leaseToken !== expectedLease
						) {
							return [];
						}
						const now = new Date();
						const eligible =
							(["pending", "failed"].includes(receipt.status) &&
								receipt.nextAttemptAt <= now) ||
							(receipt.status === "processing" &&
								receipt.leaseExpiresAt !== null &&
								receipt.leaseExpiresAt <= now);
						if (!eligible) return [];
						receipt.status = "processing";
						receipt.attempts += 1;
						receipt.leaseToken += 1;
						receipt.leaseExpiresAt = patch.leaseExpiresAt as Date;
						receipt.lastError = null;
						return [cloneReceipt(receipt)];
					}

					const expectedLease = params.get("lease_token")?.[0];
					if (
						receipt.status !== "processing" ||
						typeof expectedLease !== "number" ||
						receipt.leaseToken !== expectedLease
					) {
						return [];
					}
					Object.assign(receipt, patch);
					return [cloneReceipt(receipt)];
				}) as Chain<Receipt[]> & { where(value: unknown): typeof chain };
				chain.where = (value: unknown) => {
					condition = value;
					return chain;
				};
				return chain;
			},
		}),
	};
}

mock.module("@relayapi/db", () => ({
	...dbModule,
	createDb: () => activeDb,
	generateId: () => `awhr_${nextReceiptId++}`,
}));

mock.module("../services/automations/runner", () => ({
	enrollContact: async (_db: unknown, args: EnrollmentArgs) => {
		state.enrollmentArgs.push(args);
		return enrollmentImpl(args);
	},
}));

const { receiveAutomationWebhook, reconcileAutomationWebhookReceipts } =
	await import("../services/automations/webhook-receiver");

async function hmacHex(secret: string, signedPayload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(signedPayload),
	);
	return Array.from(new Uint8Array(signature), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function signedRequest(body: string) {
	const timestampHeader = Math.floor(Date.now() / 1000).toString();
	const signature = await hmacHex(WEBHOOK_SECRET, `${timestampHeader}.${body}`);
	return { timestampHeader, signature };
}

function reconciliationEnv() {
	return {
		HYPERDRIVE: { connectionString: "postgres://unit.test/relay" },
		ENCRYPTION_KEY,
	} as never;
}

beforeEach(() => {
	state = { receipts: [], enrollmentArgs: [] };
	activeDb = makeDb();
	nextReceiptId = 1;
	enrollmentImpl = async () => ({ runId: "arun_1" });
	match.entrypoint.config.webhook_secret = WEBHOOK_SECRET_CIPHERTEXT;
});

describe("automation webhook durable receipts", () => {
	it("fails closed for missing, unwrapped, or malformed secret ciphertext", async () => {
		const rawBody = JSON.stringify({ contact_id: "ct_webhook" });
		const { timestampHeader, signature } = await signedRequest(rawBody);
		const config = match.entrypoint.config as Record<string, unknown>;

		for (const invalid of [
			undefined,
			WEBHOOK_SECRET,
			"enc:v2:malformed",
			WRONG_ENTRYPOINT_CIPHERTEXT,
		]) {
			config.webhook_secret = invalid;
			const result = await receiveAutomationWebhook(
				activeDb as never,
				{
					slug: "durable-hook",
					rawBody,
					signatureHeader: `sha256=${signature}`,
					timestampHeader,
				},
				{ ENCRYPTION_KEY },
			);
			expect(result.status).toBe("bad_signature");
		}
		expect(state.receipts).toHaveLength(0);
	});

	it("stores only authenticated ciphertext and can decrypt it with receipt-bound AAD", async () => {
		const rawBody = JSON.stringify({
			contact_id: "ct_webhook",
			private_token: "must-not-be-plaintext",
		});
		const { timestampHeader, signature } = await signedRequest(rawBody);

		const result = await receiveAutomationWebhook(
			activeDb as never,
			{
				slug: "durable-hook",
				rawBody,
				signatureHeader: `sha256=${signature}`,
				timestampHeader,
			},
			{ ENCRYPTION_KEY },
		);

		expect(result.status).toBe("ok");
		expect(state.receipts).toHaveLength(1);
		const receipt = state.receipts[0];
		expect(receipt?.payloadCiphertext).toStartWith("enc:v2:");
		expect(receipt?.payloadCiphertext).not.toContain("must-not-be-plaintext");
		expect(
			await decryptToken(receipt?.payloadCiphertext ?? "", ENCRYPTION_KEY, {
				recordId: receipt?.id ?? "",
				field: "payload",
			}),
		).toBe(rawBody);
	});

	it("retries a failed enrollment from the encrypted receipt with the same occurrence id", async () => {
		let attempts = 0;
		enrollmentImpl = async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient enrollment failure");
			return { runId: "arun_recovered" };
		};
		const rawBody = JSON.stringify({
			contact_id: "ct_webhook",
			event: "retry",
		});
		const { timestampHeader, signature } = await signedRequest(rawBody);

		const first = await receiveAutomationWebhook(
			activeDb as never,
			{
				slug: "durable-hook",
				rawBody,
				signatureHeader: signature,
				timestampHeader,
			},
			{ ENCRYPTION_KEY },
		);
		expect(first.status).toBe("enrollment_failed");
		const receipt = state.receipts[0];
		expect(receipt?.status).toBe("failed");
		if (!receipt) throw new Error("receipt was not persisted");
		receipt.nextAttemptAt = new Date(Date.now() - 1);

		expect(
			await reconcileAutomationWebhookReceipts(reconciliationEnv(), 1),
		).toBe(1);
		expect(receipt.status).toBe("succeeded");
		expect(receipt.runId).toBe("arun_recovered");
		expect(receipt.attempts).toBe(2);
		expect(
			state.enrollmentArgs.map((args) => args.triggerOccurrenceId),
		).toEqual([receipt.id, receipt.id]);
		expect(state.enrollmentArgs[1]?.contextOverrides?.webhookBody).toEqual(
			JSON.parse(rawBody),
		);
	});

	it("recovers an expired crash lease and fences a stale worker completion", async () => {
		const receiptId = "awhr_crashed";
		const rawBody = JSON.stringify({
			contact_id: "ct_webhook",
			event: "crash",
		});
		state.receipts.push({
			id: receiptId,
			organizationId: match.automation.organizationId,
			automationId: match.automation.id,
			entrypointId: match.entrypoint.id,
			requestDigest: "a".repeat(64),
			signatureTimestamp: Math.floor(Date.now() / 1000).toString(),
			payloadCiphertext: await encryptToken(rawBody, ENCRYPTION_KEY, {
				recordId: receiptId,
				field: "payload",
			}),
			status: "processing",
			attempts: 1,
			leaseToken: 1,
			nextAttemptAt: new Date(Date.now() - 5_000),
			leaseExpiresAt: new Date(Date.now() - 1),
			runId: null,
			lastError: null,
			receivedAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
			completedAt: null,
		});
		const receipt = state.receipts[0];
		if (!receipt) throw new Error("receipt fixture missing");

		// Simulate a newer worker stealing the lease while this worker is inside
		// enrollment. The first worker's terminal write must affect zero rows.
		enrollmentImpl = async () => {
			receipt.leaseToken += 1;
			receipt.leaseExpiresAt = new Date(Date.now() + 60_000);
			return { runId: "arun_stable" };
		};
		expect(
			await reconcileAutomationWebhookReceipts(reconciliationEnv(), 1),
		).toBe(0);
		expect(receipt.status).toBe("processing");
		expect(receipt.runId).toBeNull();

		// Once the newer lease expires, recovery uses the same stable occurrence;
		// the runner's unique occurrence key resolves to the existing run.
		receipt.leaseExpiresAt = new Date(Date.now() - 1);
		enrollmentImpl = async () => ({ runId: "arun_stable" });
		expect(
			await reconcileAutomationWebhookReceipts(reconciliationEnv(), 1),
		).toBe(1);
		expect(receipt.status).toBe("succeeded");
		expect(receipt.runId).toBe("arun_stable");
		expect(
			state.enrollmentArgs.map((args) => args.triggerOccurrenceId),
		).toEqual([receiptId, receiptId]);
	});

	it("deduplicates equivalent encodings of the same authenticated occurrence", async () => {
		const rawBody = JSON.stringify({ contact_id: "ct_webhook", event: "once" });
		const { timestampHeader, signature } = await signedRequest(rawBody);
		const first = await receiveAutomationWebhook(
			activeDb as never,
			{
				slug: "durable-hook",
				rawBody,
				signatureHeader: `sha256=${signature}`,
				timestampHeader,
			},
			{ ENCRYPTION_KEY },
		);
		const duplicate = await receiveAutomationWebhook(
			activeDb as never,
			{
				slug: "durable-hook",
				rawBody,
				signatureHeader: signature.toUpperCase(),
				timestampHeader,
			},
			{ ENCRYPTION_KEY },
		);

		expect(first.status).toBe("ok");
		expect(duplicate.status).toBe("duplicate");
		expect(state.receipts).toHaveLength(1);
		expect(state.enrollmentArgs).toHaveLength(1);
		expect(state.enrollmentArgs[0]?.deferRun).toBe(true);
	});
});

describe("automation run occurrence contract", () => {
	it("has a unique automation/occurrence index and conflict-resume path", async () => {
		const occurrenceIndex = getTableConfig(
			dbModule.automationRuns,
		).indexes.find(
			(index) =>
				index.config.name === "idx_automation_runs_trigger_occurrence_uniq",
		);
		expect(occurrenceIndex?.config.unique).toBe(true);
		expect(
			occurrenceIndex?.config.columns.map((column) =>
				"name" in column ? column.name : undefined,
			),
		).toEqual(["automation_id", "trigger_occurrence_id"]);

		const source = await Bun.file(
			new URL("../services/automations/runner.ts", import.meta.url),
		).text();
		expect(source).toMatch(
			/target:\s*\[\s*automationRuns\.automationId,\s*automationRuns\.triggerOccurrenceId,?\s*\]/,
		);
		expect(source).toContain("if (!inserted && args.triggerOccurrenceId)");
		expect(source).toContain(
			"eq(automationRuns.triggerOccurrenceId, args.triggerOccurrenceId)",
		);
		expect(source).toContain("if (args.deferRun)");
		expect(source).toContain("initial-trigger:");
		expect(source).toContain("args.triggerOccurrenceId");
		expect(source).toContain(".onConflictDoNothing()");
	});
});
