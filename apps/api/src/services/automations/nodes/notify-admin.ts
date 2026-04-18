import { contacts, member, notifications, user } from "@relayapi/db";
import { and, eq, inArray } from "drizzle-orm";
import { sendEmail } from "../../../lib/email-queue/producer";
import { notifyRealtime } from "../../../lib/notify-post-update";
import { applyMergeTags } from "../merge-tags";
import type { NodeHandler } from "../types";

const EMAIL_FROM = "RelayAPI <notifications@relayapi.dev>";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderEmailHtml(title: string, body: string): string {
	const safeTitle = escapeHtml(title);
	const safeBody = escapeHtml(body).replaceAll("\n", "<br />");
	return `<!doctype html><html><body style="font-family: system-ui, sans-serif; background:#f7f7f8; padding:24px;"><div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;"><h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#111827;">${safeTitle}</h1><div style="font-size:14px;line-height:1.6;color:#374151;">${safeBody}</div></div></body></html>`;
}

export const notifyAdminHandler: NodeHandler = async (ctx) => {
	const channel = (ctx.node.config.channel as string | undefined) ?? "in_app";
	if (channel === "webhook") {
		return {
			kind: "fail",
			error:
				"notify_admin channel 'webhook' is not supported yet; use webhook_out for webhook delivery",
		};
	}

	const titleTemplate = ctx.node.config.title as string | undefined;
	const bodyTemplate = ctx.node.config.body as string | undefined;
	if (!titleTemplate || !bodyTemplate) {
		return { kind: "fail", error: "notify_admin missing title or body" };
	}

	const contact = ctx.enrollment.contact_id
		? await ctx.db.query.contacts.findFirst({
				where: eq(contacts.id, ctx.enrollment.contact_id),
			})
		: null;

	const mergeContext = {
		contact: contact as Record<string, unknown> | null,
		state: ctx.enrollment.state,
	};
	const title = applyMergeTags(titleTemplate, mergeContext).trim();
	const body = applyMergeTags(bodyTemplate, mergeContext).trim();

	if (!title || !body) {
		return {
			kind: "fail",
			error: "notify_admin title/body resolved to an empty value",
		};
	}

	const recipientTemplates = Array.isArray(ctx.node.config.recipients)
		? (ctx.node.config.recipients as string[])
		: [];
	const requestedRecipientIds = recipientTemplates
		.map((value) => applyMergeTags(value, mergeContext).trim())
		.filter((value) => value.length > 0);
	const uniqueRequestedRecipientIds = Array.from(new Set(requestedRecipientIds));

	const recipientMembers = await ctx.db
		.select({ userId: member.userId })
		.from(member)
		.where(
			uniqueRequestedRecipientIds.length > 0
				? and(
						eq(member.organizationId, ctx.enrollment.organization_id),
						inArray(member.userId, uniqueRequestedRecipientIds),
					)
				: eq(member.organizationId, ctx.enrollment.organization_id),
		);

	if (recipientMembers.length === 0) {
		return {
			kind: "fail",
			error:
				uniqueRequestedRecipientIds.length > 0
					? "notify_admin recipients are not members of this organization"
					: "notify_admin found no organization members to notify",
		};
	}

	const recipientUserIds = recipientMembers.map((row) => row.userId);

	if (channel === "in_app") {
		await ctx.db.insert(notifications).values(
			recipientUserIds.map((userId) => ({
				userId,
				organizationId: ctx.enrollment.organization_id,
				type: "automation_alert",
				title,
				body,
				data: {
					automation_id: ctx.enrollment.automation_id,
					automation_version: ctx.enrollment.automation_version,
					enrollment_id: ctx.enrollment.id,
					node_key: ctx.node.key,
				},
			})),
		);
		await notifyRealtime(ctx.env, ctx.enrollment.organization_id, {
			type: "notification.created",
		}).catch(() => {});
		return {
			kind: "next",
			state_patch: {
				last_notification_channel: "in_app",
				last_notification_count: recipientUserIds.length,
			},
		};
	}

	const users = await ctx.db
		.select({ id: user.id, email: user.email })
		.from(user)
		.where(inArray(user.id, recipientUserIds));
	const emails = users
		.map((row) => row.email?.trim())
		.filter((value): value is string => Boolean(value));

	if (emails.length === 0) {
		return {
			kind: "fail",
			error: "notify_admin email channel found no recipients with an email address",
		};
	}

	const html = renderEmailHtml(title, body);
	const deliveries = await Promise.allSettled(
		emails.map((email) =>
			sendEmail(ctx.env.EMAIL_QUEUE, ctx.env.RESEND_API_KEY, {
				to: email,
				subject: title,
				html,
				from: EMAIL_FROM,
			}),
		),
	);
	const successCount = deliveries.filter(
		(result) => result.status === "fulfilled",
	).length;
	if (successCount === 0) {
		const firstFailure = deliveries.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		return {
			kind: "fail",
			error:
				firstFailure?.reason instanceof Error
					? firstFailure.reason.message
					: "notify_admin failed to send all emails",
		};
	}

	return {
		kind: "next",
		state_patch: {
			last_notification_channel: "email",
			last_notification_count: successCount,
		},
	};
};
