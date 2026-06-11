/**
 * Weekly digest — sends a summary of posting activity to users who opted in.
 * Runs every Monday at 9am UTC via cron.
 */

import { and, sql, inArray } from "drizzle-orm";
import {
	createDb,
	member,
	notificationPreferences,
	posts,
} from "@relayapi/db";
import { sendNotification } from "./notification-manager";
import type { Env } from "../types";

export async function processWeeklyDigest(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Get all users who have weekly digest enabled (push or email). Push the
	// opt-in filter into SQL via jsonb containment so the result set scales with
	// opted-in users rather than the whole user base (default is both false).
	const enabledUsers = await db
		.select({
			userId: notificationPreferences.userId,
			weeklyDigest: notificationPreferences.weeklyDigest,
		})
		.from(notificationPreferences)
		.where(
			sql`${notificationPreferences.weeklyDigest} @> '{"push":true}'::jsonb or ${notificationPreferences.weeklyDigest} @> '{"email":true}'::jsonb`,
		);

	if (enabledUsers.length === 0) return;

	const now = new Date();
	const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

	// Batch-fetch all memberships for enabled users in one query
	const userIds = enabledUsers.map((u) => u.userId);
	const allMemberships = await db
		.select({ userId: member.userId, orgId: member.organizationId })
		.from(member)
		.where(inArray(member.userId, userIds));

	// Get unique org IDs and batch-fetch stats for all of them in one query
	const orgIds = [...new Set(allMemberships.map((m) => m.orgId))];
	// Count by actual publish time (published_at), not creation time, so a post
	// scheduled weeks ago but published this week is correctly attributed to this
	// week and a post merely created this week is not double-counted. Failed/partial
	// posts have no dedicated timestamp, so they fall back to updated_at (approximate).
	const allStats = orgIds.length > 0
		? await db
				.select({
					orgId: posts.organizationId,
					published: sql<number>`count(*) filter (where ${posts.status} = 'published' and ${posts.publishedAt} >= ${weekAgo} and ${posts.publishedAt} <= ${now})`,
					failed: sql<number>`count(*) filter (where (${posts.status} = 'failed' or ${posts.status} = 'partial') and ${posts.updatedAt} >= ${weekAgo} and ${posts.updatedAt} <= ${now})`,
				})
				.from(posts)
				.where(
					and(
						inArray(posts.organizationId, orgIds),
						sql`(${posts.publishedAt} >= ${weekAgo} or ${posts.updatedAt} >= ${weekAgo})`,
					),
				)
				.groupBy(posts.organizationId)
		: [];

	const statsMap = new Map(allStats.map((s) => [s.orgId, s]));

	// Group memberships by user
	const membershipsByUser = new Map<string, string[]>();
	for (const m of allMemberships) {
		const existing = membershipsByUser.get(m.userId);
		if (existing) {
			existing.push(m.orgId);
		} else {
			membershipsByUser.set(m.userId, [m.orgId]);
		}
	}

	// Send notifications — fire all in parallel
	const notificationPromises: Promise<unknown>[] = [];

	for (const userPref of enabledUsers) {
		const userOrgIds = membershipsByUser.get(userPref.userId) ?? [];
		for (const orgId of userOrgIds) {
			const stats = statsMap.get(orgId);
			const postsPublished = Number(stats?.published ?? 0);
			const postsFailed = Number(stats?.failed ?? 0);

			if (postsPublished === 0 && postsFailed === 0) continue;

			notificationPromises.push(
				sendNotification(env, {
					type: "weekly_digest",
					userId: userPref.userId,
					orgId,
					title: "Your weekly summary",
					body: `This week: ${postsPublished} posts published, ${postsFailed} failed`,
					data: {
						postsPublished,
						postsFailed,
						totalImpressions: 0,
					},
				}).catch((err) => {
					console.error(`[WeeklyDigest] Failed for user ${userPref.userId}:`, err);
				}),
			);
		}
	}

	await Promise.allSettled(notificationPromises);
	console.log(`[WeeklyDigest] Processed ${enabledUsers.length} users`);
}
