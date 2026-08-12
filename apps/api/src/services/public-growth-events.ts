import type { z } from "@hono/zod-openapi";
import {
	automations,
	contacts,
	createDb,
	type Database,
	generateId,
	landingPages,
	organization,
	publicGrowthEvents,
	qrCodes,
	refUrls,
	workspaces,
} from "@relayapi/db";
import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { normalizeContactPhone } from "../lib/contact-phone";
import { sha256Hex } from "../lib/durable-operation";
import {
	LandingPageConfig,
	type LandingPageConversionSpec,
} from "../schemas/landing-pages";
import type { Env } from "../types";
import { matchAndEnroll } from "./automations/trigger-matcher";
import {
	decryptContactRow,
	deriveContactEmailHash,
	deriveContactPhoneHash,
	protectContactEmail,
	protectContactName,
	protectContactPhone,
	protectContactValues,
} from "./contact-protection";

const LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 8;
const MAX_BATCH = 100;
const ANONYMOUS_RETENTION_DAYS = 7;
const IDENTIFIED_RETENTION_DAYS = 90;
const CLEANUP_BATCH = 5_000;

type LandingFields = z.infer<typeof LandingPageConversionSpec>["fields"];
type GrowthTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type GrowthRecordFailure =
	| "not_found"
	| "disabled"
	| "contact_not_found"
	| "contact_scope_conflict"
	| "invalid_form";

export type GrowthRecordResult<T> =
	| { ok: true; inserted: boolean; value: T }
	| { ok: false; reason: GrowthRecordFailure; message?: string };

function terminalDispatchFields(dispatchable: boolean, now: Date) {
	return dispatchable
		? {
				status: "pending" as const,
				completedAt: null,
			}
		: {
				status: "succeeded" as const,
				completedAt: now,
			};
}

async function growthIdempotencyHash(
	organizationId: string,
	eventType: "ref_visit" | "qr_scan" | "landing_view" | "landing_conversion",
	targetId: string,
	key: string,
): Promise<string> {
	return sha256Hex(
		`public-growth:v1:${organizationId}:${eventType}:${targetId}:${key}`,
	);
}

async function lockDispatchAutomation(
	tx: GrowthTransaction,
	input: {
		automationId: string | null;
		organizationId: string;
		scopeKey: string;
	},
): Promise<string | null> {
	if (!input.automationId) return null;
	const [automation] = await tx
		.select({ id: automations.id })
		.from(automations)
		.where(
			and(
				eq(automations.id, input.automationId),
				eq(automations.organizationId, input.organizationId),
				eq(automations.scopeKey, input.scopeKey),
			),
		)
		.for("key share")
		.limit(1);
	return automation?.id ?? null;
}

async function lockActiveOrganization(
	tx: GrowthTransaction,
	organizationId: string,
): Promise<boolean> {
	const [active] = await tx
		.select({ id: organization.id })
		.from(organization)
		.where(
			and(
				eq(organization.id, organizationId),
				eq(organization.lifecycleStatus, "active"),
			),
		)
		.for("key share")
		.limit(1);
	return Boolean(active);
}

async function lockActiveWorkspace(
	tx: GrowthTransaction,
	input: { organizationId: string; workspaceId: string | null },
): Promise<boolean> {
	if (!input.workspaceId) return true;
	const [active] = await tx
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(
			and(
				eq(workspaces.id, input.workspaceId),
				eq(workspaces.organizationId, input.organizationId),
				eq(workspaces.lifecycleStatus, "active"),
			),
		)
		.for("key share")
		.limit(1);
	return Boolean(active);
}

export async function recordRefVisit(
	db: Database,
	input: {
		organizationId: string;
		refUrlId: string;
		contactId?: string | null;
		idempotencyKey: string;
		requireEnabled?: boolean;
	},
): Promise<GrowthRecordResult<typeof refUrls.$inferSelect>> {
	return db.transaction(async (tx) => {
		if (!(await lockActiveOrganization(tx, input.organizationId))) {
			return { ok: false, reason: "disabled" };
		}
		const [scope] = await tx
			.select({ workspaceId: refUrls.workspaceId })
			.from(refUrls)
			.where(
				and(
					eq(refUrls.id, input.refUrlId),
					eq(refUrls.organizationId, input.organizationId),
				),
			)
			.limit(1);
		if (!scope) return { ok: false, reason: "not_found" };
		if (
			!(await lockActiveWorkspace(tx, {
				organizationId: input.organizationId,
				workspaceId: scope.workspaceId,
			}))
		) {
			return { ok: false, reason: "disabled" };
		}
		const [ref] = await tx
			.select()
			.from(refUrls)
			.where(
				and(
					eq(refUrls.id, input.refUrlId),
					eq(refUrls.organizationId, input.organizationId),
				),
			)
			.for("key share")
			.limit(1);
		if (!ref) return { ok: false, reason: "not_found" };
		if (ref.workspaceId !== scope.workspaceId) {
			return { ok: false, reason: "disabled" };
		}
		if ((input.requireEnabled ?? true) && !ref.enabled) {
			return { ok: false, reason: "disabled" };
		}

		if (input.contactId) {
			const [contact] = await tx
				.select({ scopeKey: contacts.scopeKey })
				.from(contacts)
				.where(
					and(
						eq(contacts.id, input.contactId),
						eq(contacts.organizationId, input.organizationId),
					),
				)
				.for("key share")
				.limit(1);
			if (!contact) return { ok: false, reason: "contact_not_found" };
			if (contact.scopeKey !== ref.scopeKey) {
				return { ok: false, reason: "contact_scope_conflict" };
			}
		}

		const automationId = await lockDispatchAutomation(tx, {
			automationId: ref.automationId,
			organizationId: ref.organizationId,
			scopeKey: ref.scopeKey,
		});
		const now = new Date();
		const idempotencyHash = await growthIdempotencyHash(
			ref.organizationId,
			"ref_visit",
			ref.id,
			input.idempotencyKey,
		);
		const [event] = await tx
			.insert(publicGrowthEvents)
			.values({
				organizationId: ref.organizationId,
				scopeKey: ref.scopeKey,
				eventType: "ref_visit",
				refUrlId: ref.id,
				contactId: input.contactId ?? null,
				contactOrganizationId: input.contactId ? ref.organizationId : null,
				contactScopeKey: input.contactId ? ref.scopeKey : null,
				automationId,
				automationOrganizationId: automationId ? ref.organizationId : null,
				automationScopeKey: automationId ? ref.scopeKey : null,
				idempotencyHash,
				occurredAt: now,
				updatedAt: now,
				nextAttemptAt: now,
				...terminalDispatchFields(
					Boolean(input.contactId && automationId),
					now,
				),
			})
			.onConflictDoNothing()
			.returning({ id: publicGrowthEvents.id });
		if (!event) return { ok: true, inserted: false, value: ref };

		const [updated] = await tx
			.update(refUrls)
			.set({
				uses: sql`${refUrls.uses} + 1`,
				updatedAt: now,
			})
			.where(eq(refUrls.id, ref.id))
			.returning();
		if (!updated) throw new Error("Reference URL disappeared during visit");
		return { ok: true, inserted: true, value: updated };
	});
}

export async function recordQrScan(
	db: Database,
	input: { publicId: string; idempotencyKey: string },
): Promise<
	GrowthRecordResult<{
		qrCode: typeof qrCodes.$inferSelect;
		refUrl: typeof refUrls.$inferSelect;
	}>
> {
	return db.transaction(async (tx) => {
		const [scope] = await tx
			.select({
				organizationId: qrCodes.organizationId,
				workspaceId: refUrls.workspaceId,
			})
			.from(qrCodes)
			.innerJoin(
				refUrls,
				and(
					eq(refUrls.id, qrCodes.refUrlId),
					eq(refUrls.organizationId, qrCodes.organizationId),
					eq(refUrls.scopeKey, qrCodes.scopeKey),
				),
			)
			.where(eq(qrCodes.publicId, input.publicId))
			.limit(1);
		if (!scope) return { ok: false, reason: "not_found" };
		if (!(await lockActiveOrganization(tx, scope.organizationId))) {
			return { ok: false, reason: "disabled" };
		}
		if (
			!(await lockActiveWorkspace(tx, {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
			}))
		) {
			return { ok: false, reason: "disabled" };
		}
		const [row] = await tx
			.select({
				qrCode: qrCodes,
				refUrl: refUrls,
				organizationLifecycleStatus: organization.lifecycleStatus,
				workspaceLifecycleStatus: workspaces.lifecycleStatus,
				landingEnabled: landingPages.enabled,
			})
			.from(qrCodes)
			.innerJoin(
				refUrls,
				and(
					eq(refUrls.id, qrCodes.refUrlId),
					eq(refUrls.organizationId, qrCodes.organizationId),
					eq(refUrls.scopeKey, qrCodes.scopeKey),
				),
			)
			.innerJoin(organization, eq(organization.id, qrCodes.organizationId))
			.leftJoin(
				workspaces,
				and(
					eq(workspaces.id, refUrls.workspaceId),
					eq(workspaces.organizationId, refUrls.organizationId),
				),
			)
			.leftJoin(
				landingPages,
				and(
					eq(landingPages.id, refUrls.landingPageId),
					eq(landingPages.organizationId, refUrls.organizationId),
					eq(landingPages.scopeKey, refUrls.scopeKey),
				),
			)
			.where(eq(qrCodes.publicId, input.publicId))
			.for("key share", { of: [qrCodes, refUrls] })
			.limit(1);
		if (!row) return { ok: false, reason: "not_found" };
		if (
			!row.refUrl.enabled ||
			row.organizationLifecycleStatus !== "active" ||
			(row.refUrl.workspaceId && row.workspaceLifecycleStatus !== "active") ||
			(row.refUrl.destinationType === "landing_page" && !row.landingEnabled)
		) {
			return { ok: false, reason: "disabled" };
		}
		if (row.refUrl.workspaceId !== scope.workspaceId) {
			return { ok: false, reason: "disabled" };
		}

		const now = new Date();
		const idempotencyHash = await growthIdempotencyHash(
			row.qrCode.organizationId,
			"qr_scan",
			row.qrCode.id,
			input.idempotencyKey,
		);
		const [event] = await tx
			.insert(publicGrowthEvents)
			.values({
				organizationId: row.qrCode.organizationId,
				scopeKey: row.qrCode.scopeKey,
				eventType: "qr_scan",
				qrCodeId: row.qrCode.id,
				idempotencyHash,
				occurredAt: now,
				updatedAt: now,
				nextAttemptAt: now,
				...terminalDispatchFields(false, now),
			})
			.onConflictDoNothing()
			.returning({ id: publicGrowthEvents.id });
		if (!event) {
			return {
				ok: true,
				inserted: false,
				value: { qrCode: row.qrCode, refUrl: row.refUrl },
			};
		}

		const [updatedQr] = await tx
			.update(qrCodes)
			.set({
				scanCount: sql`${qrCodes.scanCount} + 1`,
				updatedAt: now,
			})
			.where(eq(qrCodes.id, row.qrCode.id))
			.returning();
		const [updatedRef] = await tx
			.update(refUrls)
			.set({
				uses: sql`${refUrls.uses} + 1`,
				updatedAt: now,
			})
			.where(eq(refUrls.id, row.refUrl.id))
			.returning();
		if (!updatedQr || !updatedRef) {
			throw new Error("QR target disappeared during scan");
		}
		return {
			ok: true,
			inserted: true,
			value: { qrCode: updatedQr, refUrl: updatedRef },
		};
	});
}

export async function recordLandingView(
	db: Database,
	input: {
		organizationId: string;
		landingPageId: string;
		idempotencyKey: string;
	},
): Promise<GrowthRecordResult<typeof landingPages.$inferSelect>> {
	return db.transaction(async (tx) => {
		if (!(await lockActiveOrganization(tx, input.organizationId))) {
			return { ok: false, reason: "disabled" };
		}
		const [scope] = await tx
			.select({ workspaceId: landingPages.workspaceId })
			.from(landingPages)
			.where(
				and(
					eq(landingPages.id, input.landingPageId),
					eq(landingPages.organizationId, input.organizationId),
				),
			)
			.limit(1);
		if (!scope) return { ok: false, reason: "not_found" };
		if (
			!(await lockActiveWorkspace(tx, {
				organizationId: input.organizationId,
				workspaceId: scope.workspaceId,
			}))
		) {
			return { ok: false, reason: "disabled" };
		}
		const [page] = await tx
			.select()
			.from(landingPages)
			.where(
				and(
					eq(landingPages.id, input.landingPageId),
					eq(landingPages.organizationId, input.organizationId),
				),
			)
			.for("key share")
			.limit(1);
		if (!page) return { ok: false, reason: "not_found" };
		if (page.workspaceId !== scope.workspaceId) {
			return { ok: false, reason: "disabled" };
		}
		if (!page.enabled) return { ok: false, reason: "disabled" };

		const now = new Date();
		const idempotencyHash = await growthIdempotencyHash(
			page.organizationId,
			"landing_view",
			page.id,
			input.idempotencyKey,
		);
		const [event] = await tx
			.insert(publicGrowthEvents)
			.values({
				organizationId: page.organizationId,
				scopeKey: page.scopeKey,
				eventType: "landing_view",
				landingPageId: page.id,
				idempotencyHash,
				occurredAt: now,
				updatedAt: now,
				nextAttemptAt: now,
				...terminalDispatchFields(false, now),
			})
			.onConflictDoNothing()
			.returning({ id: publicGrowthEvents.id });
		if (!event) return { ok: true, inserted: false, value: page };

		const [updated] = await tx
			.update(landingPages)
			.set({
				visits: sql`${landingPages.visits} + 1`,
				updatedAt: now,
			})
			.where(eq(landingPages.id, page.id))
			.returning();
		if (!updated) throw new Error("Landing page disappeared during view");
		return { ok: true, inserted: true, value: updated };
	});
}

function configuredForm(config: z.infer<typeof LandingPageConfig>) {
	return config.blocks.find((block) => block.type === "form");
}

export function validateLandingFields(
	config: z.infer<typeof LandingPageConfig>,
	fields: LandingFields,
): { ok: true } | { ok: false; message: string } {
	const form = configuredForm(config);
	if (!form) return { ok: false, message: "This page has no form." };
	const configured = new Map(form.fields.map((field) => [field.key, field]));
	for (const key of Object.keys(fields) as Array<keyof LandingFields>) {
		if (fields[key] !== undefined && !configured.has(key)) {
			return { ok: false, message: `Field '${key}' is not accepted.` };
		}
	}
	for (const field of form.fields) {
		const value = fields[field.key]?.trim();
		if (field.required && !value) {
			return { ok: false, message: `Field '${field.key}' is required.` };
		}
	}
	if (!fields.email && !fields.phone) {
		return {
			ok: false,
			message: "An email address or E.164 phone number is required.",
		};
	}
	return { ok: true };
}

async function resolveLandingContact(
	tx: GrowthTransaction,
	input: {
		organizationId: string;
		workspaceId: string | null;
		scopeKey: string;
		fields: LandingFields;
		keyConfig: string;
	},
): Promise<typeof contacts.$inferSelect> {
	const email = input.fields.email?.trim().toLowerCase();
	const phone = input.fields.phone?.trim();
	const phoneCanonical = phone ? normalizeContactPhone(phone) : undefined;
	const [emailHash, phoneHash] = await Promise.all([
		email
			? deriveContactEmailHash(
					input.keyConfig,
					input.organizationId,
					email,
				)
			: null,
		phoneCanonical
			? deriveContactPhoneHash(
					input.keyConfig,
					input.organizationId,
					phoneCanonical,
				)
			: null,
	]);
	const identities = [
		emailHash ? `email:${emailHash}` : null,
		phoneHash ? `phone:${phoneHash}` : null,
	]
		.filter((identity): identity is string => identity !== null)
		.sort();
	for (const identity of identities) {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`landing-contact:${input.organizationId}:${input.scopeKey}:${identity}`}, 0))`,
		);
	}

	const identityConditions = [];
	if (emailHash) identityConditions.push(eq(contacts.emailHash, emailHash));
	if (phoneHash) {
		identityConditions.push(eq(contacts.phoneHash, phoneHash));
	}
	const existingMatches = await tx
		.select()
		.from(contacts)
		.where(
			and(
				eq(contacts.organizationId, input.organizationId),
				eq(contacts.scopeKey, input.scopeKey),
				or(...identityConditions),
			),
		)
		.orderBy(asc(contacts.createdAt), asc(contacts.id))
		.for("update")
		.limit(2);
	if (existingMatches.length > 1) {
		throw new LandingContactIdentityConflictError();
	}
	const existing = existingMatches[0];

	if (existing) {
		const plaintextExisting = await decryptContactRow(
			input.keyConfig,
			existing,
		);
		const updates: Partial<typeof contacts.$inferInsert> = {};
		if (!plaintextExisting.name && input.fields.name) {
			Object.assign(
				updates,
				await protectContactName(
					input.keyConfig,
					input.organizationId,
					existing.id,
					input.fields.name,
				),
			);
		}
		if (!plaintextExisting.email && input.fields.email) {
			Object.assign(
				updates,
				await protectContactEmail(
					input.keyConfig,
					input.organizationId,
					existing.id,
					input.fields.email,
				),
			);
		}
		if (!plaintextExisting.phone && phone && phoneCanonical) {
			Object.assign(
				updates,
				await protectContactPhone(
					input.keyConfig,
					input.organizationId,
					existing.id,
					phone,
				),
			);
		}
		if (Object.keys(updates).length === 0) return existing;
		const [updated] = await tx
			.update(contacts)
			.set({ ...updates, updatedAt: new Date() })
			.where(eq(contacts.id, existing.id))
			.returning();
		if (!updated) throw new Error("Contact disappeared during conversion");
		return updated;
	}

	const contactId = generateId("ct_");
	const protectedContact = await protectContactValues(
		input.keyConfig,
		input.organizationId,
		contactId,
		{
			name: input.fields.name ?? null,
			email: input.fields.email ?? null,
			phone: phone ?? null,
			metadata: { source: "landing_page" },
		},
	);
	const [created] = await tx
		.insert(contacts)
		.values({
			id: contactId,
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
			...protectedContact,
		})
		.returning();
	if (!created) throw new Error("Failed to create landing-page contact");
	return created;
}

class LandingContactIdentityConflictError extends Error {
	constructor() {
		super(
			"The submitted email address and phone number belong to different contacts.",
		);
		this.name = "LandingContactIdentityConflictError";
	}
}

export async function recordLandingConversion(
	db: Database,
	input: {
		organizationId: string;
		landingPageId: string;
		idempotencyKey: string;
		fields: LandingFields;
		keyConfig: string;
	},
): Promise<
	GrowthRecordResult<{
		page: typeof landingPages.$inferSelect;
		contact: typeof contacts.$inferSelect | null;
		successMessage: string;
	}>
> {
	try {
		return await db.transaction(async (tx) => {
			if (!(await lockActiveOrganization(tx, input.organizationId))) {
				return { ok: false, reason: "disabled" };
			}
			const [scope] = await tx
				.select({ workspaceId: landingPages.workspaceId })
				.from(landingPages)
				.where(
					and(
						eq(landingPages.id, input.landingPageId),
						eq(landingPages.organizationId, input.organizationId),
					),
				)
				.limit(1);
			if (!scope) return { ok: false, reason: "not_found" };
			if (
				!(await lockActiveWorkspace(tx, {
					organizationId: input.organizationId,
					workspaceId: scope.workspaceId,
				}))
			) {
				return { ok: false, reason: "disabled" };
			}
			const [page] = await tx
				.select()
				.from(landingPages)
				.where(
					and(
						eq(landingPages.id, input.landingPageId),
						eq(landingPages.organizationId, input.organizationId),
					),
				)
				.for("key share")
				.limit(1);
			if (!page) return { ok: false, reason: "not_found" };
			if (page.workspaceId !== scope.workspaceId) {
				return { ok: false, reason: "disabled" };
			}
			if (!page.enabled) return { ok: false, reason: "disabled" };

			const parsedConfig = LandingPageConfig.safeParse(page.config);
			if (!parsedConfig.success) {
				return {
					ok: false,
					reason: "invalid_form",
					message: "The published form configuration is invalid.",
				};
			}
			const validated = validateLandingFields(parsedConfig.data, input.fields);
			if (!validated.ok) {
				return {
					ok: false,
					reason: "invalid_form",
					message: validated.message,
				};
			}

			const idempotencyHash = await growthIdempotencyHash(
				page.organizationId,
				"landing_conversion",
				page.id,
				input.idempotencyKey,
			);
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`landing-conversion:${idempotencyHash}`}, 0))`,
			);
			const [existingEvent] = await tx
				.select({ contactId: publicGrowthEvents.contactId })
				.from(publicGrowthEvents)
				.where(
					and(
						eq(publicGrowthEvents.organizationId, page.organizationId),
						eq(publicGrowthEvents.eventType, "landing_conversion"),
						eq(publicGrowthEvents.landingPageId, page.id),
						eq(publicGrowthEvents.idempotencyHash, idempotencyHash),
					),
				)
				.limit(1);
			if (existingEvent) {
				const contact = existingEvent.contactId
					? ((
							await tx
								.select()
								.from(contacts)
								.where(eq(contacts.id, existingEvent.contactId))
								.limit(1)
						)[0] ?? null)
					: null;
				return {
					ok: true,
					inserted: false,
					value: {
						page,
						contact,
						successMessage:
							configuredForm(parsedConfig.data)?.success_message ??
							"Thank you.",
					},
				};
			}

			const contact = await resolveLandingContact(tx, {
				organizationId: page.organizationId,
				workspaceId: page.workspaceId,
				scopeKey: page.scopeKey,
				fields: input.fields,
				keyConfig: input.keyConfig,
			});
			const automationId = await lockDispatchAutomation(tx, {
				automationId: page.automationId,
				organizationId: page.organizationId,
				scopeKey: page.scopeKey,
			});
			const now = new Date();
			const [event] = await tx
				.insert(publicGrowthEvents)
				.values({
					organizationId: page.organizationId,
					scopeKey: page.scopeKey,
					eventType: "landing_conversion",
					landingPageId: page.id,
					contactId: contact.id,
					contactOrganizationId: page.organizationId,
					contactScopeKey: page.scopeKey,
					automationId,
					automationOrganizationId: automationId ? page.organizationId : null,
					automationScopeKey: automationId ? page.scopeKey : null,
					idempotencyHash,
					occurredAt: now,
					updatedAt: now,
					nextAttemptAt: now,
					...terminalDispatchFields(Boolean(automationId), now),
				})
				.onConflictDoNothing()
				.returning({ id: publicGrowthEvents.id });
			if (!event) {
				throw new Error("Landing conversion idempotency fence was lost");
			}

			const [updatedPage] = await tx
				.update(landingPages)
				.set({
					conversions: sql`${landingPages.conversions} + 1`,
					updatedAt: now,
				})
				.where(eq(landingPages.id, page.id))
				.returning();
			if (!updatedPage) {
				throw new Error("Landing page disappeared during conversion");
			}
			return {
				ok: true,
				inserted: true,
				value: {
					page: updatedPage,
					contact,
					successMessage:
						configuredForm(parsedConfig.data)?.success_message ?? "Thank you.",
				},
			};
		});
	} catch (error) {
		if (error instanceof LandingContactIdentityConflictError) {
			return { ok: false, reason: "invalid_form", message: error.message };
		}
		throw error;
	}
}

async function dispatchGrowthEvent(
	db: Database,
	env: Env,
	row: typeof publicGrowthEvents.$inferSelect,
): Promise<void> {
	if (!row.contactId || !row.automationId) return;
	const [automation] = await db
		.select({ id: automations.id, channel: automations.channel })
		.from(automations)
		.where(
			and(
				eq(automations.id, row.automationId),
				eq(automations.organizationId, row.organizationId),
				eq(automations.scopeKey, row.scopeKey),
			),
		)
		.limit(1);
	if (!automation) return;
	if (
		automation.channel !== "instagram" &&
		automation.channel !== "facebook" &&
		automation.channel !== "whatsapp" &&
		automation.channel !== "telegram"
	) {
		return;
	}

	let refUrlId = row.refUrlId;
	if (row.qrCodeId) {
		const [qr] = await db
			.select({ refUrlId: qrCodes.refUrlId })
			.from(qrCodes)
			.where(eq(qrCodes.id, row.qrCodeId))
			.limit(1);
		refUrlId = qr?.refUrlId ?? null;
	}
	const kind =
		row.eventType === "landing_conversion"
			? ("conversion_event" as const)
			: ("ref_link_click" as const);
	await matchAndEnroll(
		db,
		{
			kind,
			channel: automation.channel,
			organizationId: row.organizationId,
			socialAccountId: null,
			contactId: row.contactId,
			conversationId: null,
			refUrlId: refUrlId ?? undefined,
			eventName:
				row.eventType === "landing_conversion"
					? "landing_page_conversion"
					: undefined,
			triggerOccurrenceId: row.id,
			payload: {
				source: "public_growth_event",
				public_growth_event_id: row.id,
				event_type: row.eventType,
				ref_url_id: refUrlId,
				qr_code_id: row.qrCodeId,
				landing_page_id: row.landingPageId,
			},
		},
		env as unknown as Record<string, unknown>,
		{
			pinnedAutomationId: row.automationId,
			deferRun: true,
			contextOverrides: { public_growth_event_id: row.id },
		},
	);
}

export async function processPublicGrowthEvents(
	env: Env,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	limit = 50,
): Promise<{ processed: number; cleaned: number }> {
	const batchSize = Math.min(Math.max(Math.trunc(limit), 1), MAX_BATCH);
	const now = new Date();
	await db.execute(sql`
		WITH exhausted AS (
			SELECT id
			FROM public_growth_events
			WHERE attempts >= ${MAX_ATTEMPTS}
			  AND (
				  (status IN ('pending', 'retry') AND next_attempt_at <= ${now})
				  OR (status = 'processing' AND lease_expires_at <= ${now})
			  )
			ORDER BY next_attempt_at, occurred_at, id
			LIMIT ${MAX_BATCH}
			FOR UPDATE SKIP LOCKED
		)
		UPDATE public_growth_events AS event
		SET status = 'failed',
		    lease_expires_at = NULL,
		    completed_at = ${now},
		    last_error = COALESCE(
			    event.last_error,
			    'Dispatch lease expired at the application attempt limit'
		    ),
		    updated_at = ${now}
		FROM exhausted
		WHERE event.id = exhausted.id
	`);
	const eligibility = or(
		and(
			inArray(publicGrowthEvents.status, ["pending", "retry"]),
			lte(publicGrowthEvents.nextAttemptAt, now),
		),
		and(
			eq(publicGrowthEvents.status, "processing"),
			lte(publicGrowthEvents.leaseExpiresAt, now),
		),
	);
	const rankedEligible = db
		.select({
			id: publicGrowthEvents.id,
			tenantRank: sql<number>`row_number() OVER (
					PARTITION BY ${publicGrowthEvents.organizationId}
					ORDER BY ${publicGrowthEvents.nextAttemptAt}, ${publicGrowthEvents.occurredAt}, ${publicGrowthEvents.id}
				)`.as("tenant_rank"),
		})
		.from(publicGrowthEvents)
		.where(and(lt(publicGrowthEvents.attempts, MAX_ATTEMPTS), eligibility))
		.as("ranked_public_growth_events");
	const candidateRows = await db
		.select({ event: publicGrowthEvents })
		.from(publicGrowthEvents)
		.innerJoin(rankedEligible, eq(rankedEligible.id, publicGrowthEvents.id))
		.orderBy(
			asc(rankedEligible.tenantRank),
			asc(publicGrowthEvents.nextAttemptAt),
			asc(publicGrowthEvents.occurredAt),
			asc(publicGrowthEvents.organizationId),
			asc(publicGrowthEvents.id),
		)
		.limit(batchSize);
	const candidates = candidateRows.map((row) => row.event);

	let processed = 0;
	for (const candidate of candidates) {
		const claimedAt = new Date();
		const [claimed] = await db
			.update(publicGrowthEvents)
			.set({
				status: "processing",
				attempts: sql`${publicGrowthEvents.attempts} + 1`,
				leaseToken: sql`${publicGrowthEvents.leaseToken} + 1`,
				leaseExpiresAt: new Date(claimedAt.getTime() + LEASE_MS),
				lastError: null,
				updatedAt: claimedAt,
			})
			.where(
				and(
					eq(publicGrowthEvents.id, candidate.id),
					lt(publicGrowthEvents.attempts, MAX_ATTEMPTS),
					or(
						and(
							inArray(publicGrowthEvents.status, ["pending", "retry"]),
							lte(publicGrowthEvents.nextAttemptAt, claimedAt),
						),
						and(
							eq(publicGrowthEvents.status, "processing"),
							lte(publicGrowthEvents.leaseExpiresAt, claimedAt),
						),
					),
				),
			)
			.returning();
		if (!claimed) continue;

		try {
			await dispatchGrowthEvent(db, env, claimed);
			const completedAt = new Date();
			const [completed] = await db
				.update(publicGrowthEvents)
				.set({
					status: "succeeded",
					leaseExpiresAt: null,
					completedAt,
					lastError: null,
					updatedAt: completedAt,
				})
				.where(
					and(
						eq(publicGrowthEvents.id, claimed.id),
						eq(publicGrowthEvents.status, "processing"),
						eq(publicGrowthEvents.leaseToken, claimed.leaseToken),
					),
				)
				.returning({ id: publicGrowthEvents.id });
			if (completed) processed += 1;
		} catch (error) {
			const terminal = claimed.attempts >= MAX_ATTEMPTS;
			const failedAt = new Date();
			const retrySeconds = Math.min(3600, 2 ** Math.min(claimed.attempts, 10));
			await db
				.update(publicGrowthEvents)
				.set({
					status: terminal ? "failed" : "retry",
					leaseExpiresAt: null,
					completedAt: terminal ? failedAt : null,
					nextAttemptAt: terminal
						? claimed.nextAttemptAt
						: new Date(failedAt.getTime() + retrySeconds * 1000),
					lastError: (error instanceof Error
						? error.message
						: String(error)
					).slice(0, 2_000),
					updatedAt: failedAt,
				})
				.where(
					and(
						eq(publicGrowthEvents.id, claimed.id),
						eq(publicGrowthEvents.status, "processing"),
						eq(publicGrowthEvents.leaseToken, claimed.leaseToken),
					),
				);
		}
	}

	const cleanupResult = await db.execute<{ deleted_count: string }>(sql`
		WITH expired AS (
			SELECT id
			FROM public_growth_events
			WHERE status IN ('succeeded', 'failed')
			  AND (
				  (
					  contact_id IS NULL
					  AND completed_at < NOW() - make_interval(days => ${ANONYMOUS_RETENTION_DAYS})
				  )
				  OR (
					  contact_id IS NOT NULL
					  AND completed_at < NOW() - make_interval(days => ${IDENTIFIED_RETENTION_DAYS})
				  )
			  )
			  AND NOT EXISTS (
				  SELECT 1
				  FROM erasure_holds AS hold
				  WHERE hold.released_at IS NULL
				    AND hold.organization_tombstone_id = public_growth_events.organization_id
				    AND (
					    (hold.subject_kind = 'organization'
						    AND hold.subject_id = public_growth_events.organization_id)
					    OR (
						    hold.subject_kind = 'workspace'
						    AND public_growth_events.scope_key LIKE 'ws/%'
						    AND hold.subject_id = substring(public_growth_events.scope_key FROM 4)
					    )
				    )
			  )
			ORDER BY completed_at, id
			LIMIT ${CLEANUP_BATCH}
			FOR UPDATE SKIP LOCKED
		),
		deleted AS (
			DELETE FROM public_growth_events AS event
			USING expired
			WHERE event.id = expired.id
			RETURNING 1
		)
		SELECT count(*)::text AS deleted_count
		FROM deleted
	`);
	return {
		processed,
		cleaned: Number(cleanupResult[0]?.deleted_count ?? 0),
	};
}
