/**
 * Automation rules engine — orchestrator that loads rules, evaluates
 * conditions, executes actions, and manages rate limiting via KV.
 *
 * Called by the event processor after storing each inbound message.
 */

import {
	type Database,
	automationLogs,
	automationRules,
	generateId,
} from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Env } from "../types";
import {
	evaluateConditions,
	type MessageContext,
} from "./automation-evaluator";
import {
	executeActions,
	type ActionDef,
	type ActionResult,
} from "./automation-executor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutomationEvent {
	type: string;
	platform: string;
	text?: string;
	direction: string;
	author?: { name: string; id: string };
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

async function getRateCount(kv: KVNamespace, ruleId: string): Promise<number> {
	const val = await kv.get(`rule-rate:${ruleId}`);
	return val ? Number.parseInt(val, 10) : 0;
}

async function incrementRateCount(
	kv: KVNamespace,
	ruleId: string,
): Promise<number> {
	const key = `rule-rate:${ruleId}`;
	const current = await getRateCount(kv, ruleId);
	const next = current + 1;
	// TTL: 1 hour (3600 seconds)
	await kv.put(key, String(next), { expirationTtl: 3600 });
	return next;
}

async function hasAuthorCooldown(
	kv: KVNamespace,
	ruleId: string,
	authorId: string,
): Promise<boolean> {
	const val = await kv.get(`rule-cooldown:${ruleId}:${authorId}`);
	return val !== null;
}

async function setAuthorCooldown(
	kv: KVNamespace,
	ruleId: string,
	authorId: string,
	cooldownMinutes: number,
): Promise<void> {
	await kv.put(`rule-cooldown:${ruleId}:${authorId}`, "1", {
		expirationTtl: cooldownMinutes * 60,
	});
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAutomationRules(
	event: AutomationEvent,
	conversationId: string,
	messageId: string,
	env: Env,
	db: Database,
): Promise<void> {
	// We need to figure out the orgId and accountId from the conversation
	// For now, we use the event data — the caller should supply orgId/accountId
	// via the event's extended fields
	const orgId = event.orgId as string | undefined;
	const accountId = event.accountId as string | undefined;

	if (!orgId) {
		console.error("[automation] Missing orgId in event — skipping rules");
		return;
	}

	// 1. Load active rules for this org, ordered by priority DESC
	const rules = await db
		.select()
		.from(automationRules)
		.where(
			and(
				eq(automationRules.organizationId, orgId),
				eq(automationRules.enabled, true),
			),
		)
		.orderBy(desc(automationRules.priority));

	if (rules.length === 0) return;

	// Build message context — spread first so explicit fields take precedence
	const messageContext: MessageContext = {
		...event,
		type: event.type,
		platform: event.platform,
		text: event.text,
		direction: event.direction,
		author: event.author,
	};

	const authorId = event.author?.id ?? "unknown";

	for (const rule of rules) {
		try {
			// 2a. Check rate limit
			const currentRate = await getRateCount(env.KV, rule.id);
			const maxPerHour = rule.maxPerHour ?? 100;

			if (currentRate >= maxPerHour) {
				// Safety: if counter exceeds 500, auto-disable the rule
				if (currentRate > 500) {
					await db
						.update(automationRules)
						.set({ enabled: false, updatedAt: new Date() })
						.where(eq(automationRules.id, rule.id));
					console.warn(
						`[automation] Rule ${rule.id} auto-disabled — exceeded 500 executions/hour`,
					);
				}
				continue;
			}

			// 2b. Check author cooldown
			const cooldownMin = rule.cooldownPerAuthorMin ?? 60;
			if (
				authorId !== "unknown" &&
				(await hasAuthorCooldown(env.KV, rule.id, authorId))
			) {
				continue;
			}

			// 2c. Evaluate conditions
			const conditions = rule.conditions as
				| Parameters<typeof evaluateConditions>[0];
			const matched = evaluateConditions(conditions, messageContext);

			if (!matched) {
				// Only log matches to avoid log spam
				continue;
			}

			// 2d. Execute actions
			const actions = rule.actions as ActionDef[];
			let actionResults: ActionResult[] = [];

			if (accountId) {
				actionResults = await executeActions(
					actions,
					{
						conversationId,
						messageId,
						orgId,
						platform: event.platform,
						accountId,
						platformMessageId: event.platformMessageId as string | undefined,
					},
					env,
					db,
				);
			}

			// 2e. Update KV rate counter
			await incrementRateCount(env.KV, rule.id);

			// 2f. Set author cooldown
			if (authorId !== "unknown" && cooldownMin > 0) {
				await setAuthorCooldown(env.KV, rule.id, authorId, cooldownMin);
			}

			// 2g. Log the match
			await db.insert(automationLogs).values({
				id: generateId("alog_"),
				ruleId: rule.id,
				organizationId: orgId,
				messageId,
				matched: true,
				actionsExecuted: actionResults as unknown as Record<string, unknown>,
				error: null,
			});

			// 2h. Increment totalExecutions and update lastExecutedAt
			await db
				.update(automationRules)
				.set({
					totalExecutions: sql`COALESCE(${automationRules.totalExecutions}, 0) + 1`,
					lastExecutedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(automationRules.id, rule.id));

			// 2i. If stopAfterMatch, break
			if (rule.stopAfterMatch && actionResults.some((r) => r.success)) {
				break;
			}
		} catch (err) {
			// Log error and continue with next rule
			console.error(
				`[automation] Error processing rule ${rule.id}:`,
				err,
			);

			try {
				await db.insert(automationLogs).values({
					id: generateId("alog_"),
					ruleId: rule.id,
					organizationId: orgId,
					messageId,
					matched: false,
					actionsExecuted: null,
					error:
						err instanceof Error ? err.message : "Unknown error",
				});
			} catch {
				// If logging itself fails, just continue
			}
		}
	}
}
