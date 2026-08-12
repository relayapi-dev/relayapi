import {
	contacts,
	createDb,
	type Database,
	generateId,
	sql,
} from "@relayapi/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { decryptToken, encryptToken } from "../lib/crypto";
import { durableOperationHashes } from "../lib/durable-operation";
import type { Env } from "../types";
import type { AdPlatform } from "./ad-platforms/types";
import { protectContactValues } from "./contact-protection";

export class AdvancedAdStoreError extends Error {
	constructor(
		readonly code:
			| "INVALID_CURSOR"
			| "NOT_FOUND"
			| "IDEMPOTENCY_KEY_REUSED"
			| "LEAD_IDENTITY_REQUIRED"
			| "LEAD_IDENTITY_CONFLICT",
		message: string,
	) {
		super(message);
		this.name = "AdvancedAdStoreError";
	}
}

interface TimestampCursor {
	createdAt: string;
	id: string;
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
	return btoa(
		JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
	);
}

function decodeCursor(value?: string): TimestampCursor | null {
	if (!value) return null;
	try {
		const decoded = JSON.parse(atob(value)) as unknown;
		if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
			throw new Error("cursor is not an object");
		}
		const row = decoded as Record<string, unknown>;
		if (
			typeof row.createdAt !== "string" ||
			Number.isNaN(new Date(row.createdAt).valueOf()) ||
			typeof row.id !== "string" ||
			!row.id
		) {
			throw new Error("cursor fields are invalid");
		}
		return { createdAt: row.createdAt, id: row.id };
	} catch {
		throw new AdvancedAdStoreError(
			"INVALID_CURSOR",
			"Invalid pagination cursor",
		);
	}
}

function objectValue(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function dateValue(value: Date | string): Date {
	return value instanceof Date ? value : new Date(value);
}

interface LeadFormSqlRow extends Record<string, unknown> {
	id: string;
	workspaceId: string | null;
	adAccountId: string;
	platform: AdPlatform;
	providerFormId: string;
	name: string | null;
	status: "draft" | "active" | "archived" | "unknown";
	configuration: unknown;
	createdAt: Date;
	updatedAt: Date;
}

export interface LeadFormProjection {
	id: string;
	workspace_id: string | null;
	ad_account_id: string;
	platform: AdPlatform;
	provider_form_id: string;
	name: string | null;
	status: LeadFormSqlRow["status"];
	configuration: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

function serializeLeadForm(row: LeadFormSqlRow): LeadFormProjection {
	return {
		id: row.id,
		workspace_id: row.workspaceId,
		ad_account_id: row.adAccountId,
		platform: row.platform,
		provider_form_id: row.providerFormId,
		name: row.name,
		status: row.status,
		configuration: objectValue(row.configuration),
		created_at: dateValue(row.createdAt).toISOString(),
		updated_at: dateValue(row.updatedAt).toISOString(),
	};
}

export async function createLeadFormProjection(
	db: Database,
	input: {
		organizationId: string;
		workspaceId: string | null;
		adAccountId: string;
		platform: AdPlatform;
		providerFormId: string;
		name?: string;
		status: LeadFormSqlRow["status"];
		configuration: Record<string, unknown>;
	},
): Promise<LeadFormProjection> {
	const id = generateId("adform_");
	const rows = await db.execute<LeadFormSqlRow>(sql`
		INSERT INTO ad_lead_forms (
			id, organization_id, workspace_id, ad_account_id, platform,
			provider_form_id, name, status, configuration
		) VALUES (
			${id}, ${input.organizationId}, ${input.workspaceId}, ${input.adAccountId},
			${input.platform}, ${input.providerFormId}, ${input.name ?? null},
			${input.status}, ${JSON.stringify(input.configuration)}::jsonb
		)
		ON CONFLICT (organization_id, ad_account_id, provider_form_id)
		DO UPDATE SET
			name = EXCLUDED.name,
			status = EXCLUDED.status,
			configuration = EXCLUDED.configuration,
			updated_at = now()
		RETURNING
			id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
			platform, provider_form_id AS "providerFormId", name, status,
			configuration, created_at AS "createdAt", updated_at AS "updatedAt"
	`);
	const row = rows[0];
	if (!row) throw new Error("Failed to persist lead-form projection");
	return serializeLeadForm(row);
}

export async function listLeadFormProjections(
	db: Database,
	input: {
		organizationId: string;
		adAccountId: string;
		cursor?: string;
		limit: number;
	},
): Promise<{
	data: LeadFormProjection[];
	next_cursor: string | null;
	has_more: boolean;
}> {
	const cursor = decodeCursor(input.cursor);
	const rows = await db.execute<LeadFormSqlRow>(sql`
		SELECT
			id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
			platform, provider_form_id AS "providerFormId", name, status,
			configuration, created_at AS "createdAt", updated_at AS "updatedAt"
		FROM ad_lead_forms
		WHERE organization_id = ${input.organizationId}
		  AND ad_account_id = ${input.adAccountId}
		  ${
				cursor
					? sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`
					: sql``
			}
		ORDER BY created_at DESC, id DESC
		LIMIT ${input.limit + 1}
	`);
	const hasMore = rows.length > input.limit;
	const page = rows.slice(0, input.limit);
	const last = page.at(-1);
	return {
		data: page.map(serializeLeadForm),
		next_cursor:
			hasMore && last
				? encodeCursor({ ...last, createdAt: dateValue(last.createdAt) })
				: null,
		has_more: hasMore,
	};
}

interface LeadSqlRow extends Record<string, unknown> {
	id: string;
	workspaceId: string | null;
	adAccountId: string;
	leadFormId: string | null;
	platform: AdPlatform;
	providerLeadId: string;
	status: "new" | "promoted" | "dismissed";
	payloadCiphertext: string;
	contactId: string | null;
	providerCreatedAt: Date | null;
	expiresAt: Date;
	createdAt: Date;
}

export interface DecryptedAdLead {
	id: string;
	workspace_id: string | null;
	ad_account_id: string;
	lead_form_id: string | null;
	platform: AdPlatform;
	provider_lead_id: string;
	status: LeadSqlRow["status"];
	data: Record<string, unknown>;
	contact_id: string | null;
	provider_created_at: string | null;
	expires_at: string;
	created_at: string;
}

export interface AdvancedAdResourceAuthority {
	adAccountId: string;
	workspaceId: string | null;
	platform: AdPlatform;
}

/**
 * Resolve only the non-sensitive parent authority for a lead. Route handlers
 * use this before loading or decrypting the lead payload.
 */
export async function getAdvancedAdLeadAuthority(
	db: Database,
	input: { organizationId: string; id: string },
): Promise<AdvancedAdResourceAuthority> {
	const rows = await db.execute<
		AdvancedAdResourceAuthority & Record<string, unknown>
	>(sql`
		SELECT
			ad_account_id AS "adAccountId", workspace_id AS "workspaceId", platform
		FROM ad_leads
		WHERE organization_id = ${input.organizationId}
		  AND id = ${input.id}
		  AND expires_at > now()
		LIMIT 1
	`);
	const row = rows[0];
	if (!row) throw new AdvancedAdStoreError("NOT_FOUND", "Ad lead not found");
	return row;
}

async function decryptLead(
	row: LeadSqlRow,
	encryptionKey: string,
): Promise<DecryptedAdLead> {
	const plaintext = await decryptToken(row.payloadCiphertext, encryptionKey, {
		recordId: row.id,
		field: "ad_lead_payload",
	});
	const value = objectValue(JSON.parse(plaintext) as unknown);
	return {
		id: row.id,
		workspace_id: row.workspaceId,
		ad_account_id: row.adAccountId,
		lead_form_id: row.leadFormId,
		platform: row.platform,
		provider_lead_id: row.providerLeadId,
		status: row.status,
		data: value,
		contact_id: row.contactId,
		provider_created_at: row.providerCreatedAt
			? dateValue(row.providerCreatedAt).toISOString()
			: null,
		expires_at: dateValue(row.expiresAt).toISOString(),
		created_at: dateValue(row.createdAt).toISOString(),
	};
}

export async function ingestAdvancedAdLead(
	db: Database,
	encryptionKey: string,
	input: {
		organizationId: string;
		workspaceId: string | null;
		adAccountId: string;
		leadFormId?: string | null;
		platform: AdPlatform;
		providerLeadId: string;
		providerCreatedAt?: Date | null;
		payload: Record<string, unknown>;
		retentionDays?: number;
	},
): Promise<{ lead: DecryptedAdLead; created: boolean }> {
	const id = generateId("adlead_");
	const payloadCiphertext = await encryptToken(
		JSON.stringify(input.payload),
		encryptionKey,
		{ recordId: id, field: "ad_lead_payload" },
	);
	const retentionDays = Math.min(Math.max(input.retentionDays ?? 30, 1), 30);
	const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
	const rows = await db.execute<LeadSqlRow>(sql`
		INSERT INTO ad_leads (
			id, organization_id, workspace_id, ad_account_id, lead_form_id,
			platform, provider_lead_id, status, payload_ciphertext,
			provider_created_at, expires_at
		) VALUES (
			${id}, ${input.organizationId}, ${input.workspaceId}, ${input.adAccountId},
			${input.leadFormId ?? null}, ${input.platform}, ${input.providerLeadId},
			'new', ${payloadCiphertext}, ${input.providerCreatedAt ?? null}, ${expiresAt}
		)
		ON CONFLICT (organization_id, ad_account_id, provider_lead_id) DO NOTHING
		RETURNING
			id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
			lead_form_id AS "leadFormId", platform,
			provider_lead_id AS "providerLeadId", status,
			payload_ciphertext AS "payloadCiphertext", contact_id AS "contactId",
			provider_created_at AS "providerCreatedAt", expires_at AS "expiresAt",
			created_at AS "createdAt"
	`);
	let row = rows[0];
	const created = Boolean(row);
	if (!row) {
		const existing = await db.execute<LeadSqlRow>(sql`
			SELECT
				id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
				lead_form_id AS "leadFormId", platform,
				provider_lead_id AS "providerLeadId", status,
				payload_ciphertext AS "payloadCiphertext", contact_id AS "contactId",
				provider_created_at AS "providerCreatedAt", expires_at AS "expiresAt",
				created_at AS "createdAt"
			FROM ad_leads
			WHERE organization_id = ${input.organizationId}
			  AND ad_account_id = ${input.adAccountId}
			  AND provider_lead_id = ${input.providerLeadId}
			LIMIT 1
		`);
		row = existing[0];
	}
	if (!row) throw new Error("Failed to recover accepted ad lead");
	return { lead: await decryptLead(row, encryptionKey), created };
}

export async function getAdvancedAdLead(
	db: Database,
	encryptionKey: string,
	input: {
		organizationId: string;
		id: string;
		adAccountId: string;
		workspaceId: string | null;
	},
): Promise<DecryptedAdLead> {
	const rows = await db.execute<LeadSqlRow>(sql`
		SELECT
			id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
			lead_form_id AS "leadFormId", platform,
			provider_lead_id AS "providerLeadId", status,
			payload_ciphertext AS "payloadCiphertext", contact_id AS "contactId",
			provider_created_at AS "providerCreatedAt", expires_at AS "expiresAt",
			created_at AS "createdAt"
		FROM ad_leads
		WHERE organization_id = ${input.organizationId}
		  AND id = ${input.id}
		  AND ad_account_id = ${input.adAccountId}
		  AND workspace_id IS NOT DISTINCT FROM ${input.workspaceId}
		  AND expires_at > now()
		LIMIT 1
	`);
	const row = rows[0];
	if (!row) throw new AdvancedAdStoreError("NOT_FOUND", "Ad lead not found");
	return decryptLead(row, encryptionKey);
}

export async function listAdvancedAdLeads(
	db: Database,
	encryptionKey: string,
	input: {
		organizationId: string;
		adAccountId: string;
		status?: LeadSqlRow["status"];
		leadFormId?: string;
		cursor?: string;
		limit: number;
	},
): Promise<{
	data: DecryptedAdLead[];
	next_cursor: string | null;
	has_more: boolean;
}> {
	const cursor = decodeCursor(input.cursor);
	const rows = await db.execute<LeadSqlRow>(sql`
		SELECT
			id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
			lead_form_id AS "leadFormId", platform,
			provider_lead_id AS "providerLeadId", status,
			payload_ciphertext AS "payloadCiphertext", contact_id AS "contactId",
			provider_created_at AS "providerCreatedAt", expires_at AS "expiresAt",
			created_at AS "createdAt"
		FROM ad_leads
		WHERE organization_id = ${input.organizationId}
		  AND ad_account_id = ${input.adAccountId}
		  AND expires_at > now()
		  ${input.status ? sql`AND status = ${input.status}` : sql``}
		  ${input.leadFormId ? sql`AND lead_form_id = ${input.leadFormId}` : sql``}
		  ${
				cursor
					? sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`
					: sql``
			}
		ORDER BY created_at DESC, id DESC
		LIMIT ${input.limit + 1}
	`);
	const hasMore = rows.length > input.limit;
	const page = rows.slice(0, input.limit);
	const data = await Promise.all(
		page.map((row) => decryptLead(row, encryptionKey)),
	);
	const last = page.at(-1);
	return {
		data,
		next_cursor:
			hasMore && last
				? encodeCursor({ ...last, createdAt: dateValue(last.createdAt) })
				: null,
		has_more: hasMore,
	};
}

/**
 * Delete encrypted lead intake at its explicit expiry. The provider lead ID,
 * ciphertext, and local projection leave together so no stale identifier-only
 * shadow survives the payload policy.
 */
export async function pruneExpiredAdvancedAdLeads(
	env: Pick<Env, "HYPERDRIVE">,
	options: { db?: Database; now?: Date; limit?: number } = {},
): Promise<number> {
	const db = options.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options.now ?? new Date();
	const limit = Math.min(Math.max(options.limit ?? 500, 1), 5_000);
	const deleted = await db.execute<{ id: string }>(sql`
		DELETE FROM ad_leads
		WHERE id IN (
			SELECT id
			FROM ad_leads
			WHERE expires_at <= ${now}
			ORDER BY expires_at, id
			LIMIT ${limit}
		)
		RETURNING id
	`);
	return deleted.length;
}

function getMappedValue(
	payload: Record<string, unknown>,
	path: string | undefined,
): string | null {
	if (!path) return null;
	let current: unknown = payload;
	for (const segment of path.split(".").slice(0, 10)) {
		if (!current || typeof current !== "object" || Array.isArray(current))
			return null;
		current = (current as Record<string, unknown>)[segment];
	}
	if (typeof current === "string") return current;
	if (typeof current === "number" || typeof current === "boolean")
		return String(current);
	return null;
}

export async function promoteAdvancedAdLead(
	db: Database,
	encryptionKey: string,
	input: {
		organizationId: string;
		leadId: string;
		adAccountId: string;
		workspaceId: string | null;
		nameField?: string;
		emailField?: string;
		phoneField?: string;
		metadataFields: string[];
		tags: string[];
	},
): Promise<{ lead: DecryptedAdLead; contactId: string; created: boolean }> {
	const lead = await getAdvancedAdLead(db, encryptionKey, {
		organizationId: input.organizationId,
		id: input.leadId,
		adAccountId: input.adAccountId,
		workspaceId: input.workspaceId,
	});
	if (lead.contact_id) {
		return { lead, contactId: lead.contact_id, created: false };
	}
	const name = getMappedValue(lead.data, input.nameField);
	const email = getMappedValue(lead.data, input.emailField);
	const phone = getMappedValue(lead.data, input.phoneField);
	if (!name && !email && !phone) {
		throw new AdvancedAdStoreError(
			"LEAD_IDENTITY_REQUIRED",
			"At least one selected lead field must contain a name, email, or phone value",
		);
	}
	const metadata = Object.fromEntries(
		input.metadataFields
			.map((field) => [field, getMappedValue(lead.data, field)] as const)
			.filter((entry): entry is readonly [string, string] => entry[1] !== null),
	);
	const contactId = generateId("ct_");
	const protectedContact = await protectContactValues(
		encryptionKey,
		input.organizationId,
		contactId,
		{ name, email, phone, metadata },
	);

	return db.transaction(async (tx) => {
		const [inserted] = await tx
			.insert(contacts)
			.values({
				id: contactId,
				organizationId: input.organizationId,
				workspaceId: lead.workspace_id,
				...protectedContact,
				tags: input.tags,
				optedIn: false,
			})
			.onConflictDoNothing()
			.returning({ id: contacts.id });
		let resolvedContactId = inserted?.id;
		let created = Boolean(inserted);
		if (!resolvedContactId) {
			const identityConditions = [
				protectedContact.emailHash
					? eq(contacts.emailHash, protectedContact.emailHash)
					: undefined,
				protectedContact.phoneHash
					? eq(contacts.phoneHash, protectedContact.phoneHash)
					: undefined,
			].filter((condition): condition is NonNullable<typeof condition> =>
				Boolean(condition),
			);
			if (identityConditions.length === 0) {
				throw new AdvancedAdStoreError(
					"LEAD_IDENTITY_CONFLICT",
					"The promoted lead conflicted with an existing protected identity",
				);
			}
			const matches = await tx
				.select({ id: contacts.id })
				.from(contacts)
				.where(
					and(
						eq(contacts.organizationId, input.organizationId),
						lead.workspace_id
							? eq(contacts.workspaceId, lead.workspace_id)
							: isNull(contacts.workspaceId),
						or(...identityConditions),
					),
				)
				.limit(2);
			if (matches.length !== 1 || !matches[0]) {
				throw new AdvancedAdStoreError(
					"LEAD_IDENTITY_CONFLICT",
					"The lead identifiers resolve to multiple existing contacts",
				);
			}
			resolvedContactId = matches[0].id;
			created = false;
		}
		const updated = await tx.execute<LeadSqlRow>(sql`
			UPDATE ad_leads
			SET status = 'promoted', contact_id = ${resolvedContactId}, updated_at = now()
			WHERE organization_id = ${input.organizationId}
			  AND id = ${lead.id}
			  AND ad_account_id = ${input.adAccountId}
			  AND workspace_id IS NOT DISTINCT FROM ${input.workspaceId}
			  AND (contact_id IS NULL OR contact_id = ${resolvedContactId})
			RETURNING
				id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
				lead_form_id AS "leadFormId", platform,
				provider_lead_id AS "providerLeadId", status,
				payload_ciphertext AS "payloadCiphertext", contact_id AS "contactId",
				provider_created_at AS "providerCreatedAt", expires_at AS "expiresAt",
				created_at AS "createdAt"
		`);
		const updatedLead = updated[0];
		if (!updatedLead) {
			throw new AdvancedAdStoreError(
				"LEAD_IDENTITY_CONFLICT",
				"The lead was concurrently promoted to another contact",
			);
		}
		return {
			lead: await decryptLead(updatedLead, encryptionKey),
			contactId: resolvedContactId,
			created,
		};
	});
}

interface ConversionRuleSqlRow extends Record<string, unknown> {
	id: string;
	workspaceId: string | null;
	adAccountId: string;
	platform: AdPlatform;
	name: string;
	eventName: string;
	providerDestinationId: string;
	configuration: unknown;
	enabled: boolean;
	createdAt: Date;
	updatedAt: Date;
}

/** Resolve a conversion rule's account without reading its configuration. */
export async function getAdConversionRuleAuthority(
	db: Database,
	input: { organizationId: string; id: string },
): Promise<AdvancedAdResourceAuthority> {
	const rows = await db.execute<
		AdvancedAdResourceAuthority & Record<string, unknown>
	>(sql`
		SELECT
			ad_account_id AS "adAccountId", workspace_id AS "workspaceId", platform
		FROM ad_conversion_rules
		WHERE organization_id = ${input.organizationId}
		  AND id = ${input.id}
		  AND enabled = true
		LIMIT 1
	`);
	const row = rows[0];
	if (!row) {
		throw new AdvancedAdStoreError("NOT_FOUND", "Conversion rule not found");
	}
	return row;
}

export async function createAdConversionRule(
	db: Database,
	input: {
		organizationId: string;
		workspaceId: string | null;
		adAccountId: string;
		platform: AdPlatform;
		name: string;
		eventName: string;
		providerDestinationId: string;
		configuration: Record<string, unknown>;
		enabled: boolean;
	},
) {
	const id = generateId("adcr_");
	const rows = await db.execute<ConversionRuleSqlRow>(sql`
		INSERT INTO ad_conversion_rules (
			id, organization_id, workspace_id, ad_account_id, platform, name,
			event_name, provider_destination_id, configuration, enabled
		) VALUES (
			${id}, ${input.organizationId}, ${input.workspaceId}, ${input.adAccountId},
			${input.platform}, ${input.name}, ${input.eventName},
			${input.providerDestinationId}, ${JSON.stringify(input.configuration)}::jsonb, ${input.enabled}
		)
		RETURNING
			id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
			platform, name, event_name AS "eventName",
			provider_destination_id AS "providerDestinationId", configuration,
			enabled, created_at AS "createdAt", updated_at AS "updatedAt"
	`);
	const row = rows[0];
	if (!row) throw new Error("Failed to create conversion rule");
	return {
		id: row.id,
		workspace_id: row.workspaceId,
		ad_account_id: row.adAccountId,
		platform: row.platform,
		name: row.name,
		event_name: row.eventName,
		provider_destination_id: row.providerDestinationId,
		configuration: objectValue(row.configuration),
		enabled: row.enabled,
		created_at: dateValue(row.createdAt).toISOString(),
		updated_at: dateValue(row.updatedAt).toISOString(),
	};
}

interface ConversionEventSqlRow extends Record<string, unknown> {
	id: string;
	conversionRuleId: string;
	adAccountId: string;
	platform: AdPlatform;
	eventId: string;
	requestHash: string;
	status:
		| "pending"
		| "processing"
		| "request_may_have_been_sent"
		| "unknown"
		| "completed"
		| "failed"
		| "cancelled";
	providerEventId: string | null;
	attempts: number;
	lastError: string | null;
	createdAt: Date;
	updatedAt: Date;
}

function serializeConversionEvent(row: ConversionEventSqlRow) {
	return {
		id: row.id,
		conversion_rule_id: row.conversionRuleId,
		ad_account_id: row.adAccountId,
		platform: row.platform,
		event_id: row.eventId,
		status: row.status,
		provider_event_id: row.providerEventId,
		attempts: row.attempts,
		last_error: row.lastError,
		created_at: dateValue(row.createdAt).toISOString(),
		updated_at: dateValue(row.updatedAt).toISOString(),
	};
}

export async function createAdConversionEvent(
	db: Database,
	encryptionKey: string,
	input: {
		organizationId: string;
		conversionRuleId: string;
		adAccountId: string;
		workspaceId: string | null;
		platform: AdPlatform;
		eventId: string;
		payload: Record<string, unknown>;
	},
) {
	const ruleRows = await db.execute<{
		adAccountId: string;
		workspaceId: string | null;
		platform: AdPlatform;
	}>(sql`
		SELECT ad_account_id AS "adAccountId", workspace_id AS "workspaceId", platform
		FROM ad_conversion_rules
		WHERE organization_id = ${input.organizationId}
		  AND id = ${input.conversionRuleId}
		  AND ad_account_id = ${input.adAccountId}
		  AND workspace_id IS NOT DISTINCT FROM ${input.workspaceId}
		  AND platform = ${input.platform}
		  AND enabled = true
		LIMIT 1
	`);
	const rule = ruleRows[0];
	if (!rule)
		throw new AdvancedAdStoreError("NOT_FOUND", "Conversion rule not found");
	const hashes = await durableOperationHashes(
		input.organizationId,
		"ad_conversion_event",
		input.eventId,
		input.payload,
	);
	const id = generateId("adconv_");
	const payloadCiphertext = await encryptToken(
		JSON.stringify(input.payload),
		encryptionKey,
		{ recordId: id, field: "ad_conversion_payload" },
	);
	let rows = await db.execute<ConversionEventSqlRow>(sql`
		INSERT INTO ad_conversion_events (
			id, organization_id, workspace_id, ad_account_id, conversion_rule_id,
			platform, event_id, operation_key_hash, request_hash,
			payload_ciphertext, status, next_attempt_at
		) VALUES (
			${id}, ${input.organizationId}, ${rule.workspaceId}, ${rule.adAccountId},
			${input.conversionRuleId}, ${rule.platform}, ${input.eventId},
			${hashes.operationKeyHash}, ${hashes.requestHash}, ${payloadCiphertext},
			'pending', now()
		)
		ON CONFLICT (organization_id, conversion_rule_id, operation_key_hash) DO NOTHING
		RETURNING
			id, conversion_rule_id AS "conversionRuleId", ad_account_id AS "adAccountId",
			platform, event_id AS "eventId", request_hash AS "requestHash", status,
			provider_event_id AS "providerEventId", attempts,
			last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt"
	`);
	if (!rows[0]) {
		rows = await db.execute<ConversionEventSqlRow>(sql`
			SELECT
				id, conversion_rule_id AS "conversionRuleId", ad_account_id AS "adAccountId",
				platform, event_id AS "eventId", request_hash AS "requestHash", status,
				provider_event_id AS "providerEventId", attempts,
				last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt"
			FROM ad_conversion_events
			WHERE organization_id = ${input.organizationId}
			  AND conversion_rule_id = ${input.conversionRuleId}
			  AND operation_key_hash = ${hashes.operationKeyHash}
			LIMIT 1
		`);
	}
	const row = rows[0];
	if (!row) throw new Error("Failed to recover conversion event");
	if (row.requestHash !== hashes.requestHash) {
		throw new AdvancedAdStoreError(
			"IDEMPOTENCY_KEY_REUSED",
			"event_id was already used with a different conversion payload",
		);
	}
	return serializeConversionEvent(row);
}

export type AdvancedResourceKind =
	| "messaging_experience"
	| "creative_asset"
	| "catalog"
	| "product_set";

interface AdvancedResourceSqlRow extends Record<string, unknown> {
	id: string;
	workspaceId: string | null;
	adAccountId: string;
	platform: AdPlatform;
	kind: AdvancedResourceKind;
	providerResourceId: string | null;
	parentId: string | null;
	name: string | null;
	status: string;
	configuration: unknown;
	createdAt: Date;
	updatedAt: Date;
}

function serializeAdvancedResource(row: AdvancedResourceSqlRow) {
	return {
		id: row.id,
		workspace_id: row.workspaceId,
		ad_account_id: row.adAccountId,
		platform: row.platform,
		kind: row.kind,
		provider_resource_id: row.providerResourceId,
		parent_id: row.parentId,
		name: row.name,
		status: row.status,
		configuration: objectValue(row.configuration),
		created_at: dateValue(row.createdAt).toISOString(),
		updated_at: dateValue(row.updatedAt).toISOString(),
	};
}

export async function createAdvancedAdResource(
	db: Database,
	input: {
		organizationId: string;
		workspaceId: string | null;
		adAccountId: string;
		platform: AdPlatform;
		kind: AdvancedResourceKind;
		providerResourceId?: string | null;
		parentId?: string | null;
		name?: string | null;
		status?: string;
		configuration: Record<string, unknown>;
	},
) {
	if (input.kind === "product_set") {
		if (!input.parentId) {
			throw new AdvancedAdStoreError(
				"NOT_FOUND",
				"Parent ad catalog not found",
			);
		}
		const parentRows = await db.execute<{ id: string }>(sql`
			SELECT id
			FROM ad_advanced_resources
			WHERE organization_id = ${input.organizationId}
			  AND id = ${input.parentId}
			  AND kind = 'catalog'
			  AND ad_account_id = ${input.adAccountId}
			  AND workspace_id IS NOT DISTINCT FROM ${input.workspaceId}
			  AND platform = ${input.platform}
			LIMIT 1
		`);
		if (!parentRows[0]) {
			throw new AdvancedAdStoreError(
				"NOT_FOUND",
				"Parent ad catalog not found",
			);
		}
	}
	const prefix: Record<AdvancedResourceKind, string> = {
		messaging_experience: "admsg_",
		creative_asset: "adasset_",
		catalog: "adcat_",
		product_set: "adps_",
	};
	const rows = await db.execute<AdvancedResourceSqlRow>(sql`
		INSERT INTO ad_advanced_resources (
			id, organization_id, workspace_id, ad_account_id, platform, kind,
			provider_resource_id, parent_id, name, status, configuration
		) VALUES (
			${generateId(prefix[input.kind])}, ${input.organizationId}, ${input.workspaceId},
			${input.adAccountId}, ${input.platform}, ${input.kind},
			${input.providerResourceId ?? null}, ${input.parentId ?? null},
			${input.name ?? null}, ${input.status ?? "linked"},
			${JSON.stringify(input.configuration)}::jsonb
		)
		RETURNING
			id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
			platform, kind, provider_resource_id AS "providerResourceId",
			parent_id AS "parentId", name, status, configuration,
			created_at AS "createdAt", updated_at AS "updatedAt"
	`);
	const row = rows[0];
	if (!row) throw new Error("Failed to create advanced ad resource");
	return serializeAdvancedResource(row);
}

interface ReportJobSqlRow extends Record<string, unknown> {
	id: string;
	workspaceId: string | null;
	adAccountId: string;
	platform: AdPlatform;
	status:
		| "pending"
		| "submitting"
		| "provider_pending"
		| "downloading"
		| "completed"
		| "failed"
		| "unknown"
		| "cancelled";
	requestPayload: unknown;
	requestHash: string;
	providerJobId: string | null;
	rowCount: number | null;
	resultExpiresAt: Date | null;
	lastError: string | null;
	createdAt: Date;
	updatedAt: Date;
	completedAt: Date | null;
}

/** Resolve a report job's account without returning its provider request. */
export async function getAdReportJobAuthority(
	db: Database,
	input: { organizationId: string; id: string },
): Promise<AdvancedAdResourceAuthority> {
	const rows = await db.execute<
		AdvancedAdResourceAuthority & Record<string, unknown>
	>(sql`
		SELECT
			ad_account_id AS "adAccountId", workspace_id AS "workspaceId", platform
		FROM ad_report_jobs
		WHERE organization_id = ${input.organizationId} AND id = ${input.id}
		LIMIT 1
	`);
	const row = rows[0];
	if (!row) {
		throw new AdvancedAdStoreError("NOT_FOUND", "Ad report job not found");
	}
	return row;
}

function serializeReportJob(row: ReportJobSqlRow) {
	return {
		id: row.id,
		workspace_id: row.workspaceId,
		ad_account_id: row.adAccountId,
		platform: row.platform,
		status: row.status,
		request: objectValue(row.requestPayload),
		provider_job_id: row.providerJobId,
		row_count: row.rowCount,
		result_expires_at: row.resultExpiresAt
			? dateValue(row.resultExpiresAt).toISOString()
			: null,
		last_error: row.lastError,
		created_at: dateValue(row.createdAt).toISOString(),
		updated_at: dateValue(row.updatedAt).toISOString(),
		completed_at: row.completedAt
			? dateValue(row.completedAt).toISOString()
			: null,
	};
}

export async function createAdReportJob(
	db: Database,
	input: {
		organizationId: string;
		workspaceId: string | null;
		adAccountId: string;
		platform: AdPlatform;
		operationKey: string;
		request: Record<string, unknown>;
	},
) {
	const hashes = await durableOperationHashes(
		input.organizationId,
		"ad_report_job",
		input.operationKey,
		input.request,
	);
	let rows = await db.execute<ReportJobSqlRow>(sql`
		INSERT INTO ad_report_jobs (
			id, organization_id, workspace_id, ad_account_id, platform,
			operation_key_hash, request_hash, request_payload, status, next_attempt_at
		) VALUES (
			${generateId("adrep_")}, ${input.organizationId}, ${input.workspaceId},
			${input.adAccountId}, ${input.platform}, ${hashes.operationKeyHash},
			${hashes.requestHash}, ${JSON.stringify(input.request)}::jsonb, 'pending', now()
		)
		ON CONFLICT (organization_id, operation_key_hash) DO NOTHING
		RETURNING
			id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
			platform, status, request_payload AS "requestPayload",
			request_hash AS "requestHash", provider_job_id AS "providerJobId",
			row_count AS "rowCount", result_expires_at AS "resultExpiresAt",
			last_error AS "lastError", created_at AS "createdAt",
			updated_at AS "updatedAt", completed_at AS "completedAt"
	`);
	if (!rows[0]) {
		rows = await db.execute<ReportJobSqlRow>(sql`
			SELECT
				id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
				platform, status, request_payload AS "requestPayload",
				request_hash AS "requestHash", provider_job_id AS "providerJobId",
				row_count AS "rowCount", result_expires_at AS "resultExpiresAt",
				last_error AS "lastError", created_at AS "createdAt",
				updated_at AS "updatedAt", completed_at AS "completedAt"
			FROM ad_report_jobs
			WHERE organization_id = ${input.organizationId}
			  AND operation_key_hash = ${hashes.operationKeyHash}
			LIMIT 1
		`);
	}
	const row = rows[0];
	if (!row) throw new Error("Failed to recover report job");
	if (row.requestHash !== hashes.requestHash) {
		throw new AdvancedAdStoreError(
			"IDEMPOTENCY_KEY_REUSED",
			"Idempotency-Key was already used for another report request",
		);
	}
	return serializeReportJob(row);
}

export async function getAdReportJob(
	db: Database,
	input: {
		organizationId: string;
		id: string;
		adAccountId: string;
		workspaceId: string | null;
	},
) {
	const rows = await db.execute<ReportJobSqlRow>(sql`
		SELECT
			id, workspace_id AS "workspaceId", ad_account_id AS "adAccountId",
			platform, status, request_payload AS "requestPayload",
			request_hash AS "requestHash", provider_job_id AS "providerJobId",
			row_count AS "rowCount", result_expires_at AS "resultExpiresAt",
			last_error AS "lastError", created_at AS "createdAt",
			updated_at AS "updatedAt", completed_at AS "completedAt"
		FROM ad_report_jobs
		WHERE organization_id = ${input.organizationId}
		  AND id = ${input.id}
		  AND ad_account_id = ${input.adAccountId}
		  AND workspace_id IS NOT DISTINCT FROM ${input.workspaceId}
		LIMIT 1
	`);
	const row = rows[0];
	if (!row)
		throw new AdvancedAdStoreError("NOT_FOUND", "Ad report job not found");
	return serializeReportJob(row);
}

export interface AdReportResultRow {
	dimensions: Record<string, unknown>;
	metrics: Record<string, string | number | null>;
}

export async function listAdReportResultRows(
	db: Database,
	input: {
		organizationId: string;
		reportJobId: string;
		cursor?: string;
		limit: number;
	},
): Promise<{
	data: AdReportResultRow[];
	next_cursor: string | null;
	has_more: boolean;
}> {
	const cursor = input.cursor ? Number(input.cursor) : 0;
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		throw new AdvancedAdStoreError(
			"INVALID_CURSOR",
			"Invalid report-row cursor",
		);
	}
	const rows = await db.execute<{
		rowNumber: number;
		dimensions: unknown;
		metrics: unknown;
	}>(sql`
		SELECT row_number AS "rowNumber", dimensions, metrics
		FROM ad_report_rows
		WHERE organization_id = ${input.organizationId}
		  AND report_job_id = ${input.reportJobId}
		  AND row_number > ${cursor}
		ORDER BY row_number ASC
		LIMIT ${input.limit + 1}
	`);
	const hasMore = rows.length > input.limit;
	const page = rows.slice(0, input.limit);
	return {
		data: page.map((row) => ({
			dimensions: objectValue(row.dimensions),
			metrics: objectValue(row.metrics) as Record<
				string,
				string | number | null
			>,
		})),
		next_cursor: hasMore ? String(page.at(-1)?.rowNumber ?? cursor) : null,
		has_more: hasMore,
	};
}

/** Remove expired encrypted lead payloads without retaining recoverable PII. */
export async function purgeExpiredAdvancedAdLeads(
	db: Database,
	now = new Date(),
	limit = 500,
): Promise<number> {
	const rows = await db.execute<{ id: string }>(sql`
		WITH due AS (
			SELECT id FROM ad_leads
			WHERE expires_at <= ${now}
			ORDER BY expires_at ASC, id ASC
			LIMIT ${Math.min(Math.max(limit, 1), 1000)}
			FOR UPDATE SKIP LOCKED
		)
		DELETE FROM ad_leads AS lead
		USING due
		WHERE lead.id = due.id
		RETURNING lead.id
	`);
	return rows.length;
}

export const ADVANCED_AD_REQUIRED_TABLES = [
	"ad_lead_forms",
	"ad_leads",
	"ad_conversion_rules",
	"ad_conversion_events",
	"ad_advanced_resources",
	"ad_report_jobs",
	"ad_report_rows",
] as const;
