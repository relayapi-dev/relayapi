import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { inboxConversationNotes, inboxConversations, inboxMessages, member, user as userTable } from "@relayapi/db";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { API_VERSIONS, GRAPH_BASE } from "../config/api-versions";
import {
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import {
	BulkActionBody,
	BulkActionResponse,
	ConversationDetailResponse,
	ConversationIdParam,
	FeedQuery,
	FeedResponse,
	SearchQuery,
	SearchResponse,
	StatsQuery,
	StatsResponse,
	UpdateConversationBody,
	UpdateConversationResponse,
} from "../schemas/inbox-feed";
import {
	AddReactionBody,
	DeleteMessageQuery,
	MessageActionResponse,
	RemoveReactionQuery,
	SendMessageBody,
	SendTypingBody,
} from "../schemas/inbox";
import {
	CreateInboxNoteBody,
	DeleteInboxNoteQuery,
	DeleteInboxNoteResponse,
	InboxNoteResponse,
	ListInboxNotesResponse,
	NoteIdParam,
	UpdateInboxNoteBody,
} from "../schemas/inbox-notes";
import {
	getConversationWithMessages,
	getInboxStats,
	insertMessage,
	listConversations,
	searchMessages,
	updateConversation,
} from "../services/inbox-persistence";
import { notifyRealtime } from "../lib/notify-post-update";
import { getAccount, igGraphHost } from "./inbox-helpers";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeConversation(row: {
	id: string;
	platform: string;
	type: string;
	accountId: string;
	participantName: string | null;
	participantAvatar: string | null;
	participantMetadata?: unknown;
	status: string;
	assignedUserId: string | null;
	priority: string | null;
	labels: string[] | null;
	unreadCount: number;
	messageCount: number;
	lastMessageText: string | null;
	lastMessageAt: Date | null;
	lastMessageDirection: string | null;
	createdAt: Date;
	updatedAt: Date;
}) {
	return {
		id: row.id,
		platform: row.platform,
		type: row.type,
		account_id: row.accountId,
		participant_name: row.participantName,
		participant_avatar: row.participantAvatar,
		participant_metadata: row.participantMetadata ?? null,
		status: row.status,
		assigned_user_id: row.assignedUserId,
		priority: row.priority,
		labels: row.labels ?? [],
		unread_count: row.unreadCount,
		message_count: row.messageCount,
		last_message_text: row.lastMessageText,
		last_message_at: row.lastMessageAt?.toISOString() ?? null,
		last_message_direction: row.lastMessageDirection,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

function serializeMessage(row: {
	id: string;
	conversationId: string;
	platformMessageId: string;
	authorName: string | null;
	authorPlatformId: string | null;
	authorAvatarUrl: string | null;
	text: string | null;
	direction: string;
	attachments: unknown;
	sentimentScore: number | null;
	classification: string | null;
	platformData: unknown;
	isHidden: boolean | null;
	isLiked: boolean | null;
	createdAt: Date;
}) {
	return {
		id: row.id,
		conversation_id: row.conversationId,
		platform_message_id: row.platformMessageId,
		author_name: row.authorName,
		author_platform_id: row.authorPlatformId,
		author_avatar_url: row.authorAvatarUrl,
		text: row.text,
		direction: row.direction,
		attachments: row.attachments,
		sentiment_score: row.sentimentScore,
		classification: row.classification,
		platform_data: row.platformData,
		is_hidden: row.isHidden ?? false,
		is_liked: row.isLiked ?? false,
		created_at: row.createdAt.toISOString(),
	};
}

// ---------------------------------------------------------------------------
// 1. GET /feed — Unified cross-platform feed
// ---------------------------------------------------------------------------

const feedRoute = createRoute({
	operationId: "listInboxConversations",
	method: "get",
	path: "/conversations",
	tags: ["Inbox"],
	summary: "List inbox conversations",
	security: [{ Bearer: [] }],
	request: { query: FeedQuery },
	responses: {
		200: {
			description: "Paginated list of conversations",
			content: { "application/json": { schema: FeedResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(feedRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { type, platform, account_id, status, labels, cursor, limit } =
		c.req.valid("query");

	const parsedLabels = labels
		? labels.split(",").map((l) => l.trim()).filter(Boolean)
		: undefined;

	const result = await listConversations(db, orgId, {
		type,
		platform,
		status,
		accountId: account_id,
		labels: parsedLabels,
		cursor,
		limit,
		workspaceScope: c.get("workspaceScope"),
	});

	return c.json(
		{
			data: result.data.map(serializeConversation),
			next_cursor: result.next_cursor,
			has_more: result.has_more,
		} as never,
		200,
	);
});

// ---------------------------------------------------------------------------
// 2. POST /bulk — Bulk actions
// ---------------------------------------------------------------------------

const bulkRoute = createRoute({
	operationId: "bulkInboxAction",
	method: "post",
	path: "/bulk",
	tags: ["Inbox"],
	summary: "Perform bulk actions on conversations",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: BulkActionBody } },
		},
	},
	responses: {
		200: {
			description: "Bulk action result",
			content: { "application/json": { schema: BulkActionResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(bulkRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const workspaceScope = c.get("workspaceScope");
	const { action, targets, params } = c.req.valid("json");

	// Build workspace scope conditions for direct DB queries
	const wsConditions = (conversationId: string) => {
		const conds = [
			eq(inboxConversations.id, conversationId),
			eq(inboxConversations.organizationId, orgId),
		];
		if (workspaceScope !== "all") {
			conds.push(
				or(
					inArray(inboxConversations.workspaceId, workspaceScope),
					isNull(inboxConversations.workspaceId),
				)!,
			);
		}
		return conds;
	};

	let processed = 0;
	let failed = 0;
	const errors: string[] = [];

	// Label/unlabel are the only actions that need the current labels array to
	// compute the merged result. Pre-fetch all of them in one query so the
	// per-conversation loop doesn't do its own SELECT.
	const needsLabels = action === "label" || action === "unlabel";
	const existingLabelsByConvo = new Map<string, string[]>();
	if (needsLabels && targets.length > 0) {
		const scopeConds = [
			inArray(inboxConversations.id, targets),
			eq(inboxConversations.organizationId, orgId),
		];
		if (workspaceScope !== "all") {
			scopeConds.push(
				or(
					inArray(inboxConversations.workspaceId, workspaceScope),
					isNull(inboxConversations.workspaceId),
				)!,
			);
		}
		const rows = await db
			.select({ id: inboxConversations.id, labels: inboxConversations.labels })
			.from(inboxConversations)
			.where(and(...scopeConds));
		for (const r of rows) {
			existingLabelsByConvo.set(r.id, r.labels ?? []);
		}
	}

	for (const conversationId of targets) {
		try {
			let updates: Parameters<typeof updateConversation>[3];

			switch (action) {
				case "label": {
					const currentLabels = existingLabelsByConvo.get(conversationId);
					if (currentLabels === undefined) {
						failed++;
						errors.push(`${conversationId}: not found`);
						continue;
					}
					const newLabels = params?.labels ?? [];
					const merged = [...new Set([...currentLabels, ...newLabels])];
					updates = { labels: merged };
					break;
				}
				case "unlabel": {
					const currentLabels = existingLabelsByConvo.get(conversationId);
					if (currentLabels === undefined) {
						failed++;
						errors.push(`${conversationId}: not found`);
						continue;
					}
					const removeLabels = new Set(params?.labels ?? []);
					updates = {
						labels: currentLabels.filter((l) => !removeLabels.has(l)),
					};
					break;
				}
				case "archive":
					updates = { status: "archived" };
					break;
				case "unarchive":
					updates = { status: "open" };
					break;
				case "mark_read":
					// Reset unread count directly
					await db
						.update(inboxConversations)
						.set({ unreadCount: 0, updatedAt: new Date() })
						.where(and(...wsConditions(conversationId)));
					processed++;
					continue;
				case "set_priority":
					updates = { priority: params?.priority ?? "normal" };
					break;
			}

			const result = await updateConversation(
				db,
				conversationId,
				orgId,
				updates,
				workspaceScope,
			);
			if (result) {
				processed++;
			} else {
				failed++;
				errors.push(`${conversationId}: not found`);
			}
		} catch (err) {
			failed++;
			errors.push(
				`${conversationId}: ${err instanceof Error ? err.message : "unknown error"}`,
			);
		}
	}

	return c.json({ processed, failed, errors }, 200);
});

// ---------------------------------------------------------------------------
// 3. GET /search — Full-text search
// ---------------------------------------------------------------------------

const searchRoute = createRoute({
	operationId: "searchInboxMessages",
	method: "get",
	path: "/search",
	tags: ["Inbox"],
	summary: "Full-text search across inbox messages",
	security: [{ Bearer: [] }],
	request: { query: SearchQuery },
	responses: {
		200: {
			description: "Search results",
			content: { "application/json": { schema: SearchResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(searchRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { q, platform, since, until, cursor, limit } =
		c.req.valid("query");

	const result = await searchMessages(db, orgId, q, {
		platform,
		since,
		until,
		cursor,
		limit,
		workspaceScope: c.get("workspaceScope"),
	});

	return c.json(
		{
			data: result.data.map((msg) => ({
				id: msg.id,
				conversation_id: msg.conversationId,
				author_name: msg.authorName,
				author_avatar_url: msg.authorAvatarUrl,
				text: msg.text,
				direction: msg.direction,
				attachments: msg.attachments,
				created_at: msg.createdAt.toISOString(),
			})),
			next_cursor: result.next_cursor,
			has_more: result.has_more,
		},
		200,
	);
});

// ---------------------------------------------------------------------------
// 4. GET /stats — Aggregated metrics
// ---------------------------------------------------------------------------

const statsRoute = createRoute({
	operationId: "getInboxStats",
	method: "get",
	path: "/stats",
	tags: ["Inbox"],
	summary: "Aggregated inbox metrics",
	security: [{ Bearer: [] }],
	request: { query: StatsQuery },
	responses: {
		200: {
			description: "Inbox statistics",
			content: { "application/json": { schema: StatsResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(statsRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { platform, account_id } = c.req.valid("query");

	const stats = await getInboxStats(db, orgId, {
		platform,
		accountId: account_id,
		workspaceScope: c.get("workspaceScope"),
	});

	return c.json(stats, 200);
});

// ---------------------------------------------------------------------------
// 5. GET /conversations/:id — Full conversation thread
// ---------------------------------------------------------------------------

const getConversationRoute = createRoute({
	operationId: "getInboxConversation",
	method: "get",
	path: "/conversations/{id}",
	tags: ["Inbox"],
	summary: "Get full conversation thread with messages",
	security: [{ Bearer: [] }],
	request: { params: ConversationIdParam },
	responses: {
		200: {
			description: "Conversation with messages",
			content: {
				"application/json": { schema: ConversationDetailResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Conversation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getConversationRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");

	const result = await getConversationWithMessages(db, id, orgId, c.get("workspaceScope"));

	if (!result) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Conversation not found",
				},
			} as never,
			404 as never,
		);
	}

	return c.json(
		{
			conversation: serializeConversation(result.conversation),
			messages: result.messages.map(serializeMessage),
		} as never,
		200,
	);
});

// ---------------------------------------------------------------------------
// 6. PATCH /conversations/:id — Update conversation
// ---------------------------------------------------------------------------

const updateConversationRoute = createRoute({
	operationId: "updateInboxConversation",
	method: "patch",
	path: "/conversations/{id}",
	tags: ["Inbox"],
	summary: "Update conversation status, labels, or priority",
	security: [{ Bearer: [] }],
	request: {
		params: ConversationIdParam,
		body: {
			content: { "application/json": { schema: UpdateConversationBody } },
		},
	},
	responses: {
		200: {
			description: "Updated conversation",
			content: {
				"application/json": { schema: UpdateConversationResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Conversation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateConversationRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");

	if (body.assigned_user_id) {
		const orgMember = await db.query.member.findFirst({
			where: and(
				eq(member.organizationId, orgId),
				eq(member.userId, body.assigned_user_id),
			),
		});
		if (!orgMember) {
			return c.json(
				{
					error: {
						code: "BAD_REQUEST",
						message: `Organization member '${body.assigned_user_id}' not found`,
					},
				} as never,
				400 as never,
			);
		}
	}

	const updated = await updateConversation(db, id, orgId, {
		status: body.status,
		labels: body.labels,
		priority: body.priority,
		assignedUserId: body.assigned_user_id,
	}, c.get("workspaceScope"));

	if (!updated) {
		return c.json(
			{
				error: {
					code: "NOT_FOUND",
					message: "Conversation not found",
				},
			} as never,
			404 as never,
		);
	}

	return c.json(
		{
			conversation: serializeConversation(updated),
		} as never,
		200,
	);
});

// ---------------------------------------------------------------------------
// 7. POST /conversations/:id/messages — Send a message
// ---------------------------------------------------------------------------

const sendMessageRoute = createRoute({
	operationId: "sendConversationMessage",
	method: "post",
	path: "/conversations/{id}/messages",
	tags: ["Inbox"],
	summary: "Send a message in a conversation",
	security: [{ Bearer: [] }],
	request: {
		params: ConversationIdParam,
		body: {
			content: { "application/json": { schema: SendMessageBody } },
		},
	},
	responses: {
		200: {
			description: "Send result",
			content: { "application/json": { schema: MessageActionResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(sendMessageRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id: conversationId } = c.req.valid("param");
	const body = c.req.valid("json");
	const { account_id, text, attachments, message_tag, quick_replies, template } = body;
	const db = c.get("db");

	const account = await getAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account?.accessToken) {
		return c.json({ success: false }, 200);
	}

	try {
		switch (account.platform) {
			case "facebook":
			case "instagram": {
				const msgHost = account.platform === "instagram" ? igGraphHost(account.accessToken) : "graph.facebook.com";
				let recipientId: string | undefined;

				// Local DB conversations (conv_ prefix) — look up recipient from DB
				if (conversationId.startsWith("conv_")) {
					const [conv] = await db
						.select({ participantPlatformId: inboxConversations.participantPlatformId, platformConversationId: inboxConversations.platformConversationId })
						.from(inboxConversations)
						.where(eq(inboxConversations.id, conversationId))
						.limit(1);
					recipientId = conv?.participantPlatformId ?? conv?.platformConversationId ?? undefined;
				} else {
					// Graph API conversation — fetch participants
					const convRes = await fetch(
						`https://${msgHost}/${API_VERSIONS.meta_graph}/${conversationId}?access_token=${encodeURIComponent(account.accessToken)}&fields=participants`,
					);
					if (convRes.ok) {
						const convJson = (await convRes.json()) as {
							participants?: { data: Array<{ id: string }> };
						};
						recipientId = convJson.participants?.data?.find(
							(p) => p.id !== account.platformAccountId,
						)?.id;
					}
				}
				if (!recipientId) return c.json({ success: false }, 200);

				const fbSendUrl = `https://${msgHost}/${API_VERSIONS.meta_graph}/me/messages?access_token=${encodeURIComponent(account.accessToken)}`;
				const fbHeaders = { "Content-Type": "application/json" };
				let lastMessageId: string | undefined;
				const sentMids: string[] = []; // Track all sent mids for echo suppression

				// Build the message payload
				// Docs: https://developers.facebook.com/docs/messenger-platform/reference/send-api/
				if (template) {
					// Structured template message (generic or button)
					// Docs: https://developers.facebook.com/docs/messenger-platform/send-messages/templates
					const res = await fetch(fbSendUrl, {
						method: "POST",
						headers: fbHeaders,
						body: JSON.stringify({
							recipient: { id: recipientId },
							messaging_type: message_tag ? "MESSAGE_TAG" : "RESPONSE",
							...(message_tag && { tag: message_tag }),
							message: {
								attachment: {
									type: "template",
									payload: {
										template_type: template.type,
										elements: template.elements,
									},
								},
							},
						}),
					});
					if (!res.ok) return c.json({ success: false }, 200);
					const json = (await res.json()) as { message_id?: string };
					lastMessageId = json.message_id;
				} else if (attachments && attachments.length > 0) {
					// Send attachments as attachment messages
					// Docs: https://developers.facebook.com/docs/messenger-platform/send-messages/saving-assets
					for (const att of attachments) {
						const fbType = att.type.startsWith("image/")
							? "image"
							: att.type.startsWith("video/")
								? "video"
								: att.type.startsWith("audio/")
									? "audio"
									: "file";
						const res = await fetch(fbSendUrl, {
							method: "POST",
							headers: fbHeaders,
							body: JSON.stringify({
								recipient: { id: recipientId },
								messaging_type: message_tag ? "MESSAGE_TAG" : "RESPONSE",
								...(message_tag && { tag: message_tag }),
								message: {
									attachment: {
										type: fbType,
										payload: { url: att.url, is_reusable: true },
									},
								},
							}),
						});
						if (res.ok) {
							const json = (await res.json()) as { message_id?: string };
							lastMessageId = json.message_id;
							if (json.message_id) sentMids.push(json.message_id);
						}
					}
					// Send text as a separate message if present (FB doesn't support text + attachment together)
					if (text) {
						const msgPayload: Record<string, unknown> = { text };
						if (quick_replies) msgPayload.quick_replies = quick_replies;
						const res = await fetch(fbSendUrl, {
							method: "POST",
							headers: fbHeaders,
							body: JSON.stringify({
								recipient: { id: recipientId },
								messaging_type: message_tag ? "MESSAGE_TAG" : "RESPONSE",
								...(message_tag && { tag: message_tag }),
								message: msgPayload,
							}),
						});
						if (res.ok) {
							const json = (await res.json()) as { message_id?: string };
							lastMessageId = json.message_id;
							if (json.message_id) sentMids.push(json.message_id);
						}
					}
				} else {
					// Text-only message (with optional quick replies)
					// Docs: https://developers.facebook.com/docs/messenger-platform/send-messages/quick-replies
					if (!text) return c.json({ success: false, error: "Message text is required when no template or attachments are provided" }, 200);
					const msgPayload: Record<string, unknown> = { text };
					if (quick_replies) msgPayload.quick_replies = quick_replies;
					const res = await fetch(fbSendUrl, {
						method: "POST",
						headers: fbHeaders,
						body: JSON.stringify({
							recipient: { id: recipientId },
							messaging_type: message_tag ? "MESSAGE_TAG" : "RESPONSE",
							...(message_tag && { tag: message_tag }),
							message: msgPayload,
						}),
					});
					if (!res.ok) return c.json({ success: false }, 200);
					const json = (await res.json()) as { message_id?: string };
					lastMessageId = json.message_id;
				}

				// Persist outbound message for FB/IG
				if (lastMessageId) {
					await insertMessage(db, {
						conversationId,
						organizationId: orgId,
						platformMessageId: lastMessageId,
						authorName: "You",
						authorPlatformId: account.platformAccountId,
						text: text ?? (template ? `[Template: ${template.type}]` : "[Attachment]"),
						direction: "outbound",
						attachments: attachments ?? [],
					});
					sentMids.push(lastMessageId);
				}
				// Mark all sent mids as outbound so the webhook handler skips
				// echoes — Instagram Login API doesn't set is_echo on echoes.
				for (const sentMid of sentMids) {
					await c.env.KV.put(`outbound-mid:${sentMid}`, "1", { expirationTtl: 300 });
				}

				c.executionCtx.waitUntil(notifyRealtime(c.env, orgId, { type: "inbox.message.sent", conversation_id: conversationId }));
				return c.json({ success: true, message_id: lastMessageId }, 200);
				}
				case "whatsapp": {
					if (attachments && attachments.length > 1) {
						return c.json(
							{
								success: false,
								error: "WhatsApp supports only one attachment per message",
							},
							200,
						);
					}

					// Look up the conversation to get the recipient phone number
					const [conv] = await db
						.select()
						.from(inboxConversations)
						.where(
							and(
							eq(inboxConversations.id, conversationId),
							eq(inboxConversations.organizationId, orgId),
						),
						)
						.limit(1);

					if (!conv?.platformConversationId) {
						return c.json({ success: false }, 200);
				}

				const recipientPhone = conv.platformConversationId;
				const phoneNumberId = account.platformAccountId;

				// Build WhatsApp message payload
				// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages/
				let waBody: Record<string, unknown>;

				if (attachments && attachments.length > 0) {
					// Send first attachment as media message
					const att = attachments[0]!;
					const waType = att.type.startsWith("image/")
						? "image"
						: att.type.startsWith("video/")
							? "video"
							: att.type.startsWith("audio/")
								? "audio"
								: "document";
					waBody = {
						messaging_product: "whatsapp",
						recipient_type: "individual",
						to: recipientPhone,
						type: waType,
						[waType]: { link: att.url, ...(text && { caption: text }) },
					};
				} else if (text) {
					waBody = {
						messaging_product: "whatsapp",
						recipient_type: "individual",
						to: recipientPhone,
						type: "text",
						text: { body: text },
					};
				} else {
					return c.json({ success: false, error: "WhatsApp requires text or attachments" }, 200);
				}

				const waRes = await fetch(
					`${GRAPH_BASE.facebook}/${phoneNumberId}/messages`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${account.accessToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(waBody),
					},
				);

				if (!waRes.ok) {
					const errData = await waRes.json() as { error?: { code?: number; message?: string } };
					if (errData.error?.code === 131047) {
						return c.json({
							success: false,
							error: "Outside 24-hour messaging window. Use a template message instead.",
						}, 200);
					}
					return c.json({ success: false }, 200);
				}

				const waJson = await waRes.json() as { messages?: Array<{ id: string }> };
				const waMessageId = waJson.messages?.[0]?.id;

				// Record outbound message in inbox
				await insertMessage(db, {
					conversationId,
					organizationId: orgId,
					platformMessageId: waMessageId ?? `wa_out_${Date.now()}`,
					authorName: "You",
					authorPlatformId: phoneNumberId,
					text: text ?? "[Attachment]",
					direction: "outbound",
					attachments: attachments ?? [],
				});

				c.executionCtx.waitUntil(notifyRealtime(c.env, orgId, { type: "inbox.message.sent", conversation_id: conversationId }));
				return c.json({ success: true, message_id: waMessageId }, 200);
			}
			default:
				return c.json({ success: false }, 200);
		}
	} catch {
		return c.json({ success: false }, 200);
	}
});

// ---------------------------------------------------------------------------
// 8. POST /conversations/:id/typing — Send typing indicator
// ---------------------------------------------------------------------------

const sendTypingRoute = createRoute({
	operationId: "sendConversationTyping",
	method: "post",
	path: "/conversations/{id}/typing",
	tags: ["Inbox"],
	summary: "Send a typing indicator",
	description: "Shows a typing indicator to the recipient. Best-effort — always returns success.",
	security: [{ Bearer: [] }],
	request: {
		params: ConversationIdParam,
		body: {
			content: { "application/json": { schema: SendTypingBody } },
		},
	},
	responses: {
		200: {
			description: "Typing indicator sent",
			content: { "application/json": { schema: MessageActionResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(sendTypingRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id: conversationId } = c.req.valid("param");
	const { account_id } = c.req.valid("json");
	const db = c.get("db");

	const account = await getAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account?.accessToken) {
		return c.json({ success: true }, 200); // best-effort
	}

	try {
		switch (account.platform) {
			case "facebook":
			case "instagram": {
				// Get recipient ID from conversation
				// Docs: https://developers.facebook.com/docs/messenger-platform/send-messages/sender-actions
				const convRes = await fetch(
					`${GRAPH_BASE.facebook}/${conversationId}?access_token=${encodeURIComponent(account.accessToken)}&fields=participants`,
				);
				if (!convRes.ok) return c.json({ success: true }, 200);
				const convJson = (await convRes.json()) as {
					participants?: { data: Array<{ id: string }> };
				};
				const recipient = convJson.participants?.data?.find(
					(p) => p.id !== account.platformAccountId,
				);
				if (!recipient) return c.json({ success: true }, 200);

				await fetch(
					`${GRAPH_BASE.facebook}/me/messages?access_token=${encodeURIComponent(account.accessToken)}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							recipient: { id: recipient.id },
							sender_action: "typing_on",
						}),
					},
				);
				break;
			}
			case "telegram": {
				// Look up conversation to get chat_id
				const [conv] = await db
					.select()
					.from(inboxConversations)
					.where(
						and(
							eq(inboxConversations.id, conversationId),
							eq(inboxConversations.organizationId, orgId),
						),
					)
					.limit(1);
				if (!conv?.platformConversationId) break;

				// Docs: https://core.telegram.org/bots/api#sendchataction
				await fetch(
					`https://api.telegram.org/bot${account.accessToken}/sendChatAction`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							chat_id: conv.platformConversationId,
							action: "typing",
						}),
					},
				);
				break;
			}
			default:
				break; // no-op for unsupported platforms
		}
	} catch {
		// best-effort, swallow errors
	}

	return c.json({ success: true }, 200);
});

// ---------------------------------------------------------------------------
// 9. POST /conversations/:id/messages/:messageId/reactions — Add reaction
// ---------------------------------------------------------------------------

const ConversationMessageIdParam = z.object({
	id: z.string().describe("Conversation ID"),
	message_id: z.string().describe("Message ID"),
});

const addReactionRoute = createRoute({
	operationId: "addConversationReaction",
	method: "post",
	path: "/conversations/{id}/messages/{message_id}/reactions",
	tags: ["Inbox"],
	summary: "Add a reaction to a message",
	security: [{ Bearer: [] }],
	request: {
		params: ConversationMessageIdParam,
		body: {
			content: { "application/json": { schema: AddReactionBody } },
		},
	},
	responses: {
		200: {
			description: "Reaction result",
			content: { "application/json": { schema: MessageActionResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(addReactionRoute, async (c) => {
	const orgId = c.get("orgId");
	const params = c.req.valid("param");
	const conversationId = params.id;
	const messageId = params.message_id;
	const { account_id, emoji } = c.req.valid("json");
	const db = c.get("db");

	const account = await getAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account?.accessToken) {
		return c.json({ success: false }, 200);
	}

	// Resolve platformMessageId from our DB
	const [msg] = await db
		.select()
		.from(inboxMessages)
		.where(
			and(
				eq(inboxMessages.id, messageId),
				eq(inboxMessages.conversationId, conversationId),
				eq(inboxMessages.organizationId, orgId),
			),
		)
		.limit(1);
	if (!msg) {
		return c.json({ success: false, error: "Message not found" }, 200);
	}

	try {
		switch (account.platform) {
			case "whatsapp": {
				const [conv] = await db
					.select()
					.from(inboxConversations)
					.where(
						and(
							eq(inboxConversations.id, conversationId),
							eq(inboxConversations.organizationId, orgId),
						),
					)
					.limit(1);
				if (!conv?.platformConversationId) {
					return c.json({ success: false }, 200);
				}

				// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages#reaction-messages
				const waRes = await fetch(
					`${GRAPH_BASE.facebook}/${account.platformAccountId}/messages`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${account.accessToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							messaging_product: "whatsapp",
							recipient_type: "individual",
							to: conv.platformConversationId,
							type: "reaction",
							reaction: {
								message_id: msg.platformMessageId,
								emoji,
							},
						}),
					},
				);
				if (!waRes.ok) return c.json({ success: false }, 200);
				return c.json({ success: true }, 200);
			}
			case "telegram": {
				const [conv] = await db
					.select()
					.from(inboxConversations)
					.where(
						and(
							eq(inboxConversations.id, conversationId),
							eq(inboxConversations.organizationId, orgId),
						),
					)
					.limit(1);
				if (!conv?.platformConversationId) {
					return c.json({ success: false }, 200);
				}

				// Docs: https://core.telegram.org/bots/api#setmessagereaction
				const tgRes = await fetch(
					`https://api.telegram.org/bot${account.accessToken}/setMessageReaction`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							chat_id: conv.platformConversationId,
							message_id: Number(msg.platformMessageId),
							reaction: [{ type: "emoji", emoji }],
						}),
					},
				);
				if (!tgRes.ok) return c.json({ success: false }, 200);
				return c.json({ success: true }, 200);
			}
			default:
				return c.json({
					success: false,
					error: "Reactions not supported for this platform",
				}, 200);
		}
	} catch {
		return c.json({ success: false }, 200);
	}
});

// ---------------------------------------------------------------------------
// 10. DELETE /conversations/:id/messages/:messageId/reactions — Remove reaction
// ---------------------------------------------------------------------------

const removeReactionRoute = createRoute({
	operationId: "removeConversationReaction",
	method: "delete",
	path: "/conversations/{id}/messages/{message_id}/reactions",
	tags: ["Inbox"],
	summary: "Remove a reaction from a message",
	security: [{ Bearer: [] }],
	request: {
		params: ConversationMessageIdParam,
		query: RemoveReactionQuery,
	},
	responses: {
		200: {
			description: "Reaction removed",
			content: { "application/json": { schema: MessageActionResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(removeReactionRoute, async (c) => {
	const orgId = c.get("orgId");
	const params = c.req.valid("param");
	const conversationId = params.id;
	const messageId = params.message_id;
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account?.accessToken) {
		return c.json({ success: false }, 200);
	}

	const [msg] = await db
		.select()
		.from(inboxMessages)
		.where(
			and(
				eq(inboxMessages.id, messageId),
				eq(inboxMessages.conversationId, conversationId),
				eq(inboxMessages.organizationId, orgId),
			),
		)
		.limit(1);
	if (!msg) {
		return c.json({ success: false, error: "Message not found" }, 200);
	}

	try {
		switch (account.platform) {
			case "whatsapp": {
				const [conv] = await db
					.select()
					.from(inboxConversations)
					.where(
						and(
							eq(inboxConversations.id, conversationId),
							eq(inboxConversations.organizationId, orgId),
						),
					)
					.limit(1);
				if (!conv?.platformConversationId) {
					return c.json({ success: false }, 200);
				}

				// Send empty emoji to remove reaction
				const waRes = await fetch(
					`${GRAPH_BASE.facebook}/${account.platformAccountId}/messages`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${account.accessToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							messaging_product: "whatsapp",
							recipient_type: "individual",
							to: conv.platformConversationId,
							type: "reaction",
							reaction: {
								message_id: msg.platformMessageId,
								emoji: "",
							},
						}),
					},
				);
				if (!waRes.ok) return c.json({ success: false }, 200);
				return c.json({ success: true }, 200);
			}
			case "telegram": {
				const [conv] = await db
					.select()
					.from(inboxConversations)
					.where(
						and(
							eq(inboxConversations.id, conversationId),
							eq(inboxConversations.organizationId, orgId),
						),
					)
					.limit(1);
				if (!conv?.platformConversationId) {
					return c.json({ success: false }, 200);
				}

				// Send empty reaction array to remove
				const tgRes = await fetch(
					`https://api.telegram.org/bot${account.accessToken}/setMessageReaction`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							chat_id: conv.platformConversationId,
							message_id: Number(msg.platformMessageId),
							reaction: [],
						}),
					},
				);
				if (!tgRes.ok) return c.json({ success: false }, 200);
				return c.json({ success: true }, 200);
			}
			default:
				return c.json({
					success: false,
					error: "Reactions not supported for this platform",
				}, 200);
		}
	} catch {
		return c.json({ success: false }, 200);
	}
});

// ---------------------------------------------------------------------------
// 11. DELETE /conversations/:id/messages/:messageId — Delete a message
// ---------------------------------------------------------------------------

const deleteMessageRoute = createRoute({
	operationId: "deleteConversationMessage",
	method: "delete",
	path: "/conversations/{id}/messages/{message_id}",
	tags: ["Inbox"],
	summary: "Delete a message",
	security: [{ Bearer: [] }],
	request: {
		params: ConversationMessageIdParam,
		query: DeleteMessageQuery,
	},
	responses: {
		200: {
			description: "Delete result",
			content: { "application/json": { schema: MessageActionResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteMessageRoute, async (c) => {
	const orgId = c.get("orgId");
	const params = c.req.valid("param");
	const conversationId = params.id;
	const messageId = params.message_id;
	const { account_id } = c.req.valid("query");
	const db = c.get("db");

	const account = await getAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account?.accessToken) {
		return c.json({ success: false }, 200);
	}

	const [msg] = await db
		.select()
		.from(inboxMessages)
		.where(
			and(
				eq(inboxMessages.id, messageId),
				eq(inboxMessages.conversationId, conversationId),
				eq(inboxMessages.organizationId, orgId),
			),
		)
		.limit(1);
	if (!msg) {
		return c.json({ success: false, error: "Message not found" }, 200);
	}

	try {
		switch (account.platform) {
			case "telegram": {
				const [conv] = await db
					.select()
					.from(inboxConversations)
					.where(
						and(
							eq(inboxConversations.id, conversationId),
							eq(inboxConversations.organizationId, orgId),
						),
					)
					.limit(1);
				if (!conv?.platformConversationId) {
					return c.json({ success: false }, 200);
				}

				// Docs: https://core.telegram.org/bots/api#deletemessage
				const tgRes = await fetch(
					`https://api.telegram.org/bot${account.accessToken}/deleteMessage`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							chat_id: conv.platformConversationId,
							message_id: Number(msg.platformMessageId),
						}),
					},
				);
				if (!tgRes.ok) return c.json({ success: false }, 200);
				break;
			}
			case "twitter": {
				const [conv] = await db
					.select()
					.from(inboxConversations)
					.where(
						and(
							eq(inboxConversations.id, conversationId),
							eq(inboxConversations.organizationId, orgId),
						),
					)
					.limit(1);
				if (!conv?.platformConversationId) {
					return c.json({ success: false }, 200);
				}

				// Docs: https://developer.x.com/en/docs/twitter-api/direct-messages/manage/api-reference
				const twRes = await fetch(
					`https://api.x.com/2/dm_conversations/${conv.platformConversationId}/dm_events/${msg.platformMessageId}`,
					{
						method: "DELETE",
						headers: {
							Authorization: `Bearer ${account.accessToken}`,
						},
					},
				);
				if (!twRes.ok) return c.json({ success: false }, 200);
				break;
			}
			case "facebook":
			case "instagram":
			case "whatsapp":
				return c.json({
					success: false,
					error: "Message deletion not supported for this platform",
				}, 200);
			default:
				return c.json({
					success: false,
					error: "Message deletion not supported for this platform",
				}, 200);
		}

		// Delete from local DB on success
		await db
			.delete(inboxMessages)
			.where(
				and(
					eq(inboxMessages.id, messageId),
					eq(inboxMessages.organizationId, orgId),
				),
			);

		return c.json({ success: true }, 200);
	} catch {
		return c.json({ success: false }, 200);
	}
});

// ---------------------------------------------------------------------------
// Notes — list
// ---------------------------------------------------------------------------

const listNotesRoute = createRoute({
	operationId: "listConversationNotes",
	method: "get",
	path: "/conversations/{id}/notes",
	tags: ["Inbox"],
	summary: "List internal notes on a conversation",
	security: [{ Bearer: [] }],
	request: { params: ConversationIdParam },
	responses: {
		200: {
			description: "List of notes",
			content: { "application/json": { schema: ListInboxNotesResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Conversation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listNotesRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { id: conversationId } = c.req.valid("param");

	const [conv] = await db
		.select({
			id: inboxConversations.id,
			workspaceId: inboxConversations.workspaceId,
		})
		.from(inboxConversations)
		.where(
			and(
				eq(inboxConversations.id, conversationId),
				eq(inboxConversations.organizationId, orgId),
			),
		)
		.limit(1);

	if (!conv) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Conversation not found" } } as never,
			404 as never,
		);
	}

	if (isWorkspaceScopeDenied(c, conv.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY as never, 403 as never);
	}

	const rows = await db
		.select({
			id: inboxConversationNotes.id,
			conversationId: inboxConversationNotes.conversationId,
			organizationId: inboxConversationNotes.organizationId,
			userId: inboxConversationNotes.userId,
			text: inboxConversationNotes.text,
			createdAt: inboxConversationNotes.createdAt,
			updatedAt: inboxConversationNotes.updatedAt,
			authorName: userTable.name,
			authorEmail: userTable.email,
		})
		.from(inboxConversationNotes)
		.leftJoin(userTable, eq(userTable.id, inboxConversationNotes.userId))
		.where(eq(inboxConversationNotes.conversationId, conversationId))
		.orderBy(inboxConversationNotes.createdAt);

	return c.json(
		{
			data: rows.map((r) => ({
				id: r.id,
				conversation_id: r.conversationId,
				organization_id: r.organizationId,
				user_id: r.userId,
				author_name: r.authorName ?? null,
				author_email: r.authorEmail ?? null,
				text: r.text,
				created_at: r.createdAt.toISOString(),
				updated_at: r.updatedAt.toISOString(),
			})),
		} as never,
		200,
	);
});

// ---------------------------------------------------------------------------
// Notes — create
// ---------------------------------------------------------------------------

const createNoteRoute = createRoute({
	operationId: "createConversationNote",
	method: "post",
	path: "/conversations/{id}/notes",
	tags: ["Inbox"],
	summary: "Add an internal note to a conversation",
	security: [{ Bearer: [] }],
	request: {
		params: ConversationIdParam,
		body: {
			content: { "application/json": { schema: CreateInboxNoteBody } },
		},
	},
	responses: {
		201: {
			description: "Created note",
			content: { "application/json": { schema: InboxNoteResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Conversation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createNoteRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { id: conversationId } = c.req.valid("param");
	const body = c.req.valid("json");

	const [conv] = await db
		.select({
			id: inboxConversations.id,
			workspaceId: inboxConversations.workspaceId,
		})
		.from(inboxConversations)
		.where(
			and(
				eq(inboxConversations.id, conversationId),
				eq(inboxConversations.organizationId, orgId),
			),
		)
		.limit(1);

	if (!conv) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Conversation not found" } } as never,
			404 as never,
		);
	}

	if (isWorkspaceScopeDenied(c, conv.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY as never, 403 as never);
	}

	// Verify the acting user belongs to the org
	const orgMember = await db.query.member.findFirst({
		where: and(
			eq(member.organizationId, orgId),
			eq(member.userId, body.user_id),
		),
	});
	if (!orgMember) {
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: `Organization member '${body.user_id}' not found`,
				},
			} as never,
			400 as never,
		);
	}

	const [row] = await db
		.insert(inboxConversationNotes)
		.values({
			conversationId,
			organizationId: orgId,
			userId: body.user_id,
			text: body.text,
		})
		.returning();

	if (!row) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create note",
				},
			} as never,
			500 as never,
		);
	}

	const [author] = await db
		.select({ name: userTable.name, email: userTable.email })
		.from(userTable)
		.where(eq(userTable.id, body.user_id))
		.limit(1);

	return c.json(
		{
			note: {
				id: row.id,
				conversation_id: row.conversationId,
				organization_id: row.organizationId,
				user_id: row.userId,
				author_name: author?.name ?? null,
				author_email: author?.email ?? null,
				text: row.text,
				created_at: row.createdAt.toISOString(),
				updated_at: row.updatedAt.toISOString(),
			},
		} as never,
		201,
	);
});

// ---------------------------------------------------------------------------
// Notes — update
// ---------------------------------------------------------------------------

const updateNoteRoute = createRoute({
	operationId: "updateInboxNote",
	method: "patch",
	path: "/notes/{noteId}",
	tags: ["Inbox"],
	summary: "Update an internal note",
	security: [{ Bearer: [] }],
	request: {
		params: NoteIdParam,
		body: { content: { "application/json": { schema: UpdateInboxNoteBody } } },
	},
	responses: {
		200: {
			description: "Updated note",
			content: { "application/json": { schema: InboxNoteResponse } },
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied or forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Note not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateNoteRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { noteId } = c.req.valid("param");
	const body = c.req.valid("json");

	const [existing] = await db
		.select({
			id: inboxConversationNotes.id,
			organizationId: inboxConversationNotes.organizationId,
			userId: inboxConversationNotes.userId,
			conversationId: inboxConversationNotes.conversationId,
			workspaceId: inboxConversations.workspaceId,
		})
		.from(inboxConversationNotes)
		.innerJoin(
			inboxConversations,
			eq(inboxConversations.id, inboxConversationNotes.conversationId),
		)
		.where(eq(inboxConversationNotes.id, noteId))
		.limit(1);

	if (!existing || existing.organizationId !== orgId) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Note not found" } } as never,
			404 as never,
		);
	}

	if (isWorkspaceScopeDenied(c, existing.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY as never, 403 as never);
	}

	// Verify the acting user belongs to the org
	const orgMember = await db.query.member.findFirst({
		where: and(
			eq(member.organizationId, orgId),
			eq(member.userId, body.user_id),
		),
	});
	if (!orgMember) {
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: `Organization member '${body.user_id}' not found`,
				},
			} as never,
			400 as never,
		);
	}

	if (existing.userId !== body.user_id) {
		return c.json(
			{ error: { code: "FORBIDDEN", message: "Cannot edit another user's note" } } as never,
			403 as never,
		);
	}

	const [row] = await db
		.update(inboxConversationNotes)
		.set({ text: body.text, updatedAt: new Date() })
		.where(eq(inboxConversationNotes.id, noteId))
		.returning();

	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Note not found" } } as never,
			404 as never,
		);
	}

	const [author] = await db
		.select({ name: userTable.name, email: userTable.email })
		.from(userTable)
		.where(eq(userTable.id, row.userId))
		.limit(1);

	return c.json(
		{
			note: {
				id: row.id,
				conversation_id: row.conversationId,
				organization_id: row.organizationId,
				user_id: row.userId,
				author_name: author?.name ?? null,
				author_email: author?.email ?? null,
				text: row.text,
				created_at: row.createdAt.toISOString(),
				updated_at: row.updatedAt.toISOString(),
			},
		} as never,
		200,
	);
});

// ---------------------------------------------------------------------------
// Notes — delete
// ---------------------------------------------------------------------------

const deleteNoteRoute = createRoute({
	operationId: "deleteInboxNote",
	method: "delete",
	path: "/notes/{noteId}",
	tags: ["Inbox"],
	summary: "Delete an internal note",
	security: [{ Bearer: [] }],
	request: {
		params: NoteIdParam,
		query: DeleteInboxNoteQuery,
	},
	responses: {
		200: {
			description: "Deleted",
			content: { "application/json": { schema: DeleteInboxNoteResponse } },
		},
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied or forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Note not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteNoteRoute, async (c) => {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const { noteId } = c.req.valid("param");
	const { user_id: actingUserId } = c.req.valid("query");

	const [existing] = await db
		.select({
			id: inboxConversationNotes.id,
			organizationId: inboxConversationNotes.organizationId,
			userId: inboxConversationNotes.userId,
			workspaceId: inboxConversations.workspaceId,
		})
		.from(inboxConversationNotes)
		.innerJoin(
			inboxConversations,
			eq(inboxConversations.id, inboxConversationNotes.conversationId),
		)
		.where(eq(inboxConversationNotes.id, noteId))
		.limit(1);

	if (!existing || existing.organizationId !== orgId) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Note not found" } } as never,
			404 as never,
		);
	}

	if (isWorkspaceScopeDenied(c, existing.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY as never, 403 as never);
	}

	const orgMember = await db.query.member.findFirst({
		where: and(
			eq(member.organizationId, orgId),
			eq(member.userId, actingUserId),
		),
	});
	if (!orgMember) {
		return c.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: `Organization member '${actingUserId}' not found`,
				},
			} as never,
			400 as never,
		);
	}

	if (existing.userId !== actingUserId) {
		return c.json(
			{ error: { code: "FORBIDDEN", message: "Cannot delete another user's note" } } as never,
			403 as never,
		);
	}

	await db.delete(inboxConversationNotes).where(eq(inboxConversationNotes.id, noteId));

	return c.json({ success: true } as never, 200);
});

export default app;
