// apps/api/src/services/automations/webhook-receiver.ts
//
// Public webhook entry point for external-triggered automations (spec §6.7).
// Paired with the /v1/webhooks/automation-trigger/:slug route. Verifies HMAC,
// resolves a contact from the signed payload, then enrolls via the runner.

import {
	automationEntrypoints,
	automations,
	automationWebhookReceipts,
	contactChannels,
	contacts,
	createDb,
	customFieldDefinitions,
	customFieldValues,
	type Database,
	generateId,
	socialAccounts,
} from "@relayapi/db";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { maybeDecrypt, maybeEncrypt } from "../../lib/crypto";
import type { Env } from "../../types";
import { type InboundEvent, matchAndEnroll } from "./trigger-matcher";

export type Db = Database;

export type WebhookReceptionResult =
	| { status: "ok"; runId: string; automationId: string }
	| { status: "bad_signature" }
	| { status: "stale_timestamp" }
	| {
			status: "duplicate";
			receiptStatus: string;
			runId?: string;
	  }
	| { status: "unknown_slug" }
	| { status: "bad_payload"; error: string }
	| { status: "contact_lookup_failed"; reason?: string }
	| { status: "enrollment_blocked"; reason: string }
	| { status: "enrollment_failed"; error: string };

// Max accepted clock skew (seconds) between the caller-supplied
// X-Relay-Timestamp and server time. A request whose timestamp deviates by more
// than this is rejected as a replay / stale request. Mirrors Stripe's 5-minute
// tolerance.
const MAX_TIMESTAMP_SKEW_SECONDS = 300;
const WEBHOOK_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_RECEIPT_LEASE_MS = 15 * 60 * 1000;

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

// ---------------------------------------------------------------------------
// JSONPath extractor — minimal regex-based.
// ---------------------------------------------------------------------------

/**
 * Extracts a value from `obj` following a `$.`-rooted JSONPath. Supported:
 *   $                         — the root
 *   $.foo                     — object property
 *   $.foo.bar
 *   $.items[0]                — array index
 *   $.items[0].name
 *   $["key with spaces"]      — bracket quoted property
 */
export function extractByPath(obj: unknown, path: string): unknown {
	if (!path) return undefined;
	const trimmed = path.trim();
	if (trimmed === "$" || trimmed === "") return obj;
	if (!trimmed.startsWith("$")) return undefined;

	// Tokenize — split on `.` and `[...]` while preserving quoted keys.
	const tokens: Array<string | number> = [];
	let i = 1; // skip the leading '$'
	while (i < trimmed.length) {
		const ch = trimmed[i];
		if (ch === ".") {
			// dot-separated key
			let j = i + 1;
			while (j < trimmed.length && trimmed[j] !== "." && trimmed[j] !== "[") {
				j++;
			}
			const key = trimmed.slice(i + 1, j);
			if (key.length > 0) tokens.push(key);
			i = j;
		} else if (ch === "[") {
			const close = trimmed.indexOf("]", i);
			if (close === -1) return undefined;
			const inner = trimmed.slice(i + 1, close).trim();
			if (/^-?\d+$/.test(inner)) {
				tokens.push(Number(inner));
			} else if (
				(inner.startsWith('"') && inner.endsWith('"')) ||
				(inner.startsWith("'") && inner.endsWith("'"))
			) {
				tokens.push(inner.slice(1, -1));
			} else {
				tokens.push(inner);
			}
			i = close + 1;
		} else {
			// Tolerate weird characters by advancing
			i++;
		}
	}

	let cur: unknown = obj;
	for (const tok of tokens) {
		if (cur == null) return undefined;
		if (typeof tok === "number") {
			if (!Array.isArray(cur)) return undefined;
			cur = cur[tok];
		} else {
			if (typeof cur !== "object") return undefined;
			cur = (cur as Record<string, unknown>)[tok];
		}
	}
	return cur;
}

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array | null {
	const h = hex.trim();
	if (!/^[0-9a-fA-F]+$/.test(h) || h.length % 2 !== 0) return null;
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < h.length; i += 2) {
		out[i / 2] = Number.parseInt(h.slice(i, i + 2), 16);
	}
	return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	let diff = 0;
	for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

async function verifyHmacSha256(
	secret: string,
	rawBody: string,
	signatureHeader: string,
): Promise<boolean> {
	// Accept `sha256=<hex>` or raw hex.
	const trimmed = signatureHeader.trim();
	const hex = trimmed.startsWith("sha256=") ? trimmed.slice(7) : trimmed;
	const providedBytes = hexToBytes(hex);
	if (!providedBytes) return false;

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sigBuf = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(rawBody),
	);
	const expected = new Uint8Array(sigBuf);
	return constantTimeEqual(expected, providedBytes);
}

// ---------------------------------------------------------------------------
// Contact resolution
// ---------------------------------------------------------------------------

type ContactLookupConfig = {
	by: "email" | "phone" | "platform_id" | "custom_field" | "contact_id";
	field_path?: string;
	custom_field_key?: string;
	platform?: string;
	auto_create_contact?: boolean;
	default_workspace_id?: string;
};

async function resolveContact(
	db: Db,
	organizationId: string,
	body: unknown,
	cfg: ContactLookupConfig,
	scope: {
		workspaceId: string | null;
		socialAccountId: string | null;
		channel: string;
	},
): Promise<string | null> {
	const extract = (path?: string) =>
		path ? extractByPath(body, path) : undefined;
	const contactWorkspace = scope.workspaceId
		? eq(contacts.workspaceId, scope.workspaceId)
		: isNull(contacts.workspaceId);

	switch (cfg.by) {
		case "contact_id": {
			const id = extract(cfg.field_path);
			if (typeof id !== "string") return null;
			const row = await db.query.contacts.findFirst({
				where: and(
					eq(contacts.id, id),
					eq(contacts.organizationId, organizationId),
					contactWorkspace,
				),
			});
			return row?.id ?? null;
		}
		case "email": {
			const email = extract(cfg.field_path);
			if (typeof email !== "string") return null;
			const row = await db.query.contacts.findFirst({
				where: and(
					eq(contacts.emailCanonical, email.trim().toLowerCase()),
					eq(contacts.organizationId, organizationId),
					contactWorkspace,
				),
			});
			if (row) return row.id;
			if (cfg.auto_create_contact) {
				const [created] = await db
					.insert(contacts)
					.values({
						organizationId,
						workspaceId: scope.workspaceId,
						email,
					})
					.returning();
				return created?.id ?? null;
			}
			return null;
		}
		case "phone": {
			const phone = extract(cfg.field_path);
			if (typeof phone !== "string") return null;
			const row = await db.query.contacts.findFirst({
				where: and(
					eq(contacts.phone, phone),
					eq(contacts.organizationId, organizationId),
					contactWorkspace,
				),
			});
			if (row) return row.id;
			if (cfg.auto_create_contact) {
				const [created] = await db
					.insert(contacts)
					.values({
						organizationId,
						workspaceId: scope.workspaceId,
						phone,
					})
					.returning();
				return created?.id ?? null;
			}
			return null;
		}
		case "platform_id": {
			const identifier = extract(cfg.field_path);
			if (typeof identifier !== "string") return null;
			if (!scope.socialAccountId) return null;
			if (cfg.platform && cfg.platform !== scope.channel) return null;
			// Scope the lookup through contacts.organizationId — otherwise a
			// platform_id collision across orgs (same FB PSID / IG user, different
			// tenants) could return another tenant's contact.
			const rows = await db
				.select({ contactId: contactChannels.contactId })
				.from(contactChannels)
				.innerJoin(contacts, eq(contactChannels.contactId, contacts.id))
				.where(
					and(
						eq(contactChannels.identifier, identifier),
						eq(contactChannels.socialAccountId, scope.socialAccountId),
						eq(contacts.organizationId, organizationId),
						contactWorkspace,
						eq(
							contactChannels.platform,
							scope.channel as typeof contactChannels.$inferSelect.platform,
						),
					),
				)
				.limit(1);
			return rows[0]?.contactId ?? null;
		}
		case "custom_field": {
			if (!cfg.custom_field_key) return null;
			const value = extract(cfg.field_path);
			// Guard against null/undefined — otherwise we'd match contacts whose
			// field happens to serialize to `"null"` or similar sentinel values.
			if (value === undefined || value === null) return null;
			// Coerce to a string since `custom_field_values.value` is stored as
			// text. Booleans, numbers, and other primitives are stringified the
			// same way the dashboard / API writers do when persisting values.
			const serialized = typeof value === "string" ? value : String(value);
			const def = await db.query.customFieldDefinitions.findFirst({
				where: and(
					eq(customFieldDefinitions.organizationId, organizationId),
					eq(customFieldDefinitions.slug, cfg.custom_field_key),
					scope.workspaceId
						? or(
								eq(customFieldDefinitions.workspaceId, scope.workspaceId),
								isNull(customFieldDefinitions.workspaceId),
							)
						: isNull(customFieldDefinitions.workspaceId),
				),
				orderBy: scope.workspaceId
					? [sql`${customFieldDefinitions.workspaceId} IS NULL`]
					: undefined,
			});
			if (!def) return null;
			// Filter by value in SQL. The (definition_id, contact_id) pair is
			// unique so at most one row per contact can match, but because any
			// number of contacts may share a (definition, value) tuple we order
			// by updated_at DESC and take the most recently updated as the
			// canonical contact. This is deterministic for v1; in practice the
			// lookup field should be unique (e.g. `external_id`) so the
			// "multiple matches" branch is rare and always resolves the same way.
			const [fv] = await db
				.select({ contactId: customFieldValues.contactId })
				.from(customFieldValues)
				.innerJoin(
					contacts,
					and(
						eq(customFieldValues.contactId, contacts.id),
						eq(customFieldValues.organizationId, contacts.organizationId),
					),
				)
				.where(
					and(
						eq(customFieldValues.organizationId, organizationId),
						eq(customFieldValues.definitionId, def.id),
						eq(customFieldValues.value, serialized),
						contactWorkspace,
					),
				)
				.orderBy(desc(customFieldValues.updatedAt))
				.limit(1);
			return fv?.contactId ?? null;
		}
		default:
			return null;
	}
}

type WebhookMatch = {
	entrypoint: typeof automationEntrypoints.$inferSelect;
	automation: typeof automations.$inferSelect;
};

async function processAcceptedWebhook(
	db: Db,
	match: WebhookMatch,
	body: unknown,
	env: Record<string, unknown>,
	triggerOccurrenceId: string,
): Promise<WebhookReceptionResult> {
	const cfg = (match.entrypoint.config ?? {}) as Record<string, unknown>;
	const lookup =
		(cfg.contact_lookup as ContactLookupConfig | undefined) ?? null;
	if (!lookup) return { status: "contact_lookup_failed" };
	if (match.entrypoint.channel !== match.automation.channel) {
		return {
			status: "contact_lookup_failed",
			reason: "entrypoint_channel_mismatch",
		};
	}
	if (
		lookup.default_workspace_id !== undefined &&
		lookup.default_workspace_id !== match.automation.workspaceId
	) {
		return {
			status: "contact_lookup_failed",
			reason: "configured_workspace_mismatch",
		};
	}

	if (match.entrypoint.socialAccountId) {
		const [account] = await db
			.select({
				id: socialAccounts.id,
				workspaceId: socialAccounts.workspaceId,
				platform: socialAccounts.platform,
				lifecycleStatus: socialAccounts.lifecycleStatus,
			})
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.id, match.entrypoint.socialAccountId),
					eq(socialAccounts.organizationId, match.automation.organizationId),
				),
			)
			.limit(1);
		if (
			!account ||
			account.workspaceId !== match.automation.workspaceId ||
			account.platform !== match.automation.channel ||
			account.lifecycleStatus !== "active"
		) {
			return {
				status: "contact_lookup_failed",
				reason: "entrypoint_account_scope_mismatch",
			};
		}
	} else if (lookup.by === "platform_id") {
		return {
			status: "contact_lookup_failed",
			reason: "platform_lookup_requires_entrypoint_account",
		};
	}

	const contactId = await resolveContact(
		db,
		match.automation.organizationId,
		body,
		lookup,
		{
			workspaceId: match.automation.workspaceId,
			socialAccountId: match.entrypoint.socialAccountId ?? null,
			channel: match.automation.channel,
		},
	);
	if (!contactId) return { status: "contact_lookup_failed" };

	const payloadMapping = (cfg.payload_mapping ?? {}) as Record<string, string>;
	const contextOverrides: Record<string, unknown> = { webhookBody: body };
	for (const [key, jsonPath] of Object.entries(payloadMapping)) {
		contextOverrides[key] = extractByPath(body, jsonPath);
	}

	try {
		const matched = await matchAndEnroll(
			db,
			{
				kind: "webhook_inbound",
				channel: match.automation.channel as InboundEvent["channel"],
				organizationId: match.automation.organizationId,
				socialAccountId: match.entrypoint.socialAccountId ?? null,
				contactId,
				conversationId: null,
				triggerOccurrenceId,
				payload: {
					source: "webhook",
					entrypoint_id: match.entrypoint.id,
				},
			},
			env,
			{
				pinnedEntrypointId: match.entrypoint.id,
				contextOverrides,
				deferRun: true,
			},
		);
		if (!matched.matched) {
			return { status: "enrollment_blocked", reason: matched.reason };
		}
		return {
			status: "ok",
			runId: matched.runId,
			automationId: match.automation.id,
		};
	} catch (err) {
		return {
			status: "enrollment_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---------------------------------------------------------------------------
// Main receiver
// ---------------------------------------------------------------------------

export async function receiveAutomationWebhook(
	db: Db,
	params: {
		slug: string;
		rawBody: string;
		signatureHeader: string | null;
		/** Caller-supplied `X-Relay-Timestamp` in unix seconds. */
		timestampHeader?: string | null;
	},
	env: Record<string, unknown>,
): Promise<WebhookReceptionResult> {
	// 1. Look up entrypoint by slug. Push the slug predicate into SQL so we
	//    fetch at most one row instead of every active webhook entrypoint
	//    platform-wide (O(tenant count) transfer + JS scan). The database unique
	//    index on inbound webhook slugs guarantees that this lookup is singular.
	const rows = await db
		.select({ entrypoint: automationEntrypoints, automation: automations })
		.from(automationEntrypoints)
		.innerJoin(
			automations,
			eq(automationEntrypoints.automationId, automations.id),
		)
		.where(
			and(
				eq(automationEntrypoints.kind, "webhook_inbound"),
				eq(automationEntrypoints.status, "active"),
				eq(automations.status, "active"),
				sql`${automationEntrypoints.config}->>'webhook_slug' = ${params.slug}`,
			),
		)
		.limit(1);

	const match = rows[0];
	if (!match) return { status: "unknown_slug" };

	const cfg = (match.entrypoint.config ?? {}) as Record<string, unknown>;

	// 2. Decrypt secret + verify HMAC.
	const encSecret = cfg.webhook_secret as string | undefined;
	if (!encSecret) return { status: "bad_signature" };
	if (!params.signatureHeader) return { status: "bad_signature" };

	let secret: string | null;
	try {
		secret = await maybeDecrypt(
			encSecret,
			(env as { ENCRYPTION_KEY?: string }).ENCRYPTION_KEY,
			{ recordId: match.entrypoint.id, field: "webhook_secret" },
		);
	} catch {
		return { status: "bad_signature" };
	}
	if (!secret) return { status: "bad_signature" };

	// Timestamped signatures are mandatory so a captured request cannot remain
	// valid forever.
	const timestampHeader = params.timestampHeader?.trim();
	if (!timestampHeader || !/^\d{1,13}$/.test(timestampHeader)) {
		return { status: "bad_signature" };
	}
	const ts = Number(timestampHeader);
	if (!Number.isSafeInteger(ts)) return { status: "bad_signature" };
	const nowSeconds = Date.now() / 1000;
	if (Math.abs(nowSeconds - ts) > MAX_TIMESTAMP_SKEW_SECONDS) {
		return { status: "stale_timestamp" };
	}
	const signedPayload = `${timestampHeader}.${params.rawBody}`;

	const sigOk = await verifyHmacSha256(
		secret,
		signedPayload,
		params.signatureHeader,
	);
	if (!sigOk) return { status: "bad_signature" };

	// 3. Parse body JSON.
	let body: unknown;
	try {
		body = JSON.parse(params.rawBody);
	} catch (err) {
		return {
			status: "bad_payload",
			error: err instanceof Error ? err.message : String(err),
		};
	}

	// 4. Persist the accepted occurrence before any contact or enrollment side
	// effect. The encrypted bounded payload lets the scheduled reconciler resume
	// a crash even when the caller never retries the HTTP request.
	const requestDigest = await sha256Hex(
		`${match.entrypoint.id}\0${timestampHeader}\0${params.rawBody}`,
	);
	const receiptId = generateId("awhr_");
	const payloadCiphertext = await maybeEncrypt(
		params.rawBody,
		(env as { ENCRYPTION_KEY?: string }).ENCRYPTION_KEY,
		{ recordId: receiptId, field: "payload" },
	);
	if (!payloadCiphertext) throw new Error("Webhook payload encryption failed");
	const inserted = await db
		.insert(automationWebhookReceipts)
		.values({
			id: receiptId,
			organizationId: match.automation.organizationId,
			automationId: match.automation.id,
			entrypointId: match.entrypoint.id,
			requestDigest,
			signatureTimestamp: timestampHeader,
			payloadCiphertext,
			expiresAt: new Date(Date.now() + WEBHOOK_RECEIPT_TTL_MS),
		})
		.onConflictDoNothing()
		.returning();
	let receipt = inserted[0];
	if (!receipt) {
		receipt = await db.query.automationWebhookReceipts.findFirst({
			where: and(
				eq(automationWebhookReceipts.entrypointId, match.entrypoint.id),
				eq(automationWebhookReceipts.requestDigest, requestDigest),
			),
		});
	}
	if (!receipt) {
		return { status: "duplicate", receiptStatus: "accepted" };
	}
	if (receipt.status === "succeeded" || receipt.status === "terminal_failed") {
		return {
			status: "duplicate",
			receiptStatus: receipt.status,
			...(receipt.runId ? { runId: receipt.runId } : {}),
		};
	}

	const [claimed] = await db
		.update(automationWebhookReceipts)
		.set({
			status: "processing",
			attempts: sql`${automationWebhookReceipts.attempts} + 1`,
			leaseToken: sql`${automationWebhookReceipts.leaseToken} + 1`,
			leaseExpiresAt: sql`CURRENT_TIMESTAMP + (${WEBHOOK_RECEIPT_LEASE_MS} * INTERVAL '1 millisecond')`,
			lastError: null,
		})
		.where(
			and(
				eq(automationWebhookReceipts.id, receipt.id),
				or(
					and(
						inArray(automationWebhookReceipts.status, ["pending", "failed"]),
						lte(
							automationWebhookReceipts.nextAttemptAt,
							sql`CURRENT_TIMESTAMP`,
						),
					),
					and(
						eq(automationWebhookReceipts.status, "processing"),
						lte(
							automationWebhookReceipts.leaseExpiresAt,
							sql`CURRENT_TIMESTAMP`,
						),
					),
				),
			),
		)
		.returning();
	if (!claimed) {
		return {
			status: "duplicate",
			receiptStatus: receipt.status,
			...(receipt.runId ? { runId: receipt.runId } : {}),
		};
	}

	const result = await processAcceptedWebhook(db, match, body, env, claimed.id);
	const retryable = result.status === "enrollment_failed";
	await db
		.update(automationWebhookReceipts)
		.set({
			status:
				result.status === "ok"
					? "succeeded"
					: retryable
						? "failed"
						: "terminal_failed",
			runId: result.status === "ok" ? result.runId : null,
			lastError:
				result.status === "enrollment_failed"
					? result.error
					: result.status === "enrollment_blocked"
						? result.reason
						: result.status === "contact_lookup_failed"
							? (result.reason ?? "contact_lookup_failed")
							: null,
			nextAttemptAt: retryable
				? new Date(Date.now() + Math.min(60_000, 2 ** claimed.attempts * 1_000))
				: claimed.nextAttemptAt,
			leaseExpiresAt: null,
			completedAt: retryable ? null : sql`CURRENT_TIMESTAMP`,
		})
		.where(
			and(
				eq(automationWebhookReceipts.id, claimed.id),
				eq(automationWebhookReceipts.status, "processing"),
				eq(automationWebhookReceipts.leaseToken, claimed.leaseToken),
			),
		);
	return result;
}

/**
 * Resume accepted automation webhooks whose request worker stopped after the
 * durable receipt commit. The scan and lease are bounded so it adds no work to
 * the HTTP hot path and competing cron invocations cannot execute one receipt.
 */
export async function reconcileAutomationWebhookReceipts(
	env: Env,
	limit = 25,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const candidates = await db
		.select()
		.from(automationWebhookReceipts)
		.where(
			and(
				gt(automationWebhookReceipts.expiresAt, sql`CURRENT_TIMESTAMP`),
				or(
					and(
						inArray(automationWebhookReceipts.status, ["pending", "failed"]),
						lte(
							automationWebhookReceipts.nextAttemptAt,
							sql`CURRENT_TIMESTAMP`,
						),
					),
					and(
						eq(automationWebhookReceipts.status, "processing"),
						lte(
							automationWebhookReceipts.leaseExpiresAt,
							sql`CURRENT_TIMESTAMP`,
						),
					),
				),
			),
		)
		.orderBy(asc(automationWebhookReceipts.nextAttemptAt))
		.limit(Math.max(1, Math.min(limit, 100)));

	let completed = 0;
	for (const candidate of candidates) {
		const [claimed] = await db
			.update(automationWebhookReceipts)
			.set({
				status: "processing",
				attempts: sql`${automationWebhookReceipts.attempts} + 1`,
				leaseToken: sql`${automationWebhookReceipts.leaseToken} + 1`,
				leaseExpiresAt: sql`CURRENT_TIMESTAMP + (${WEBHOOK_RECEIPT_LEASE_MS} * INTERVAL '1 millisecond')`,
				lastError: null,
			})
			.where(
				and(
					eq(automationWebhookReceipts.id, candidate.id),
					eq(automationWebhookReceipts.leaseToken, candidate.leaseToken),
					or(
						and(
							inArray(automationWebhookReceipts.status, ["pending", "failed"]),
							lte(
								automationWebhookReceipts.nextAttemptAt,
								sql`CURRENT_TIMESTAMP`,
							),
						),
						and(
							eq(automationWebhookReceipts.status, "processing"),
							lte(
								automationWebhookReceipts.leaseExpiresAt,
								sql`CURRENT_TIMESTAMP`,
							),
						),
					),
				),
			)
			.returning();
		if (!claimed) continue;

		let result: WebhookReceptionResult;
		try {
			const [match] = await db
				.select({
					entrypoint: automationEntrypoints,
					automation: automations,
				})
				.from(automationEntrypoints)
				.innerJoin(
					automations,
					eq(automationEntrypoints.automationId, automations.id),
				)
				.where(
					and(
						eq(automationEntrypoints.id, claimed.entrypointId),
						eq(automations.id, claimed.automationId),
					),
				)
				.limit(1);
			if (!match) throw new Error("accepted webhook source no longer exists");
			const plaintext = await maybeDecrypt(
				claimed.payloadCiphertext,
				env.ENCRYPTION_KEY,
				{ recordId: claimed.id, field: "payload" },
			);
			if (!plaintext)
				throw new Error("accepted webhook payload is unavailable");
			const body: unknown = JSON.parse(plaintext);
			result = await processAcceptedWebhook(
				db,
				match,
				body,
				env as unknown as Record<string, unknown>,
				claimed.id,
			);
		} catch (error) {
			result = {
				status: "enrollment_failed",
				error: error instanceof Error ? error.message : "reconciliation failed",
			};
		}

		const retryable = result.status === "enrollment_failed";
		const terminal = !retryable;
		const updated = await db
			.update(automationWebhookReceipts)
			.set({
				status:
					result.status === "ok"
						? "succeeded"
						: retryable
							? "failed"
							: "terminal_failed",
				runId: result.status === "ok" ? result.runId : null,
				lastError:
					result.status === "enrollment_failed"
						? result.error
						: result.status === "enrollment_blocked"
							? result.reason
							: result.status === "contact_lookup_failed"
								? (result.reason ?? "contact_lookup_failed")
								: null,
				nextAttemptAt: retryable
					? new Date(
							Date.now() + Math.min(60_000, 2 ** claimed.attempts * 1_000),
						)
					: claimed.nextAttemptAt,
				leaseExpiresAt: null,
				completedAt: terminal ? sql`CURRENT_TIMESTAMP` : null,
			})
			.where(
				and(
					eq(automationWebhookReceipts.id, claimed.id),
					eq(automationWebhookReceipts.status, "processing"),
					eq(automationWebhookReceipts.leaseToken, claimed.leaseToken),
				),
			)
			.returning({ id: automationWebhookReceipts.id });
		if (updated.length > 0 && result.status === "ok") completed++;
	}

	return completed;
}
