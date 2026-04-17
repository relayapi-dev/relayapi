import {
	automationEnrollments,
	automations,
	contacts,
	customFieldDefinitions,
	customFieldValues,
} from "@relayapi/db";
import { createDb } from "@relayapi/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
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
		if (input.contact_id) {
			if (!auto.allowReentry) {
				const existing = await db.query.automationEnrollments.findFirst({
					where: and(
						eq(automationEnrollments.automationId, auto.id),
						eq(automationEnrollments.contactId, input.contact_id),
					),
				});
				if (existing) continue;
			} else if (auto.reentryCooldownMin && auto.reentryCooldownMin > 0) {
				// Cooldown enforcement: reject if this contact was enrolled in the
				// same automation within the last N minutes.
				const cooldownStart = new Date(
					Date.now() - auto.reentryCooldownMin * 60 * 1000,
				);
				const recent = await db
					.select({ id: automationEnrollments.id })
					.from(automationEnrollments)
					.where(
						and(
							eq(automationEnrollments.automationId, auto.id),
							eq(automationEnrollments.contactId, input.contact_id),
							gte(automationEnrollments.enrolledAt, cooldownStart),
						),
					)
					.orderBy(desc(automationEnrollments.enrolledAt))
					.limit(1);
				if (recent.length > 0) continue;
			}
		}

		// Skip automations that have never been published — the runner cannot
		// load a snapshot for them.
		if (auto.publishedVersion === null) continue;

		// Create enrollment
		const version = auto.publishedVersion;
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
			// Send to the queue FIRST — if enqueue fails we roll back the
			// enrollment row and don't touch the counter. Otherwise a transient
			// queue error would orphan the row in `active` with no worker to
			// advance it, while the counter wrongly reported an enrollment.
			try {
				await env.AUTOMATION_QUEUE.send({
					type: "advance",
					enrollment_id: created.id,
				});
			} catch (err) {
				console.error(
					"[trigger-matcher] AUTOMATION_QUEUE.send failed; rolling back enrollment",
					created.id,
					err,
				);
				await db
					.delete(automationEnrollments)
					.where(eq(automationEnrollments.id, created.id));
				continue;
			}

			await db
				.update(automations)
				.set({
					totalEnrolled: sql`${automations.totalEnrolled} + 1`,
					updatedAt: new Date(),
				})
				.where(eq(automations.id, auto.id));

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
 *
 * Scoping rules:
 *  - must be `status=waiting` with `_pending_input_field` (not a timer wait)
 *  - must match the inbound channel if the waiting node recorded one
 *  - must match the conversation_id if the waiting node recorded one, so a
 *    DM from a different channel of the same contact doesn't short-circuit
 *    a paused DM flow
 *  - most recently enrolled wait wins, so stale waits can't hijack new ones
 */
export async function findWaitingEnrollment(
	env: Env,
	input: {
		organization_id: string;
		contact_id: string;
		channel?: string;
		conversation_id?: string | null;
	},
): Promise<string | null> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const rows = await db
		.select()
		.from(automationEnrollments)
		.where(
			and(
				eq(automationEnrollments.organizationId, input.organization_id),
				eq(automationEnrollments.contactId, input.contact_id),
				eq(automationEnrollments.status, "waiting"),
			),
		)
		.orderBy(desc(automationEnrollments.enrolledAt));

	for (const row of rows) {
		const state = (row.state as Record<string, unknown>) ?? {};
		if (!state._pending_input_field) continue;

		const waitingChannel = state._pending_input_channel as string | undefined;
		if (waitingChannel && input.channel && waitingChannel !== input.channel) {
			continue;
		}

		const waitingConvo = state._pending_input_conversation_id as
			| string
			| null
			| undefined;
		if (
			waitingConvo !== undefined &&
			waitingConvo !== null &&
			input.conversation_id &&
			waitingConvo !== input.conversation_id
		) {
			continue;
		}

		return row.id;
	}
	return null;
}
