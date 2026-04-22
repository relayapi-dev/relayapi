// apps/api/src/services/automations/trigger-matcher.ts
//
// Runtime trigger matching for the Manychat-parity automation engine.
// See docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md
// §6 (Entrypoints & Bindings) + §6.6 (Runtime match algorithm).
//
// Replaces the legacy triggers-and-enrollments matcher. The outer shape now
// queries `automation_entrypoints` instead of `automation_triggers`, but the
// per-kind matching semantics (keyword modes, post/asset id filters, filter
// group evaluation) are preserved from the legacy implementation.

import {
	automationContactControls,
	automationEntrypoints,
	automationRuns,
	automations,
	contacts,
	customFieldDefinitions,
	customFieldValues,
	type Database,
} from "@relayapi/db";
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { evaluateFilterGroup } from "./filter-eval";
import { enrollContact } from "./runner";

export type InboundEventKind =
	| "dm_received"
	| "comment_created"
	| "story_reply"
	| "story_mention"
	| "live_comment"
	| "share_to_dm"
	| "follow"
	| "ad_click"
	| "ref_link_click"
	| "tag_applied"
	| "tag_removed"
	| "field_changed"
	| "conversion_event";

export type InboundEvent = {
	kind: InboundEventKind | "schedule";
	channel: "instagram" | "facebook" | "whatsapp" | "telegram" | "tiktok";
	organizationId: string;
	// Nullable for internal events (tag_applied/field_changed/conversion_event/
	// ref_link_click/schedule) that don't originate from a specific social
	// account. Platform events always populate this.
	socialAccountId: string | null;
	contactId: string;
	conversationId: string | null;
	// Per-kind fields
	text?: string;
	postId?: string;
	adId?: string;
	refUrlId?: string;
	tagId?: string;
	fieldKey?: string;
	fieldValueBefore?: unknown;
	fieldValueAfter?: unknown;
	eventName?: string;
	payload?: Record<string, unknown>;
	/**
	 * Optional metadata set by `processInboxEvent` indicating whether this
	 * inbound is the contact's first message on this channel. The
	 * welcome_message binding router uses this to decide when to fire.
	 *
	 * Computed BEFORE the inbound message row is persisted (spec bug B2: the
	 * prior DB-query path always saw ≥1 prior row because `insertMessage` ran
	 * before the matcher). Callers that don't set this (unit tests, manual
	 * enroll, webhook-receiver) fall back to the `binding-router`'s DB query.
	 */
	isFirstInboundOnChannel?: boolean;
};

export type MatchResult =
	| {
			matched: true;
			entrypointId: string;
			automationId: string;
			runId: string;
	  }
	| {
			matched: false;
			reason:
				| "no_candidates"
				| "all_filtered"
				| "reentry_blocked"
				| "paused"
				| "no_active_automation";
	  };

export type Db = Database;

// ---------------------------------------------------------------------------
// Specificity auto-derivation (spec §6.2)
// ---------------------------------------------------------------------------

/**
 * Derives an entrypoint's specificity score from its kind + config + filters.
 * Writers should call this when inserting/updating entrypoint rows so the match
 * ordering in step 7 (specificity DESC, priority ASC, created_at ASC) is
 * consistent across producers.
 *
 * Values (per spec §6.2):
 *   keyword (exact or regex), webhook_inbound              → 30
 *   asset-filtered (comment_created/story_reply w/ ids)    → 25
 *   filtered (filters JSONB non-null)                      → 20
 *   account-scoped broad (social_account_id set, no filter)→ 10
 *   catch-all (no account, no filter)                      → 0
 */
export function computeSpecificity(
	kind: string,
	config: unknown,
	filters: unknown,
	socialAccountId: string | null,
): number {
	const cfg = (config ?? {}) as Record<string, unknown>;
	let max = 0;

	// Tier 30 — unique slug / deterministic match.
	// Historically a dedicated `keyword` kind existed; it was folded into
	// `dm_received` (see schemas/automation-entrypoints.ts comment). We still
	// score `kind === "keyword"` for backward compatibility with any tests or
	// legacy data, and apply the same rule to `dm_received` entries whose
	// config specifies exact/regex keyword matching.
	if (kind === "keyword" || kind === "dm_received") {
		const hasKeywords =
			Array.isArray(cfg.keywords) && (cfg.keywords as unknown[]).length > 0;
		if (hasKeywords) {
			const mode = (cfg.match_mode as string | undefined) ?? "contains";
			if (mode === "exact" || mode === "regex") max = Math.max(max, 30);
		}
	}
	if (kind === "webhook_inbound" && typeof cfg.webhook_slug === "string") {
		max = Math.max(max, 30);
	}

	// Tier 25 — asset-filtered.
	if (kind === "comment_created") {
		const postIds = cfg.post_ids;
		if (Array.isArray(postIds) && postIds.length > 0) max = Math.max(max, 25);
	}
	if (kind === "story_reply" || kind === "story_mention") {
		const storyIds = cfg.story_ids;
		if (Array.isArray(storyIds) && storyIds.length > 0) max = Math.max(max, 25);
	}

	// Tier 20 — filter group non-null.
	if (filters !== null && filters !== undefined) {
		const filt = filters as Record<string, unknown>;
		const hasGroup =
			filt &&
			((Array.isArray(filt.all) && filt.all.length > 0) ||
				(Array.isArray(filt.any) && filt.any.length > 0) ||
				(Array.isArray(filt.none) && filt.none.length > 0));
		if (hasGroup) max = Math.max(max, 20);
	}

	// Tier 10 — account-scoped broad.
	if (socialAccountId && max === 0) max = Math.max(max, 10);

	// Tier 0 — catch-all (already covered by initial value).
	return max;
}

// ---------------------------------------------------------------------------
// Per-kind config matcher
// ---------------------------------------------------------------------------

function matchesKeywordConfig(
	config: Record<string, unknown>,
	text: string,
): boolean {
	const keywords = (config.keywords as string[] | undefined) ?? [];
	if (keywords.length === 0) return true;
	const mode = (config.match_mode as string | undefined) ?? "contains";
	const caseSensitive =
		(config.case_sensitive as boolean | undefined) ?? false;
	const hay = caseSensitive ? text : text.toLowerCase();
	return keywords.some((k) => {
		const kw = caseSensitive ? k : k.toLowerCase();
		if (mode === "exact") return hay === kw;
		if (mode === "regex") {
			try {
				return new RegExp(k, caseSensitive ? "" : "i").test(text);
			} catch {
				return false;
			}
		}
		return hay.includes(kw);
	});
}

function matchesEntrypointConfig(
	kind: string,
	config: Record<string, unknown>,
	event: InboundEvent,
): boolean {
	switch (kind) {
		// The dedicated `keyword` kind was removed (§B3); keyword matching now
		// lives on `dm_received` entrypoints via their `keywords` config. The
		// legacy `case "keyword":` branch is preserved as a safety net for any
		// stale rows still in the DB — the runtime matcher filters by
		// `event.kind` and `deriveInboundEventKind` never emits `"keyword"`,
		// so this branch will never actually be hit by a live event.
		case "keyword":
		case "dm_received": {
			const text = event.text ?? "";
			if (Array.isArray(config.keywords) && config.keywords.length > 0) {
				return matchesKeywordConfig(config, text);
			}
			return true;
		}
		case "comment_created": {
			const postIds = config.post_ids;
			if (Array.isArray(postIds) && postIds.length > 0) {
				if (!event.postId || !postIds.includes(event.postId)) return false;
			}
			if (Array.isArray(config.keywords) && config.keywords.length > 0) {
				return matchesKeywordConfig(config, event.text ?? "");
			}
			return true;
		}
		case "story_reply":
		case "story_mention": {
			const storyIds = config.story_ids;
			if (Array.isArray(storyIds) && storyIds.length > 0) {
				if (!event.postId || !storyIds.includes(event.postId)) return false;
			}
			if (Array.isArray(config.keywords) && config.keywords.length > 0) {
				return matchesKeywordConfig(config, event.text ?? "");
			}
			return true;
		}
		case "live_comment": {
			if (Array.isArray(config.keywords) && config.keywords.length > 0) {
				return matchesKeywordConfig(config, event.text ?? "");
			}
			return true;
		}
		case "ad_click": {
			const adIds = config.ad_ids;
			if (Array.isArray(adIds) && adIds.length > 0) {
				if (!event.adId || !adIds.includes(event.adId)) return false;
			}
			return true;
		}
		case "ref_link_click": {
			const ids = config.ref_url_ids;
			if (Array.isArray(ids) && ids.length > 0) {
				if (!event.refUrlId || !ids.includes(event.refUrlId)) return false;
			}
			return true;
		}
		case "tag_applied":
		case "tag_removed": {
			const tagIds = config.tag_ids;
			if (Array.isArray(tagIds) && tagIds.length > 0) {
				if (!event.tagId || !tagIds.includes(event.tagId)) return false;
			}
			return true;
		}
		case "field_changed": {
			const keys = config.field_keys;
			if (Array.isArray(keys) && keys.length > 0) {
				if (!event.fieldKey || !keys.includes(event.fieldKey)) return false;
			}
			return true;
		}
		case "conversion_event": {
			const events = config.event_names;
			if (Array.isArray(events) && events.length > 0) {
				if (!event.eventName || !events.includes(event.eventName)) {
					return false;
				}
			}
			return true;
		}
		case "share_to_dm":
		case "follow":
			return true;
		default:
			// Unknown kinds match by default (graceful forward-compat)
			return true;
	}
}

// ---------------------------------------------------------------------------
// matchAndEnroll
// ---------------------------------------------------------------------------

export async function matchAndEnroll(
	db: Db,
	event: InboundEvent,
	env: Record<string, unknown>,
): Promise<MatchResult> {
	// 1. Load candidate entrypoints — channel + kind + active.
	//    Allow either (social_account_id IS NULL) OR (social_account_id = event.socialAccountId).
	const rows = await db
		.select({ entrypoint: automationEntrypoints, automation: automations })
		.from(automationEntrypoints)
		.innerJoin(automations, eq(automationEntrypoints.automationId, automations.id))
		.where(
			and(
				eq(automationEntrypoints.channel, event.channel as never),
				eq(automationEntrypoints.kind, event.kind),
				eq(automationEntrypoints.status, "active"),
				eq(automations.status, "active"),
				eq(automations.organizationId, event.organizationId),
				event.socialAccountId
					? or(
							isNull(automationEntrypoints.socialAccountId),
							eq(
								automationEntrypoints.socialAccountId,
								event.socialAccountId,
							),
						)
					: // Internal events (tag_applied, field_changed, conversion_event,
						// ref_link_click, schedule) don't originate from a specific social
						// account — match only entrypoints that aren't account-scoped.
						isNull(automationEntrypoints.socialAccountId),
			),
		);

	if (rows.length === 0) {
		return { matched: false, reason: "no_candidates" };
	}

	// Load contact context for filter evaluation (once).
	const contactRow = await db.query.contacts.findFirst({
		where: eq(contacts.id, event.contactId),
	});
	const tagList: string[] = contactRow?.tags ?? [];
	const fieldsMap: Record<string, unknown> = {};
	if (contactRow) {
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
					eq(customFieldValues.contactId, event.contactId),
					eq(customFieldValues.organizationId, event.organizationId),
				),
			);
		for (const fr of fieldRows) {
			if (fr.slug) fieldsMap[fr.slug] = fr.value;
		}
	}

	// 2. Per-kind config + filter evaluation.
	type Candidate = (typeof rows)[number];
	const survivors: Candidate[] = [];
	for (const row of rows) {
		const cfg = (row.entrypoint.config ?? {}) as Record<string, unknown>;
		if (!matchesEntrypointConfig(event.kind, cfg, event)) continue;

		const filters = row.entrypoint.filters as Record<string, unknown> | null;
		if (filters) {
			const ok = evaluateFilterGroup(
				filters as never,
				{
					contact: (contactRow as Record<string, unknown> | undefined) ?? null,
					tags: tagList,
					fields: fieldsMap,
					state: (event.payload as Record<string, unknown> | undefined) ?? {},
				},
			);
			if (!ok) continue;
		}
		survivors.push(row);
	}

	if (survivors.length === 0) {
		return { matched: false, reason: "all_filtered" };
	}

	// 3. Contact-level pause — any control row with automation_id=NULL or
	//    matching automation_id, where paused_until IS NULL or in the future.
	const pauseRows = await db
		.select({
			id: automationContactControls.id,
			automationId: automationContactControls.automationId,
			pausedUntil: automationContactControls.pausedUntil,
		})
		.from(automationContactControls)
		.where(
			and(
				eq(automationContactControls.contactId, event.contactId),
				or(
					isNull(automationContactControls.pausedUntil),
					sql`${automationContactControls.pausedUntil} > NOW()`,
				),
			),
		);

	// A global pause blocks everything.
	const hasGlobalPause = pauseRows.some((p) => p.automationId === null);
	if (hasGlobalPause) {
		return { matched: false, reason: "paused" };
	}
	const pausedAutomationIds = new Set(
		pauseRows.map((p) => p.automationId).filter((id): id is string => !!id),
	);

	// 4. Re-entry guard — per-automation.
	const finalists: Candidate[] = [];
	for (const row of survivors) {
		const auto = row.automation;
		if (pausedAutomationIds.has(auto.id)) continue;

		// Active / waiting run already exists?
		const activeRun = await db
			.select({ id: automationRuns.id })
			.from(automationRuns)
			.where(
				and(
					eq(automationRuns.automationId, auto.id),
					eq(automationRuns.contactId, event.contactId),
					or(
						eq(automationRuns.status, "active"),
						eq(automationRuns.status, "waiting"),
					),
				),
			)
			.limit(1);
		if (activeRun.length > 0) continue;

		const ep = row.entrypoint;
		if (!ep.allowReentry) {
			const priorRun = await db
				.select({ id: automationRuns.id })
				.from(automationRuns)
				.where(
					and(
						eq(automationRuns.automationId, auto.id),
						eq(automationRuns.contactId, event.contactId),
					),
				)
				.limit(1);
			if (priorRun.length > 0) continue;
		} else if (ep.reentryCooldownMin && ep.reentryCooldownMin > 0) {
			const cooldownStart = new Date(
				Date.now() - ep.reentryCooldownMin * 60 * 1000,
			);
			const recent = await db
				.select({ id: automationRuns.id })
				.from(automationRuns)
				.where(
					and(
						eq(automationRuns.automationId, auto.id),
						eq(automationRuns.contactId, event.contactId),
						gte(automationRuns.completedAt, cooldownStart),
					),
				)
				.orderBy(desc(automationRuns.completedAt))
				.limit(1);
			if (recent.length > 0) continue;
		}

		finalists.push(row);
	}

	if (finalists.length === 0) {
		return { matched: false, reason: "reentry_blocked" };
	}

	// 5. Sort by (specificity DESC, priority ASC, created_at ASC) and take first.
	finalists.sort((a, b) => {
		const sA = a.entrypoint.specificity;
		const sB = b.entrypoint.specificity;
		if (sA !== sB) return sB - sA;
		const pA = a.entrypoint.priority;
		const pB = b.entrypoint.priority;
		if (pA !== pB) return pA - pB;
		const cA = a.entrypoint.createdAt.getTime();
		const cB = b.entrypoint.createdAt.getTime();
		return cA - cB;
	});
	const picked = finalists[0]!;

	// 6. Enroll via the runner.
	try {
		const { runId } = await enrollContact(db, {
			automationId: picked.automation.id,
			organizationId: event.organizationId,
			contactId: event.contactId,
			conversationId: event.conversationId,
			channel: event.channel,
			entrypointId: picked.entrypoint.id,
			bindingId: null,
			contextOverrides: { triggerEvent: event },
			env,
		});
		return {
			matched: true,
			entrypointId: picked.entrypoint.id,
			automationId: picked.automation.id,
			runId,
		};
	} catch {
		return { matched: false, reason: "no_active_automation" };
	}
}
