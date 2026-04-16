import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/auth";
import { bodyCacheMiddleware } from "./middleware/body-cache";
import { proOnlyMiddleware, aiEnabledMiddleware, workspaceRequiredMiddleware } from "./middleware/feature-gate";
import { readOnlyMiddleware, workspaceScopeMiddleware } from "./middleware/permissions";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { toolRateLimitMiddleware } from "./middleware/tool-rate-limit";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { usageTrackingMiddleware, incrementUsage } from "./middleware/usage-tracking";
import { workspaceValidationMiddleware } from "./middleware/workspace-validation";
import {
	processEmailMessage,
	handleDeadLetterMessage,
} from "./lib/email-queue/consumer";
import type { EmailQueueMessage } from "./lib/email-queue/types";
import accounts from "./routes/accounts";
import adsRouter from "./routes/ads";
import analytics from "./routes/analytics";
import apiKeys from "./routes/api-keys";
import automation from "./routes/automation";
import broadcastsRouter from "./routes/broadcasts";
import commentAutomations from "./routes/comment-automations";
import { contactsRouter } from "./routes/contacts";
import connect from "./routes/connect";
import contentTemplatesRouter from "./routes/content-templates";
import tagsRouter from "./routes/tags";
import ideaGroupsRouter from "./routes/idea-groups";
import ideasRouter from "./routes/ideas";
import connections from "./routes/connections";
import customFields from "./routes/custom-fields";
import gmb from "./routes/gmb";
import inbox from "./routes/inbox";
import inboxAi from "./routes/inbox-ai";
import inboxFeed from "./routes/inbox-feed";
import invite from "./routes/invite";
import mediaRouter from "./routes/media";
import orgSettings from "./routes/org-settings";
import posts from "./routes/posts";
import queue from "./routes/queue";
import reddit from "./routes/reddit";
import threads from "./routes/threads";
import sequencesRouter from "./routes/sequences";
import shortLinksRouter from "./routes/short-links";
import signaturesRouter from "./routes/signatures";
import streak from "./routes/streak";
import tools from "./routes/tools";
import twitterEngagement from "./routes/twitter-engagement";
import usage from "./routes/usage";
import webhooks from "./routes/webhooks";
import whatsapp from "./routes/whatsapp";
import whatsappPhoneProvisioning from "./routes/whatsapp-phone-provisioning";
import autoPostRulesRouter from "./routes/auto-post-rules";
import crossPostActionsRouter from "./routes/cross-post-actions";
import engagementRulesRouter from "./routes/engagement-rules";
import workspacesRouter from "./routes/workspaces";
import oauthCallback from "./routes/oauth-callback";
import platformWebhooks from "./routes/platform-webhooks";
import type { InboxQueueMessage } from "./routes/platform-webhooks";
import stripeWebhooks from "./routes/stripe-webhooks";
import { generateInvoices } from "./services/invoice-generator";
import { processDunning } from "./services/dunning";
import { publishPostById } from "./services/publisher-runner";
import { processRecyclingPosts } from "./services/recycling-processor";
import { processScheduledPosts } from "./services/scheduler";
import { processScheduledBroadcasts } from "./services/broadcast-processor";
import { processSequenceSteps } from "./services/sequence-processor";
import { processInboxEvent } from "./services/inbox-event-processor";
import { enqueueExpiringTokenRefresh, refreshAccountToken } from "./services/token-refresh";
import { cleanupOldConversations } from "./services/inbox-maintenance";
import { checkStreaks } from "./services/streak";
import { callDownloaderService } from "./services/tool-service";
import { completeToolJob, failToolJob } from "./services/tool-jobs";
import { renewYouTubePubSubSubscriptions } from "./services/webhook-subscription";
import { processAutoPostRules } from "./services/auto-post-processor";
import { syncShortLinkClicks } from "./services/short-link-click-sync";
import { processEngagementCheck, type EngagementCheckMessage } from "./services/engagement-rule-processor";
import { processCrossPostActions } from "./services/cross-post-processor";
import { processWeeklyDigest } from "./services/weekly-digest";
import { syncAllExternalAds, syncExternalAds } from "./services/ad-sync";
import { fetchAndStoreAdMetrics } from "./services/ad-analytics";
import { addUsersToAudience } from "./services/ad-audience";
import { createAd, boostPost } from "./services/ad-service";
import { AdPlatformError } from "./services/ad-platforms/types";
import { syncExternalPosts, refreshExternalPostMetrics } from "./services/external-post-sync/sync";
import { enqueueExternalPostSync } from "./services/external-post-sync/cron";
import { RateLimitError } from "./services/external-post-sync/types";
import type { SyncQueueMessage } from "./services/external-post-sync/types";
import {
	enqueueAnalyticsRefresh,
	refreshInternalPostMetrics,
	refreshExternalPostMetricsBatch,
	scheduleFirstMetricsRefresh,
} from "./services/analytics-refresh";
import type { AnalyticsQueueMessage } from "./services/analytics-refresh";
import { createDb, media } from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Env, Variables } from "./types";
import { assertAllWorkspaceScope } from "./lib/request-access";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

function isSafePublicRedirectTarget(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

// Global error handler — prevent stack traces from leaking to clients
app.onError((err, c) => {
	console.error("Unhandled error:", err);
	return c.json(
		{ error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } },
		500,
	);
});

// CORS — public API, allow all origins (security is via Bearer token, not origin)
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Authorization", "Content-Type"],
		exposeHeaders: ["X-Usage-Count", "X-Usage-Limit"],
		maxAge: 86400,
	}),
);

// Security headers
app.use("*", securityHeadersMiddleware);

// Register security scheme
app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
	type: "http",
	scheme: "bearer",
	description: "API key (rlay_live_* or rlay_test_*)",
});

// Health check (no auth)
app.get("/health", (c) => c.json({ status: "ok" }));


// Short link redirect (no auth — public redirect endpoint for built-in shortener)
app.get("/r/:code", async (c) => {
	const code = c.req.param("code");
	const originalUrl = await c.env.KV.get(`sl:${code}`);
	if (!originalUrl) {
		return c.json({ error: { code: "NOT_FOUND", message: "Short link not found" } }, 404);
	}

	if (!isSafePublicRedirectTarget(originalUrl)) {
		console.error(`[ShortLinks] Blocked unsafe redirect target for code ${code}`);
		return c.json(
			{ error: { code: "INVALID_REDIRECT_TARGET", message: "Short link target is invalid" } },
			400,
		);
	}

	// Increment click count atomically in KV
	c.executionCtx.waitUntil(
		(async () => {
			const key = `sl:${code}:clicks`;
			const current = await c.env.KV.get(key);
			const count = current ? parseInt(current, 10) : 0;
			await c.env.KV.put(key, String(count + 1));
		})(),
	);

	return c.redirect(originalUrl, 302);
});

// Stripe webhooks (no auth — uses Stripe signature verification)
app.route("/webhooks/stripe", stripeWebhooks);

// Platform webhooks (no auth — uses HMAC/challenge verification per platform)
app.route("/webhooks/platform", platformWebhooks);

// OAuth callback (no auth — OAuth providers redirect browsers here, state token links to session)
app.route("/connect/oauth", oauthCallback);

// WebSocket upgrade — authenticated via short-lived ticket (before auth middleware)
app.get("/v1/ws", async (c) => {
	const upgradeHeader = c.req.header("Upgrade");
	if (!upgradeHeader || upgradeHeader !== "websocket") {
		return c.json({ error: { code: "BAD_REQUEST", message: "Expected WebSocket upgrade" } }, 426);
	}

	if (c.req.query("token")) {
		return c.json(
			{
				error: {
					code: "TOKEN_QUERY_UNSUPPORTED",
					message: "Raw API keys are not accepted on WebSocket URLs. Request a ws ticket first.",
				},
			},
			400,
		);
	}

	const ticket = c.req.query("ticket");
	if (!ticket) {
		return c.json({ error: { code: "UNAUTHORIZED", message: "Missing ticket" } }, 401);
	}

	const data = await c.env.KV.get<{ org_id: string }>(`ws-ticket:${ticket}`, "json");
	if (!data) {
		return c.json({ error: { code: "UNAUTHORIZED", message: "Invalid or expired ticket" } }, 401);
	}

	await c.env.KV.delete(`ws-ticket:${ticket}`);

	// Forward WebSocket upgrade to the org's Durable Object
	const doId = c.env.REALTIME.idFromName(data.org_id);
	const stub = c.env.REALTIME.get(doId);
	return stub.fetch(c.req.raw);
});

// Auth middleware for all /v1 routes (except /v1/ws which handles its own auth above)
app.use("/v1/*", authMiddleware);

// Rate limiting (runs after auth sets the variables)
app.use("/v1/*", rateLimitMiddleware);

// Permission enforcement — read-only keys and workspace scoping
app.use("/v1/*", readOnlyMiddleware);

// Cache parsed request body once for all downstream middleware (avoids 2-3x re-parsing).
// MUST run before workspaceScopeMiddleware which reads parsedBody for scope validation.
app.use("/v1/*", bodyCacheMiddleware);

// Validate that any referenced workspace_id belongs to the authenticated organization.
app.use("/v1/*", workspaceValidationMiddleware);

app.use("/v1/*", workspaceScopeMiddleware);

app.get("/v1/ws-ticket", async (c) => {
	const denied = assertAllWorkspaceScope(
		c,
		"Realtime streaming requires an API key with access to all workspaces.",
	);
	if (denied) return denied;

	const ticket = crypto.randomUUID().replace(/-/g, "");
	const expiresAt = new Date(Date.now() + 60_000).toISOString();

	await c.env.KV.put(
		`ws-ticket:${ticket}`,
		JSON.stringify({ org_id: c.get("orgId"), expires_at: expiresAt }),
		{ expirationTtl: 60 },
	);

	return c.json(
		{
			ticket,
			expires_at: expiresAt,
			ws_url: `/v1/ws?ticket=${ticket}`,
		},
		200,
	);
});

// Feature gating — pro-only endpoints (must run before usage tracking)
app.use("/v1/analytics/*", proOnlyMiddleware);
app.use("/v1/inbox/*", proOnlyMiddleware);
app.use("/v1/comment-automations/*", proOnlyMiddleware);
app.use("/v1/sequences/*", proOnlyMiddleware);
app.use("/v1/custom-fields/*", proOnlyMiddleware);
app.use("/v1/ads/*", proOnlyMiddleware);
app.use("/v1/short-links/*", proOnlyMiddleware);
app.use("/v1/auto-post-rules/*", proOnlyMiddleware);
app.use("/v1/engagement-rules/*", proOnlyMiddleware);

// Workspace enforcement — when enabled, rejects create requests without workspace_id
app.use("/v1/posts/*", workspaceRequiredMiddleware);
app.use("/v1/webhooks/*", workspaceRequiredMiddleware);
app.use("/v1/inbox/rules/*", workspaceRequiredMiddleware);
app.use("/v1/comment-automations/*", workspaceRequiredMiddleware);
app.use("/v1/sequences/*", workspaceRequiredMiddleware);
app.use("/v1/broadcasts/*", workspaceRequiredMiddleware);
app.use("/v1/custom-fields/*", workspaceRequiredMiddleware);
app.use("/v1/ads/*", workspaceRequiredMiddleware);
app.use("/v1/auto-post-rules/*", workspaceRequiredMiddleware);
app.use("/v1/content-templates/*", workspaceRequiredMiddleware);
app.use("/v1/threads/*", workspaceRequiredMiddleware);

// Tool rate limiting — per-org daily quota for downloads + transcripts
app.use("/v1/tools/*/download", toolRateLimitMiddleware);
app.use("/v1/tools/youtube/transcript", toolRateLimitMiddleware);

// AI feature gating — requires explicit org-level enablement
app.use("/v1/inbox/classify", aiEnabledMiddleware);
app.use("/v1/inbox/suggest-reply", aiEnabledMiddleware);
app.use("/v1/inbox/summarize", aiEnabledMiddleware);
app.use("/v1/inbox/priorities", aiEnabledMiddleware);

// Usage tracking (runs after auth + rate limit + feature gate)
app.use("/v1/*", usageTrackingMiddleware);

// Mount versioned routes (flat — avoids 3-level nesting that breaks OpenAPI spec generation)
app.route("/v1/posts", posts);
app.route("/v1/accounts", accounts);
app.route("/v1/accounts", gmb);
app.route("/v1/media", mediaRouter);
app.route("/v1/webhooks", webhooks);
app.route("/v1/api-keys", apiKeys);
app.route("/v1/usage", usage);
app.route("/v1/streak", streak);
app.route("/v1/workspaces", workspacesRouter);
app.route("/v1/connect", connect);
app.route("/v1/connections", connections);
app.route("/v1/analytics", analytics);
app.route("/v1/tools", tools);
app.route("/v1/queue", queue);
app.route("/v1/threads", threads);
app.route("/v1/twitter", twitterEngagement);
app.route("/v1/inbox", inbox);
app.route("/v1/inbox", inboxAi);
app.route("/v1/inbox", inboxFeed);
app.route("/v1/reddit", reddit);
app.route("/v1/whatsapp", whatsapp);
app.route("/v1/whatsapp/phone-numbers", whatsappPhoneProvisioning);
app.route("/v1/inbox/rules", automation);
app.route("/v1/contacts", contactsRouter);
app.route("/v1/custom-fields", customFields);
app.route("/v1/broadcasts", broadcastsRouter);
app.route("/v1/comment-automations", commentAutomations);
app.route("/v1/content-templates", contentTemplatesRouter);
app.route("/v1/tags", tagsRouter);
app.route("/v1/idea-groups", ideaGroupsRouter);
app.route("/v1/ideas", ideasRouter);
app.route("/v1/sequences", sequencesRouter);
app.route("/v1/short-links", shortLinksRouter);
app.route("/v1/signatures", signaturesRouter);
app.route("/v1/ads", adsRouter);
app.route("/v1/auto-post-rules", autoPostRulesRouter);
app.route("/v1/engagement-rules", engagementRulesRouter);
app.route("/v1", crossPostActionsRouter);
app.route("/v1/org-settings", orgSettings);
app.route("/v1/invite/tokens", invite);

// OpenAPI spec
app.doc("/openapi.json", {
	openapi: "3.1.0",
	info: {
		title: "RelayAPI",
		version: "1.0.0",
		description:
			"Unified social media API — post to 17 platforms via a single API",
	},
	servers: [{ url: "https://api.relayapi.dev" }],
});

// Swagger UI
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

// Queue consumer + scheduled trigger
export default {
	fetch: app.fetch,

	async queue(batch: MessageBatch, env: Env) {
		const MAX_RETRIES = 5;

		// Email queue
		if (batch.queue === "relayapi-email") {
			for (const message of batch.messages) {
				const body = message.body as EmailQueueMessage;

				if (message.attempts > MAX_RETRIES) {
					handleDeadLetterMessage(body);
					message.ack();
					continue;
				}

				const result = await processEmailMessage(
					body,
					env.RESEND_API_KEY,
				);

				if (result.success) {
					message.ack();
				} else if (result.shouldRetry) {
					const delaySeconds = 2 ** message.attempts;
					console.log(
						`[Queue] Retrying email in ${delaySeconds}s (attempt ${message.attempts})`,
					);
					message.retry({ delaySeconds });
				} else {
					console.error(
						`[Queue] Non-retryable email error, discarding: ${result.error}`,
					);
					message.ack();
				}
			}
			return;
		}

		// Media cleanup queue (R2 event notifications)
		if (batch.queue === "relayapi-media-cleanup") {
			const db = createDb(env.HYPERDRIVE.connectionString);
			for (const message of batch.messages) {
				const body = message.body as {
					account: string;
					bucket: string;
					object: { key: string };
					action: string;
				};
				try {
					await db
						.delete(media)
						.where(eq(media.storageKey, body.object.key));
					console.log(`[Media Cleanup] Deleted DB record for ${body.object.key}`);
					message.ack();
				} catch (err) {
					console.error(`[Media Cleanup] Failed for ${body.object.key}:`, err);
					message.retry({ delaySeconds: 30 });
				}
			}
			return;
		}

		// Token refresh queue
		if (batch.queue === "relayapi-refresh") {
			for (const message of batch.messages) {
				const body = message.body as { type: string; account_id: string };
				if (body.type === "refresh_token") {
					try {
						await refreshAccountToken(env, body.account_id);
						message.ack();
					} catch (err) {
						console.error(`[Token Refresh] Failed for ${body.account_id}:`, err);
						if (message.attempts >= 5) {
							console.error(`[Token Refresh] Max retries exceeded for ${body.account_id}, dropping`);
							message.ack();
						} else {
							message.retry({ delaySeconds: 60 });
						}
					}
				} else {
					message.ack();
				}
			}
			return;
		}

		// Inbox queue (inbound platform webhooks)
		if (batch.queue === "relayapi-inbox") {
			const { createDb } = await import("@relayapi/db");
			const db = createDb(env.HYPERDRIVE.connectionString);
			for (const message of batch.messages) {
				const body = message.body as InboxQueueMessage;
				if (message.attempts >= MAX_RETRIES) {
					console.error(
						"[Inbox] Max retries exceeded, discarding:",
						JSON.stringify(body).slice(0, 200),
					);
					message.ack();
					continue;
				}
				try {
					await processInboxEvent(body, env, db);
					message.ack();
				} catch (err) {
					console.error("[Inbox] Processing failed:", err);
					const delaySeconds = 2 ** message.attempts;
					message.retry({ delaySeconds });
				}
			}
			return;
		}

		// Tools queue (downloads + transcripts)
		if (batch.queue === "relayapi-tools") {
			for (const message of batch.messages) {
				const body = message.body as {
					type: string;
					job_id: string;
					org_id: string;
					endpoint: string;
					payload: Record<string, unknown>;
				};

				try {
					// Queue consumers get 15 minutes — use 60s timeout for the VPS call
					const result = await callDownloaderService(
						env,
						body.endpoint,
						body.payload,
						60_000,
					);

					if (result.ok) {
						await completeToolJob(env.KV, body.job_id, result.data);
					} else {
						await failToolJob(env.KV, body.job_id, result.error);
					}
					message.ack();
				} catch (err) {
					if (message.attempts >= 3) {
						await failToolJob(
							env.KV,
							body.job_id,
							`Failed after ${message.attempts} attempts: ${err}`,
						);
						message.ack();
					} else {
						const delaySeconds = 2 ** message.attempts;
						console.log(
							`[Tools] Retrying ${body.job_id} in ${delaySeconds}s (attempt ${message.attempts})`,
						);
						message.retry({ delaySeconds });
					}
				}
			}
			return;
		}

		// Ads queue (ad creation, metrics sync, external sync, audience uploads)
		if (batch.queue === "relayapi-ads") {
			for (const message of batch.messages) {
				const body = message.body as {
					type: string;
					org_id: string;
					ad_account_id?: string;
					ad_id?: string;
					audience_id?: string;
					params?: any;
				};

				try {
					switch (body.type) {
						case "create_ad": {
							await createAd(env, body.org_id, body.params);
							break;
						}
						case "boost_post": {
							await boostPost(env, body.org_id, body.params);
							break;
						}
						case "sync_metrics": {
							if (body.ad_id) {
								const now = new Date();
								const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
								await fetchAndStoreAdMetrics(
									env,
									body.ad_id,
									thirtyDaysAgo.toISOString().split("T")[0]!,
									now.toISOString().split("T")[0]!,
								);
							}
							break;
						}
						case "sync_external": {
							if (body.ad_account_id) {
								await syncExternalAds(env, body.ad_account_id, body.org_id);
							}
							break;
						}
						case "upload_audience_users": {
							if (body.audience_id && body.params?.users) {
								await addUsersToAudience(
									env,
									body.org_id,
									body.audience_id,
									body.params.users,
								);
							}
							break;
						}
						default:
							console.warn(`[Ads] Unknown message type: ${body.type}`);
					}
					message.ack();
				} catch (err) {
					console.error(`[Ads] Queue processing failed for ${body.type}:`, err);
					if (
						err instanceof AdPlatformError &&
						err.code === "INVALID_STATE"
					) {
						console.warn(
							`[Ads] ${body.type} requires reconnect; dropping without retry`,
						);
						message.ack();
					} else if (message.attempts < 3) {
						const delaySeconds = 2 ** message.attempts;
						message.retry({ delaySeconds });
					} else {
						console.error(`[Ads] Max retries exceeded for ${body.type}, dropping`);
						message.ack();
					}
				}
			}
			return;
		}

		// External post sync queue
		if (batch.queue === "relayapi-sync") {
			for (const message of batch.messages) {
				const body = message.body as SyncQueueMessage | AnalyticsQueueMessage;

				try {
					switch (body.type) {
						case "sync_posts":
							await syncExternalPosts(env, body);
							break;
						case "refresh_metrics":
							await refreshExternalPostMetrics(env, body);
							break;
						case "refresh_internal_metrics":
							await refreshInternalPostMetrics(env, body);
							break;
						case "refresh_external_metrics_batch":
							await refreshExternalPostMetricsBatch(env, body);
							break;
						default:
							console.warn(`[Sync] Unknown message type: ${(body as any).type}`);
					}
					message.ack();
				} catch (err) {
					console.error(`[Sync] Error processing ${body.type} (attempt ${message.attempts}):`, err instanceof Error ? err.message : err);
					if (err instanceof Error && err.stack) {
						console.error(`[Sync] Stack:`, err.stack);
					}
					console.error(`[Sync] Message body:`, JSON.stringify(body));

					if (err instanceof RateLimitError) {
						const delaySec = Math.max(
							Math.ceil((err.resetAt.getTime() - Date.now()) / 1000),
							30,
						);
						message.retry({ delaySeconds: Math.min(delaySec, 900) });
					} else if (message.attempts < 3) {
						const delaySeconds = 2 ** message.attempts;
						message.retry({ delaySeconds });
					} else {
						console.error(`[Sync] Max retries exceeded for ${body.type}, dropping`);
						message.ack();
					}
				}
			}
			return;
		}

		// Publish queue (default)
		for (const message of batch.messages) {
			const body = message.body as {
				type: string;
				post_id?: string;
				org_id?: string;
				usage_tracked?: boolean;
				rule_id?: string;
				post_target_id?: string;
				check_number?: number;
				organization_id?: string;
			};

			if ((body.type === "publish_thread" || body.type === "publish_thread_item") && body.org_id) {
				try {
					const { publishThreadPosition } = await import("./services/thread-publisher");
					const threadGroupId = (body as any).thread_group_id as string;
					const position = (body as any).position as number ?? 0;

					const result = await publishThreadPosition(env, threadGroupId, body.org_id, position);

					// Stop chain if current position fully failed
					if (result.positionFailed) {
						console.error(`[Thread] Position ${position} fully failed for ${threadGroupId}, stopping chain`);
						message.ack();
						continue;
					}

					if (result.nextPosition !== null && result.nextDelayMs > 0) {
						// Enqueue next position with delay
						await env.PUBLISH_QUEUE.send(
							{
								type: "publish_thread_item",
								thread_group_id: threadGroupId,
								org_id: body.org_id,
								position: result.nextPosition,
							},
							{ delaySeconds: Math.ceil(result.nextDelayMs / 1000) },
						);
					} else if (result.nextPosition !== null) {
						// Next position has no delay, but was not published (shouldn't happen)
						await env.PUBLISH_QUEUE.send({
							type: "publish_thread_item",
							thread_group_id: threadGroupId,
							org_id: body.org_id,
							position: result.nextPosition,
						});
					}

					message.ack();
				} catch (err) {
					console.error(`Thread publish failed for ${(body as any).thread_group_id}:`, err);
					if (message.attempts >= 5) {
						console.error(`[Thread] Max retries exceeded for ${(body as any).thread_group_id}, dropping`);
						message.ack();
					} else {
						message.retry({ delaySeconds: 2 ** message.attempts });
					}
				}
			} else if (body.type === "publish" && body.post_id && body.org_id) {
				try {
					if (!body.usage_tracked) {
						await incrementUsage(env.KV, body.org_id, 1);
					}
					await publishPostById(env, body.post_id, body.org_id);

					// Schedule first metrics collection 15 minutes after publish
					scheduleFirstMetricsRefresh(env, body.post_id, body.org_id).catch(
						(err) => console.error("[Analytics] Failed to schedule first refresh:", err),
					);

					message.ack();
				} catch (err) {
					console.error(
						`Queue publish failed for ${body.post_id}:`,
						err,
					);
					if (message.attempts >= 5) {
						console.error(`[Publish] Max retries exceeded for ${body.post_id}, dropping`);
						message.ack();
					} else {
						message.retry({ delaySeconds: 2 ** message.attempts });
					}
				}
			} else if (body.type === "engagement_check" && body.rule_id && body.post_target_id && body.organization_id) {
				try {
					await processEngagementCheck(env, body as EngagementCheckMessage);
					message.ack();
				} catch (err) {
					console.error(`Engagement check failed for rule ${body.rule_id}:`, err);
					if (message.attempts >= 5) {
						console.error(`[Engagement] Max retries exceeded for rule ${body.rule_id}, dropping`);
						message.ack();
					} else {
						message.retry({ delaySeconds: 2 ** message.attempts });
					}
				}
			} else {
				message.ack();
			}
		}
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		// Every minute: process scheduled posts + sequence steps + cross-post actions
		ctx.waitUntil(processScheduledPosts(env));
		ctx.waitUntil(processRecyclingPosts(env));
		ctx.waitUntil(processSequenceSteps(env));
		ctx.waitUntil(processScheduledBroadcasts(env));
		ctx.waitUntil(processCrossPostActions(env));

		// 1st of month at midnight: report metered usage to Stripe + downgrade expired subs
		if (event.cron === "0 0 1 * *") {
			ctx.waitUntil(generateInvoices(env));
		}

		// Daily at 9am UTC: process dunning + token refresh + YouTube PubSub renewal + inbox cleanup
		if (event.cron === "0 9 * * *") {
			ctx.waitUntil(processDunning(env));
			ctx.waitUntil(enqueueExpiringTokenRefresh(env));
			ctx.waitUntil(renewYouTubePubSubSubscriptions(env));
			ctx.waitUntil(cleanupOldConversations(env));
		}

		// Weekly on Monday at 9am UTC: send weekly digest
		if (event.cron === "0 9 * * 1") {
			ctx.waitUntil(processWeeklyDigest(env));
		}

		// Every 5 minutes: sync external posts + refresh analytics + process RSS auto-post rules + streak checks + short link clicks
		if (event.cron === "*/5 * * * *") {
			ctx.waitUntil(enqueueExternalPostSync(env));
			ctx.waitUntil(enqueueAnalyticsRefresh(env));
			ctx.waitUntil(processAutoPostRules(env));
			ctx.waitUntil(checkStreaks(env));
			ctx.waitUntil(syncShortLinkClicks(env));
		}

		// Every 30 minutes: sync external ads and refresh ad metrics
		if (event.cron === "*/30 * * * *") {
			ctx.waitUntil(syncAllExternalAds(env));
		}
	},
};

// Durable Object class export — required by Cloudflare for DO bindings
export { RealtimeDO } from "./durable-objects/post-updates";
