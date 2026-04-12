// ---------------------------------------------------------------------------
// Engagement Rule Processor
//
// Checks post metrics against engagement rule thresholds and executes actions
// (repost, reply, repost_from_account) when thresholds are met.
// ---------------------------------------------------------------------------

import {
	createDb,
	engagementRuleLogs,
	engagementRules,
	postTargets,
	socialAccounts,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { Env } from "../types";
import { getPublisher } from "../publishers";
import type { EngagementAccount } from "../publishers/types";
import { getExternalPostFetcher } from "./external-post-sync";
import { refreshTokenIfNeeded } from "./token-refresh";
import { dispatchWebhookEvent } from "./webhook-delivery";

type Database = ReturnType<typeof createDb>;

export interface EngagementCheckMessage {
	type: "engagement_check";
	rule_id: string;
	post_target_id: string;
	check_number: number;
	organization_id: string;
}

export async function processEngagementCheck(
	env: Env,
	msg: EngagementCheckMessage,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Fetch the rule
	const [rule] = await db
		.select()
		.from(engagementRules)
		.where(eq(engagementRules.id, msg.rule_id))
		.limit(1);
	if (!rule || rule.status !== "active") return;

	// Check if a previous check already triggered the action for this post
	const [existingAction] = await db
		.select({ id: engagementRuleLogs.id })
		.from(engagementRuleLogs)
		.where(
			and(
				eq(engagementRuleLogs.ruleId, msg.rule_id),
				eq(engagementRuleLogs.postTargetId, msg.post_target_id),
				eq(engagementRuleLogs.actionTaken, true),
			),
		)
		.limit(1);
	if (existingAction) return; // already fired for this post

	// Fetch the post target
	const [target] = await db
		.select()
		.from(postTargets)
		.where(eq(postTargets.id, msg.post_target_id))
		.limit(1);
	if (!target || !target.platformPostId) return;

	// Fetch the account to get credentials
	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(eq(socialAccounts.id, rule.accountId))
		.limit(1);
	if (!account) return;

	// Get fresh access token
	const accessToken = await refreshTokenIfNeeded(env, account);

	// Fetch current metrics from platform
	const fetcher = getExternalPostFetcher(target.platform);
	let metricValue = 0;

	if (fetcher) {
		try {
			const metricsMap = await fetcher.fetchPostMetrics(
				accessToken,
				account.platformAccountId,
				[target.platformPostId],
			);
			const metrics = metricsMap.get(target.platformPostId);
			if (metrics) {
				const metricKey = rule.triggerMetric as keyof typeof metrics;
				metricValue = metrics[metricKey] ?? 0;
			}
		} catch {
			// Log the failed check and return
			await db.insert(engagementRuleLogs).values({
				ruleId: rule.id,
				postTargetId: target.id,
				checkNumber: msg.check_number,
				metricValue: null,
				thresholdMet: false,
				actionTaken: false,
				error: "Failed to fetch post metrics",
			});
			return;
		}
	}

	const thresholdMet = metricValue >= rule.triggerThreshold;

	if (!thresholdMet) {
		// Log the check without action
		await db.insert(engagementRuleLogs).values({
			ruleId: rule.id,
			postTargetId: target.id,
			checkNumber: msg.check_number,
			metricValue,
			thresholdMet: false,
			actionTaken: false,
		});
		return;
	}

	// Threshold met — re-check the dedup guard right before executing.
	// This minimises the race window between concurrent queue deliveries.
	const [recheck] = await db
		.select({ id: engagementRuleLogs.id })
		.from(engagementRuleLogs)
		.where(
			and(
				eq(engagementRuleLogs.ruleId, msg.rule_id),
				eq(engagementRuleLogs.postTargetId, msg.post_target_id),
				eq(engagementRuleLogs.actionTaken, true),
			),
		)
		.limit(1);
	if (recheck) return; // another delivery already executed

	// Execute the action
	let resultPostId: string | null = null;
	let error: string | null = null;

	try {
		resultPostId = await executeEngagementAction(env, db, rule, target, account, accessToken);
	} catch (err) {
		error = err instanceof Error ? err.message : "Unknown error";
	}

	// Log the execution
	await db.insert(engagementRuleLogs).values({
		ruleId: rule.id,
		postTargetId: target.id,
		checkNumber: msg.check_number,
		metricValue,
		thresholdMet: true,
		actionTaken: !error,
		resultPostId,
		error,
	});

	// Dispatch webhook if action was taken
	if (!error) {
		await dispatchWebhookEvent(env, db, rule.organizationId, "engagement_rule.triggered", {
			rule_id: rule.id,
			rule_name: rule.name,
			post_target_id: target.id,
			action_type: rule.actionType,
			metric: rule.triggerMetric,
			metric_value: metricValue,
			threshold: rule.triggerThreshold,
			result_post_id: resultPostId,
		}, rule.workspaceId);
	}
}

async function executeEngagementAction(
	env: Env,
	db: Database,
	rule: typeof engagementRules.$inferSelect,
	target: typeof postTargets.$inferSelect,
	account: typeof socialAccounts.$inferSelect,
	accessToken: string,
): Promise<string | null> {
	const publisher = getPublisher(target.platform as any);
	if (!publisher) throw new Error(`No publisher for platform ${target.platform}`);

	const engagementAccount: EngagementAccount = {
		access_token: accessToken,
		refresh_token: null,
		platform_account_id: account.platformAccountId,
		username: account.username,
	};

	switch (rule.actionType) {
		case "repost": {
			if (!publisher.repost) throw new Error(`Platform ${target.platform} does not support repost`);
			const result = await publisher.repost(engagementAccount, target.platformPostId!);
			if (!result.success) throw new Error(result.error?.message ?? "Repost failed");
			return result.platform_post_id ?? null;
		}
		case "reply": {
			if (!publisher.comment) throw new Error(`Platform ${target.platform} does not support comment`);
			const text = rule.actionContent ?? "";
			const result = await publisher.comment(engagementAccount, target.platformPostId!, text);
			if (!result.success) throw new Error(result.error?.message ?? "Reply failed");
			return result.platform_post_id ?? null;
		}
		case "repost_from_account": {
			if (!rule.actionAccountId) throw new Error("No action account configured");
			// Fetch the cross-account credentials
			const [actionAccount] = await db
				.select()
				.from(socialAccounts)
				.where(eq(socialAccounts.id, rule.actionAccountId))
				.limit(1);
			if (!actionAccount) throw new Error("Action account not found");

			const actionToken = await refreshTokenIfNeeded(env, actionAccount);
			const crossAccount: EngagementAccount = {
				access_token: actionToken,
				refresh_token: null,
				platform_account_id: actionAccount.platformAccountId,
				username: actionAccount.username,
			};

			if (!publisher.repost) throw new Error(`Platform ${target.platform} does not support repost`);
			const result = await publisher.repost(crossAccount, target.platformPostId!);
			if (!result.success) throw new Error(result.error?.message ?? "Cross-account repost failed");
			return result.platform_post_id ?? null;
		}
		default:
			throw new Error(`Unknown action type: ${rule.actionType}`);
	}
}
