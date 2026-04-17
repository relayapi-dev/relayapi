import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { authMiddleware } from "./middleware/auth";
import { bodyCacheMiddleware } from "./middleware/body-cache";
import { dbContextMiddleware } from "./middleware/db-context";
import { proOnlyMiddleware, aiEnabledMiddleware, workspaceRequiredMiddleware } from "./middleware/feature-gate";
import { readOnlyMiddleware, workspaceScopeMiddleware } from "./middleware/permissions";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { toolRateLimitMiddleware } from "./middleware/tool-rate-limit";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { usageTrackingMiddleware } from "./middleware/usage-tracking";
import { workspaceValidationMiddleware } from "./middleware/workspace-validation";
import accounts from "./routes/accounts";
import adsRouter from "./routes/ads";
import analytics from "./routes/analytics";
import apiKeys from "./routes/api-keys";
import automation from "./routes/automation";
import automations from "./routes/automations";
import automationTemplates from "./routes/automation-templates";
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
import health from "./routes/health";
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
import shortLinkRedirect from "./routes/short-link-redirect";
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
import { websocketUpgrade, websocketTicket } from "./routes/websocket";
import platformWebhooks from "./routes/platform-webhooks";
import stripeWebhooks from "./routes/stripe-webhooks";
import { handleQueueBatch } from "./queues";
import { handleScheduled } from "./scheduled";
import type { Env, Variables } from "./types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

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
app.route("/health", health);

// Short link redirect (no auth — public redirect endpoint for built-in shortener)
app.route("/r", shortLinkRedirect);

// Stripe webhooks (no auth — uses Stripe signature verification)
app.route("/webhooks/stripe", stripeWebhooks);

// Platform webhooks (no auth — uses HMAC/challenge verification per platform)
app.route("/webhooks/platform", platformWebhooks);

// OAuth callback (no auth — OAuth providers redirect browsers here, state token links to session)
app.route("/connect/oauth", oauthCallback);

// WebSocket upgrade — authenticated via short-lived ticket (before auth middleware)
app.route("/v1/ws", websocketUpgrade);

// Auth middleware for all /v1 routes (except /v1/ws which handles its own auth above)
app.use("/v1/*", authMiddleware);

// Request-scoped Drizzle instance — all downstream middleware and route handlers
// read the shared instance via c.get("db") instead of calling createDb() themselves.
app.use("/v1/*", dbContextMiddleware);

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

// WebSocket ticket — issues short-lived tokens for the public /v1/ws upgrade
app.route("/v1/ws-ticket", websocketTicket);

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
app.route("/v1/automations", automations);
app.route("/v1/automations/templates", automationTemplates);
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
			"Unified social media API — post to 21 platforms via a single API",
	},
	servers: [{ url: "https://api.relayapi.dev" }],
});

// Swagger UI
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

// Queue consumer + scheduled trigger
export default {
	fetch: app.fetch,

	async queue(batch: MessageBatch, env: Env) {
		return handleQueueBatch(batch, env);
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		return handleScheduled(event, env, ctx);
	},
};

// Durable Object class export — required by Cloudflare for DO bindings
export { RealtimeDO } from "./durable-objects/post-updates";
