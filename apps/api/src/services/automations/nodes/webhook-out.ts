import { contacts, webhookEndpoints } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { deliverWebhook } from "../../webhook-delivery";
import { resolveTemplatedValue } from "../resolve-templated-value";
import type { NodeHandler } from "../types";

export const webhookOutHandler: NodeHandler = async (ctx) => {
	const endpointId = ctx.node.config.endpoint_id as string | undefined;
	const event = ctx.node.config.event as string | undefined;
	if (!endpointId) {
		return { kind: "fail", error: "webhook_out missing 'endpoint_id'" };
	}
	if (!event) {
		return { kind: "fail", error: "webhook_out missing 'event'" };
	}

	const endpoint = await ctx.db.query.webhookEndpoints.findFirst({
		where: and(
			eq(webhookEndpoints.id, endpointId),
			eq(webhookEndpoints.organizationId, ctx.enrollment.organization_id),
		),
	});
	if (!endpoint) {
		return { kind: "fail", error: `webhook endpoint '${endpointId}' not found` };
	}
	if (!endpoint.enabled) {
		return { kind: "fail", error: `webhook endpoint '${endpointId}' is disabled` };
	}

	const contact = ctx.enrollment.contact_id
		? await ctx.db.query.contacts.findFirst({
				where: eq(contacts.id, ctx.enrollment.contact_id),
			})
		: null;
	const payload =
		ctx.node.config.payload === undefined
			? {
					automation_id: ctx.enrollment.automation_id,
					automation_version: ctx.enrollment.automation_version,
					enrollment_id: ctx.enrollment.id,
					contact_id: ctx.enrollment.contact_id,
					conversation_id: ctx.enrollment.conversation_id,
					state: ctx.enrollment.state,
				}
			: resolveTemplatedValue(ctx.node.config.payload, {
					contact: (contact as Record<string, unknown> | null | undefined) ?? null,
					state: ctx.enrollment.state,
				});

	await deliverWebhook(
		ctx.env,
		{
			id: endpoint.id,
			organizationId: endpoint.organizationId,
			url: endpoint.url,
			secret: endpoint.secret,
		},
		event,
		payload,
	);

	return {
		kind: "next",
		state_patch: {
			last_webhook_endpoint_id: endpoint.id,
			last_webhook_event: event,
		},
	};
};
