/**
 * Weekly digest — sends a summary of posting activity to users who opted in.
 * Runs every Monday at 9am UTC via cron.
 */

import { eq, and, gte, lte, sql, inArray } from "drizzle-orm";
import {
	createDb,
	member,
	notificationPreferences,
	posts,
} from "@relayapi/db";
import { sendNotification } from "./notification-manager";
import type { Env } from "../types";

interface ChannelPrefs {
	push: boolean;
	email: boolean;
}

export async function processWeeklyDigest(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Get all users who have weekly digest enabled (push or email)
	const prefs = await db
		.select({
			userId: notificationPreferences.userId,
			weeklyDigest: notificationPreferences.weeklyDigest,
		})
		.from(notificationPreferences);

	const enabledUsers = prefs.filter((p) => {
		const wd = p.weeklyDigest as ChannelPrefs | null;
		return wd && (wd.push || wd.email);
	});

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
	const allStats = orgIds.length > 0
		? await db
				.select({
					orgId: posts.organizationId,
					published: sql<number>`count(*) filter (where ${posts.status} = 'published')`,
					failed: sql<number>`count(*) filter (where ${posts.status} = 'failed' or ${posts.status} = 'partial')`,
				})
				.from(posts)
				.where(
					and(
						inArray(posts.organizationId, orgIds),
						gte(posts.createdAt, weekAgo),
						lte(posts.createdAt, now),
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
