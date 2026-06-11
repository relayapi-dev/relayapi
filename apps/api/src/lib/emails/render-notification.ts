/**
 * Notification e-mail rendering, split out of notification-manager so the
 * react-email stack (~3 MB pre-minify, the single largest chunk of the
 * worker bundle) is only evaluated when an e-mail is actually rendered —
 * notification-manager pulls this in via a dynamic import(). Keep all
 * `@react-email/*` and template imports inside this module.
 */

import { render } from "@react-email/render";
import { AccountDisconnectedNotification } from "./templates/AccountDisconnectedNotification";
import { PostFailedNotification } from "./templates/PostFailedNotification";
import { PostPublishedNotification } from "./templates/PostPublishedNotification";
import { StreakBrokenNotification } from "./templates/StreakBrokenNotification";
import { StreakWarningNotification } from "./templates/StreakWarningNotification";
import { UsageWarningNotification } from "./templates/UsageWarningNotification";
import { WeeklyDigestNotification } from "./templates/WeeklyDigestNotification";
import type { NotificationType } from "../../services/notification-manager";

const APP_URL = "https://relayapi.dev/app";

export async function renderEmailForType(
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
