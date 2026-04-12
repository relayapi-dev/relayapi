/**
 * Notification manager — routes notifications to the right channels
 * (in-app push + email) based on user preferences.
 */

import { render } from "@react-email/render";
import {
	createDb,
	notificationPreferences,
	notifications,
	user,
} from "@relayapi/db";
import { eq, inArray } from "drizzle-orm";
import { sendEmail } from "../lib/email-queue/producer";
import { AccountDisconnectedNotification } from "../lib/emails/templates/AccountDisconnectedNotification";
import { PostFailedNotification } from "../lib/emails/templates/PostFailedNotification";
import { PostPublishedNotification } from "../lib/emails/templates/PostPublishedNotification";
import { UsageWarningNotification } from "../lib/emails/templates/UsageWarningNotification";
import { StreakBrokenNotification } from "../lib/emails/templates/StreakBrokenNotification";
import { StreakWarningNotification } from "../lib/emails/templates/StreakWarningNotification";
import { WeeklyDigestNotification } from "../lib/emails/templates/WeeklyDigestNotification";
import type { Env } from "../types";
import { notifyRealtime } from "../lib/notify-post-update";

export type NotificationType =
	| "post_failed"
	| "post_published"
	| "account_disconnected"
	| "payment_failed"
	| "usage_warning"
	| "weekly_digest"
	| "marketing"
	| "streak_warning";

interface ChannelPrefs {
	push: boolean;
	email: boolean;
}

const DEFAULT_PREFS: Record<NotificationType, ChannelPrefs> = {
	post_failed: { push: true, email: true },
	post_published: { push: true, email: false },
	account_disconnected: { push: true, email: true },
	payment_failed: { push: true, email: true },
	usage_warning: { push: true, email: true },
	weekly_digest: { push: false, email: false },
	marketing: { push: false, email: false },
	streak_warning: { push: true, email: true },
};

// Map notification type to the preference column name
const TYPE_TO_COLUMN: Record<
	NotificationType,
	keyof typeof notificationPreferences.$inferSelect
> = {
	post_failed: "postFailures",
	post_published: "postPublished",
	account_disconnected: "accountDisconnects",
	payment_failed: "paymentAlerts",
	usage_warning: "usageAlerts",
	weekly_digest: "weeklyDigest",
	marketing: "marketing",
	streak_warning: "streakWarnings",
};

// Types where email cannot be disabled
// Note: payment_failed emails are handled by the dunning service, not here
const ALWAYS_EMAIL: Set<NotificationType> = new Set([]);

export interface SendNotificationParams {
	type: NotificationType;
	userId: string;
	orgId: string;
	title: string;
	body: string;
	data?: Record<string, unknown>;
}

/**
 * Send a notification to a user, respecting their channel preferences.
 * Inserts in-app notification and/or enqueues email based on preferences.
 */
export async function sendNotification(
	env: Env,
	params: SendNotificationParams,
): Promise<void> {
	const { type, userId, orgId, title, body, data } = params;

	const db = createDb(env.HYPERDRIVE.connectionString);

	// Load preferences + user email in parallel (both needed for channel routing)
	const [prefRows, userRows] = await Promise.all([
		db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.userId, userId))
			.limit(1),
		db
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, userId))
			.limit(1),
	]);

	const prefRow = prefRows[0];
	const column = TYPE_TO_COLUMN[type];
	const prefs: ChannelPrefs = prefRow
		? ((prefRow[column] as ChannelPrefs) ?? DEFAULT_PREFS[type])
		: DEFAULT_PREFS[type];

	const shouldEmail = prefs.email || ALWAYS_EMAIL.has(type);

	// Run push insert + email send in parallel
	const tasks: Promise<unknown>[] = [];

	if (prefs.push) {
		tasks.push(
			db.insert(notifications).values({
				userId,
				organizationId: orgId,
				type,
				title,
				body,
				data: data ?? null,
			}),
		);
	}

	if (shouldEmail) {
		const userRow = userRows[0];
		if (userRow?.email) {
			tasks.push(
				renderEmailForType(type, {
					...data,
					title,
					body,
				})
					.then((html) => {
						if (html) {
							return sendEmail(env.EMAIL_QUEUE, env.RESEND_API_KEY, {
								to: userRow.email,
								subject: title,
								html,
							});
						}
					})
					.catch((err) => {
						console.error(
							`[NotificationManager] Failed to send email for ${type}:`,
							err,
						);
					}),
			);
		}
	}

	await Promise.all(tasks);

	// Push real-time update so the dashboard badge updates instantly
	if (prefs.push) {
		await notifyRealtime(env, orgId, { type: "notification.created" }).catch(() => {});
	}
}

/**
 * Send a notification to all members of an organization.
 * Batch-fetches prefs + emails in 3 queries total (members, prefs, users),
 * then fans out inserts + emails — avoids N separate DB connections.
 */
export async function sendNotificationToOrg(
	env: Env,
	params: Omit<SendNotificationParams, "userId"> & { orgId: string },
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const { type, orgId, title, body, data } = params;

	// Import member table inline to avoid circular deps
	const { member } = await import("@relayapi/db");

	const members = await db
		.select({ userId: member.userId })
		.from(member)
		.where(eq(member.organizationId, orgId));

	if (members.length === 0) return;

	const userIds = members.map((m) => m.userId);

	// Batch-fetch all prefs + emails in parallel (2 queries instead of 2N)
	const [allPrefs, allUsers] = await Promise.all([
		db
			.select()
			.from(notificationPreferences)
			.where(inArray(notificationPreferences.userId, userIds)),
		db
			.select({ id: user.id, email: user.email })
			.from(user)
			.where(inArray(user.id, userIds)),
	]);

	const prefsMap = new Map(allPrefs.map((p) => [p.userId, p]));
	const userMap = new Map(allUsers.map((u) => [u.id, u]));

	const column = TYPE_TO_COLUMN[type];
	const insertValues: Array<{
		userId: string;
		organizationId: string;
		type: string;
		title: string;
		body: string;
		data: Record<string, unknown> | null;
	}> = [];
	const emailTasks: Promise<unknown>[] = [];
	const emailRecipients: string[] = [];

	for (const { userId } of members) {
		const prefRow = prefsMap.get(userId);
		const prefs: ChannelPrefs = prefRow
			? ((prefRow[column] as ChannelPrefs) ?? DEFAULT_PREFS[type])
			: DEFAULT_PREFS[type];

		if (prefs.push) {
			insertValues.push({
				userId,
				organizationId: orgId,
				type,
				title,
				body,
				data: data ?? null,
			});
		}

		const shouldEmail = prefs.email || ALWAYS_EMAIL.has(type);
		if (shouldEmail) {
			const userRow = userMap.get(userId);
			if (userRow?.email) {
				emailRecipients.push(userRow.email);
			}
		}
	}

	// Render email template once and reuse for all recipients
	if (emailRecipients.length > 0) {
		try {
			const html = await renderEmailForType(type, { ...data, title, body });
			if (html) {
				for (const email of emailRecipients) {
					emailTasks.push(
						sendEmail(env.EMAIL_QUEUE, env.RESEND_API_KEY, {
							to: email,
							subject: title,
							html,
						}).catch((err) => {
							console.error(`[NotificationManager] Org email failed for ${email}:`, err);
						}),
					);
				}
			}
		} catch (err) {
			console.error("[NotificationManager] Email render failed:", err);
		}
	}

	// Batch insert all notifications in one query + send all emails in parallel
	const tasks: Promise<unknown>[] = [...emailTasks];
	if (insertValues.length > 0) {
		tasks.push(db.insert(notifications).values(insertValues));
	}
	await Promise.allSettled(tasks);

	// Push real-time update so dashboard badges update instantly
	if (insertValues.length > 0) {
		await notifyRealtime(env, orgId, { type: "notification.created" }).catch(() => {});
	}
}

const APP_URL = "https://relayapi.dev/app";

async function renderEmailForType(
	type: NotificationType,
	data: Record<string, unknown>,
): Promise<string | null> {
	switch (type) {
		case "post_failed":
			return render(
				PostFailedNotification({
					platforms: (data.platforms as string[]) || [],
					postId: (data.postId as string) || "",
					errorSummary: (data.body as string) || "Your post failed to publish",
					dashboardUrl: `${APP_URL}/posts`,
				}),
			);

		case "post_published":
			return render(
				PostPublishedNotification({
					platforms: (data.platforms as string[]) || [],
					postId: (data.postId as string) || "",
					dashboardUrl: `${APP_URL}/posts`,
				}),
			);

		case "account_disconnected":
			return render(
				AccountDisconnectedNotification({
					platform: (data.platform as string) || "Unknown",
					accountName: (data.accountName as string) || "",
					dashboardUrl: `${APP_URL}/connections`,
				}),
			);

		case "usage_warning":
			return render(
				UsageWarningNotification({
					percentUsed: (data.percentUsed as number) || 0,
					callsUsed: (data.callsUsed as number) || 0,
					callsIncluded: (data.callsIncluded as number) || 0,
					plan: (data.plan as string) || "free",
					dashboardUrl: `${APP_URL}/billing`,
				}),
			);

		case "weekly_digest":
			return render(
				WeeklyDigestNotification({
					postsPublished: (data.postsPublished as number) || 0,
					postsFailed: (data.postsFailed as number) || 0,
					totalImpressions: (data.totalImpressions as number) || 0,
					dashboardUrl: `${APP_URL}/analytics`,
				}),
			);

		case "streak_warning":
			return render(
				data.brokenStreakDays
					? StreakBrokenNotification({
							brokenStreakDays: (data.brokenStreakDays as number) || 0,
							bestStreakDays: (data.bestStreakDays as number) || 0,
							dashboardUrl: `${APP_URL}/posts`,
						})
					: StreakWarningNotification({
							currentStreakDays: (data.currentStreakDays as number) || 0,
							hoursRemaining: (data.hoursRemaining as number) || 0,
							dashboardUrl: `${APP_URL}/posts`,
						}),
			);

		case "payment_failed":
			// Payment failed emails are already handled by the dunning service
			// Only send in-app notification here
			return null;

		case "marketing":
			// Marketing emails are sent manually, not through this system
			return null;

		default:
			return null;
	}
}
