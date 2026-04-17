import {
	automationEnrollments,
	automations,
	contacts,
	customFieldDefinitions,
	customFieldValues,
} from "@relayapi/db";
import { createDb } from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../../types";
import { matchesTriggerFilters } from "./filter-eval";

/**
 * Queries candidate automations and enrolls matches into AUTOMATION_QUEUE.
 * Called from platform-webhooks.ts after persisting the inbound event.
 */
export async function matchAndEnroll(
	env: Env,
	input: {
		organization_id: string;
		platform: string;
		trigger_type: string;
		account_id?: string;
		contact_id?: string | null;
		conversation_id?: string | null;
		payload: Record<string, unknown>;
	},
): Promise<string[]> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const candidates = await db
		.select()
		.from(automations)
		.where(
			and(
				eq(automations.organizationId, input.organization_id),
				eq(automations.status, "active"),
				eq(automations.triggerType, input.trigger_type as never),
			),
		);

	if (candidates.length === 0) return [];

	// Load contact context for filter evaluation (once, cached)
	let tags: string[] = [];
	let fields: Record<string, unknown> = {};
	let contact: Record<string, unknown> | null = null;
	if (input.contact_id) {
		const row = await db.query.contacts.findFirst({
			where: eq(contacts.id, input.contact_id),
		});
		if (row) {
			contact = row as unknown as Record<string, unknown>;
			tags = row.tags ?? [];
		}
		const fieldRows = await db
			.select({
				slug: customFieldDefinitions.slug,
				value: customFieldValues.value,
			})
			.from(customFieldValues)
			.leftJoin(
				customFieldDefinitions,
				eq(customFieldValues.definitionId, customFieldDefinitions.id),
			)
			.where(
				and(
					eq(customFieldValues.contactId, input.contact_id),
					eq(customFieldValues.organizationId, input.organization_id),
				),
			);
		for (const fr of fieldRows) {
			if (fr.slug) fields[fr.slug] = fr.value;
		}
	}

	const enrolledIds: string[] = [];

	for (const auto of candidates) {
		// Optional account scoping
		if (
			input.account_id &&
			auto.socialAccountId &&
			auto.socialAccountId !== input.account_id
		) {
			continue;
		}

		// Trigger config matching (keywords, post_id, etc.) — delegated to trigger-specific matcher
		if (!matchTriggerConfig(auto.triggerConfig as Record<string, unknown>, input.payload)) {
			continue;
		}

		// Filter check (tags, segments, predicates)
		if (
			!matchesTriggerFilters(
				(auto.triggerFilters as Record<string, unknown>) ?? {},
				{ tags, fields, contact },
			)
		) {
			continue;
		}

		// Re-entry guard
		if (!auto.allowReentry && input.contact_id) {
			const existing = await db.query.automationEnrollments.findFirst({
				where: and(
					eq(automationEnrollments.automationId, auto.id),
					eq(automationEnrollments.contactId, input.contact_id),
				),
			});
			if (existing) continue;
		}

		// Create enrollment
		const version = auto.publishedVersion ?? auto.version;
		const [created] = await db
			.insert(automationEnrollments)
			.values({
				automationId: auto.id,
				automationVersion: version,
				organizationId: auto.organizationId,
				contactId: input.contact_id ?? null,
				conversationId: input.conversation_id ?? null,
				state: input.payload,
				status: "active",
			})
			.returning({ id: automationEnrollments.id });

		if (created) {
			await db
				.update(automations)
				.set({
					totalEnrolled: sql`${automations.totalEnrolled} + 1`,
					updatedAt: new Date(),
				})
				.where(eq(automations.id, auto.id));

			await env.AUTOMATION_QUEUE.send({
				type: "advance",
				enrollment_id: created.id,
			});
			enrolledIds.push(created.id);
		}
	}

	return enrolledIds;
}

/**
 * Checks whether trigger config (e.g. keyword list, post_id) matches the incoming payload.
 * Trigger-type-specific matching is lightweight and declarative.
 */
function matchTriggerConfig(
	config: Record<string, unknown>,
	payload: Record<string, unknown>,
): boolean {
	// Keyword match (case-insensitive, substring by default)
	const keywords = config.keywords as string[] | undefined;
	const text =
		(payload.text as string | undefined) ??
		(payload.message as string | undefined) ??
		(payload.comment_text as string | undefined) ??
		"";
	const mode = (config.match_mode as string | undefined) ?? "contains";
	if (keywords && keywords.length > 0) {
		const lowered = text.toLowerCase();
		const matched = keywords.some((k) => {
			const kw = k.toLowerCase();
			return mode === "exact" ? lowered === kw : lowered.includes(kw);
		});
		if (!matched) return false;
	}

	// Post-scoped automations
	const postId = config.post_id as string | null | undefined;
	if (postId !== undefined && postId !== null) {
		const payloadPostId = payload.post_id as string | undefined;
		if (payloadPostId !== postId) return false;
	}

	return true;
}

/**
 * For platforms with pending-input enrollments: check if an inbound message
 * should resume a waiting flow instead of spawning a new enrollment.
 * Returns the enrollment id to resume, or null if none.
 */
export async function findWaitingEnrollment(
	env: Env,
	input: { organization_id: string; contact_id: string },
): Promise<string | null> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const row = await db.query.automationEnrollments.findFirst({
		where: and(
			eq(automationEnrollments.organizationId, input.organization_id),
			eq(automationEnrollments.contactId, input.contact_id),
			eq(automationEnrollments.status, "waiting"),
		),
	});
	if (!row) return null;
	// Only resume if waiting on user input (not on a timer)
	const state = (row.state as Record<string, unknown>) ?? {};
	if (!state._pending_input_field) return null;
	return row.id;
}
