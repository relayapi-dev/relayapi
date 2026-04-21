// apps/api/src/services/automations/webhook-receiver.ts
//
// Public webhook entry point for external-triggered automations (spec §6.7).
// Paired with the /v1/webhooks/automation-trigger/:slug route. Verifies HMAC,
// resolves a contact from the signed payload, then enrolls via the runner.

import {
	automationEntrypoints,
	automations,
	contacts,
	contactChannels,
	customFieldDefinitions,
	customFieldValues,
	type Database,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { maybeDecrypt } from "../../lib/crypto";
import { enrollContact } from "./runner";

export type Db = Database;

export type WebhookReceptionResult =
	| { status: "ok"; runId: string; automationId: string }
	| { status: "bad_signature" }
	| { status: "unknown_slug" }
	| { status: "bad_payload"; error: string }
	| { status: "contact_lookup_failed" }
	| { status: "enrollment_failed"; error: string };

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
	for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!;
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
): Promise<string | null> {
	const extract = (path?: string) =>
		path ? extractByPath(body, path) : undefined;

	switch (cfg.by) {
		case "contact_id": {
			const id = extract(cfg.field_path);
			if (typeof id !== "string") return null;
			const row = await db.query.contacts.findFirst({
				where: and(eq(contacts.id, id), eq(contacts.organizationId, organizationId)),
			});
			return row?.id ?? null;
		}
		case "email": {
			const email = extract(cfg.field_path);
			if (typeof email !== "string") return null;
			const row = await db.query.contacts.findFirst({
				where: and(
					eq(contacts.email, email),
					eq(contacts.organizationId, organizationId),
				),
			});
			if (row) return row.id;
			if (cfg.auto_create_contact && cfg.default_workspace_id) {
				const [created] = await db
					.insert(contacts)
					.values({
						organizationId,
						workspaceId: cfg.default_workspace_id,
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
				),
			});
			if (row) return row.id;
			if (cfg.auto_create_contact && cfg.default_workspace_id) {
				const [created] = await db
					.insert(contacts)
					.values({
						organizationId,
						workspaceId: cfg.default_workspace_id,
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
			const platform = cfg.platform;
			const row = await db.query.contactChannels.findFirst({
				where: and(
					eq(contactChannels.identifier, identifier),
					platform
						? eq(contactChannels.platform, platform)
						: undefined,
				),
			});
			return row?.contactId ?? null;
		}
		case "custom_field": {
			if (!cfg.custom_field_key) return null;
			const value = extract(cfg.field_path);
			if (value === undefined || value === null) return null;
			const def = await db.query.customFieldDefinitions.findFirst({
				where: and(
					eq(customFieldDefinitions.organizationId, organizationId),
					eq(customFieldDefinitions.slug, cfg.custom_field_key),
				),
			});
			if (!def) return null;
			const fv = await db.query.customFieldValues.findFirst({
				where: and(
					eq(customFieldValues.organizationId, organizationId),
					eq(customFieldValues.definitionId, def.id),
				),
			});
			// Drizzle doesn't natively query JSONB equality generically; for v1 we
			// compare loosely by iterating matches. A tighter implementation will
			// push the comparison into SQL once a canonical JSONB form is agreed.
			if (!fv) return null;
			if (
				typeof fv.value === "string" &&
				typeof value === "string" &&
				fv.value === value
			) {
				return fv.contactId;
			}
			if (fv.value === value) return fv.contactId;
			return null;
		}
		default:
			return null;
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
	},
	env: Record<string, unknown>,
): Promise<WebhookReceptionResult> {
	// 1. Look up entrypoint by slug.
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
			),
		);

	const match = rows.find((r) => {
		const cfg = (r.entrypoint.config ?? {}) as Record<string, unknown>;
		return cfg.webhook_slug === params.slug;
	});
	if (!match) return { status: "unknown_slug" };

	const cfg = (match.entrypoint.config ?? {}) as Record<string, unknown>;

	// 2. Decrypt secret + verify HMAC.
	const encSecret = cfg.webhook_secret as string | undefined;
	if (!encSecret) return { status: "bad_signature" };
	if (!params.signatureHeader) return { status: "bad_signature" };

	let secret: string | null = encSecret;
	// Only invoke the crypto helper when the value is actually encrypted.
	// Plaintext secrets (test fixtures, legacy data) are used as-is.
	if (encSecret.startsWith("enc:")) {
		try {
			secret = await maybeDecrypt(
				encSecret,
				(env as { ENCRYPTION_KEY?: string }).ENCRYPTION_KEY,
			);
		} catch {
			return { status: "bad_signature" };
		}
	}
	if (!secret) return { status: "bad_signature" };

	const sigOk = await verifyHmacSha256(
		secret,
		params.rawBody,
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

	// 4. Resolve contact.
	const lookup =
		(cfg.contact_lookup as ContactLookupConfig | undefined) ?? null;
	if (!lookup) return { status: "contact_lookup_failed" };

	const contactId = await resolveContact(
		db,
		match.automation.organizationId,
		body,
		lookup,
	);
	if (!contactId) return { status: "contact_lookup_failed" };

	// 5. Apply payload_mapping into context overrides.
	const payloadMapping = (cfg.payload_mapping ?? {}) as Record<string, string>;
	const contextOverrides: Record<string, unknown> = { webhookBody: body };
	for (const [key, jsonPath] of Object.entries(payloadMapping)) {
		contextOverrides[key] = extractByPath(body, jsonPath);
	}

	// 6. Enroll.
	try {
		const { runId } = await enrollContact(db, {
			automationId: match.automation.id,
			organizationId: match.automation.organizationId,
			contactId,
			conversationId: null,
			channel: match.automation.channel,
			entrypointId: match.entrypoint.id,
			bindingId: null,
			contextOverrides,
			env,
		});
		return {
			status: "ok",
			runId,
			automationId: match.automation.id,
		};
	} catch (err) {
		return {
			status: "enrollment_failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
