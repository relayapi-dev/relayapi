import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { isSelfHosted } from "./lib/deployment-mode";
import { perfLogMiddleware, timed } from "./lib/perf";
import { authMiddleware } from "./middleware/auth";
import { bodyCacheMiddleware } from "./middleware/body-cache";
import { dbContextMiddleware } from "./middleware/db-context";
import {
	apiErrorHandler,
	apiNotFoundHandler,
	errorContractMiddleware,
} from "./middleware/error-contract";
import {
	aiEnabledMiddleware,
	proOnlyMiddleware,
} from "./middleware/feature-gate";
import { idempotencyMiddleware } from "./middleware/idempotency";
import { openApiMutationValidationHook } from "./middleware/mutation-validation";
import {
	readOnlyMiddleware,
	requireManageBillingMiddleware,
	requireManageSpendMiddleware,
	requireViewBillingMiddleware,
	workspaceScopeMiddleware,
} from "./middleware/permissions";
import { rateLimitMiddleware } from "./middleware/rate-limit";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { toolRateLimitMiddleware } from "./middleware/tool-rate-limit";
import { usageTrackingMiddleware } from "./middleware/usage-tracking";
import { workspaceValidationMiddleware } from "./middleware/workspace-validation";
import accounts from "./routes/accounts";
import admin from "./routes/admin";
import adsRouter from "./routes/ads";
import aiAgents from "./routes/ai-agents";
import aiKnowledge from "./routes/ai-knowledge";
import analytics from "./routes/analytics";
import apiKeys from "./routes/api-keys";
import autoPostRulesRouter from "./routes/auto-post-rules";
import automationBindings from "./routes/automation-bindings";
import automationEntrypointsRouter, {
	automationScopedEntrypoints,
} from "./routes/automation-entrypoints";
import automationRunsRouter, {
	automationScopedRuns,
} from "./routes/automation-runs";
import automationWebhookTrigger from "./routes/automation-webhook-trigger";
import automations from "./routes/automations";
import avatars from "./routes/avatars";
import billing from "./routes/billing";
import broadcastsRouter from "./routes/broadcasts";
import byos from "./routes/byos";
import connect from "./routes/connect";
import connections from "./routes/connections";
import contactAutomationControls from "./routes/contact-automation-controls";
import { contactsRouter } from "./routes/contacts";
import contentTemplatesRouter from "./routes/content-templates";
import crossPostActionsRouter from "./routes/cross-post-actions";
import customFields from "./routes/custom-fields";
import emailIntents from "./routes/email-intents";
import gmb from "./routes/gmb";
import health from "./routes/health";
import ideaGroupsRouter from "./routes/idea-groups";
import ideasRouter from "./routes/ideas";
import inbox from "./routes/inbox";
import inboxAi from "./routes/inbox-ai";
import inboxFeed from "./routes/inbox-feed";
import invite from "./routes/invite";
import inviteRedeem from "./routes/invite-redeem";
import landingPagesRouter from "./routes/landing-pages";
import mediaRouter from "./routes/media";
import oauthCallback from "./routes/oauth-callback";
import orgSettings from "./routes/org-settings";
import organizations from "./routes/organizations";
import platformWebhooks from "./routes/platform-webhooks";
import posts from "./routes/posts";
import privacy from "./routes/privacy";
import publicGrowth from "./routes/public-growth";
import qrCodesRouter from "./routes/qr-codes";
import queue from "./routes/queue";
import reddit from "./routes/reddit";
import refUrls from "./routes/ref-urls";
import segments from "./routes/segments";
import shortLinkRedirect from "./routes/short-link-redirect";
import shortLinksRouter from "./routes/short-links";
import signaturesRouter from "./routes/signatures";
import streak from "./routes/streak";
import stripeWebhooks from "./routes/stripe-webhooks";
import subscriptionListsRouter from "./routes/subscription-lists";
import tagsRouter from "./routes/tags";
import threads from "./routes/threads";
import tools from "./routes/tools";
import twitterEngagement from "./routes/twitter-engagement";
import usage from "./routes/usage";
import webhooks from "./routes/webhooks";
import { websocketTicket, websocketUpgrade } from "./routes/websocket";
import whatsapp from "./routes/whatsapp";
import whatsappPhoneProvisioning from "./routes/whatsapp-phone-provisioning";
import workspacesRouter from "./routes/workspaces";
import type { Env, Variables } from "./types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>({
	defaultHook: openApiMutationValidationHook,
});

// Keep the API itself fail-safe if the zone-level redirect is ever disabled.
// Local development and deterministic OpenAPI generation use other hosts and
// remain available over HTTP.
app.use("*", async (c, next) => {
	const url = new URL(c.req.url);
	if (url.protocol === "http:" && url.hostname === "api.relayapi.dev") {
		return Response.redirect(
			`https://api.relayapi.dev${url.pathname}${url.search}`,
			308,
		);
	}
	await next();
});

// Normalize errors from both the root app and mounted route applications.
app.onError(apiErrorHandler);
app.notFound(apiNotFoundHandler);
app.use("*", errorContractMiddleware);

// Perf instrumentation (no-op unless PERF_LOGS=1) — first, so `total` covers
// the entire middleware pipeline + handler
app.use("*", perfLogMiddleware);

// CORS — public API, allow all origins (security is via Bearer token, not origin)
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
		exposeHeaders: [
			"X-Usage-Count",
			"X-Usage-Limit",
			"Idempotency-Replayed",
			"Retry-After",
		],
		maxAge: 86400,
	}),
);

// Security headers
app.use("*", securityHeadersMiddleware);

// Register security scheme
app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
	type: "http",
	scheme: "bearer",
	description:
		"API key (rlay_live_* or rlay_test_*). Invite redemption also accepts a server-derived rlay_session_* bearer for a current user session.",
});

// Health check (no auth)
app.route("/health", health);

// Public reference redirects, QR scans/images, and rendered landing pages.
// Occurrences are durably fenced by their own handlers before redirect/render.
app.route("/", publicGrowth);

// Canonical built-in short links. The /r alias remains for links already issued
// before the dedicated /s surface and public-link hostname were introduced.
app.route("/s", shortLinkRedirect);
app.route("/r", shortLinkRedirect);

// Stripe webhooks (no auth — uses Stripe signature verification)
app.use("/webhooks/stripe/*", async (c, next) => {
	if (isSelfHosted(c.env)) {
		return c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
	}
	await next();
});
app.route("/webhooks/stripe", stripeWebhooks);

// Platform webhooks (no auth — uses HMAC/challenge verification per platform)
app.route("/webhooks/platform", platformWebhooks);

// OAuth callback (no auth — OAuth providers redirect browsers here, state token links to session)
app.route("/connect/oauth", oauthCallback);

// Avatar serving (no auth — public profile images re-hosted to R2, loaded by <img> tags)
app.route("/avatars", avatars);

// WebSocket upgrade — authenticated via short-lived ticket (before auth middleware)
app.route("/v1/ws", websocketUpgrade);

// Automation webhook trigger — public endpoint, HMAC-authenticated via the
// per-entrypoint secret (no API key auth). Mounted before the auth middleware.
app.route("/v1/webhooks/automation-trigger", automationWebhookTrigger);

// Bearer-invite redemption authenticates a current Better Auth session (or a
// member-bound API credential) itself because the redeemer may not belong to
// any organization yet.
app.route("/v1/invite/tokens", inviteRedeem);

// Request-scoped Drizzle instance — authentication and all downstream
// middleware/handlers share it, so live credential checks are included in
// request query instrumentation and never allocate a second client.
app.use("/v1/*", dbContextMiddleware);

// Auth middleware for all remaining /v1 routes. The public surfaces above
// authenticate their own capability or provider signature.
app.use("/v1/*", timed("auth", authMiddleware));

// Rate limiting (runs after auth sets the variables)
app.use("/v1/*", timed("ratelimit", rateLimitMiddleware));

// Permission enforcement — read-only keys and workspace scoping
app.use("/v1/*", timed("readonly", readOnlyMiddleware));

// Cache parsed request body once for all downstream middleware (avoids 2-3x re-parsing).
// MUST run before workspaceScopeMiddleware which reads parsedBody for scope validation.
app.use("/v1/*", timed("bodycache", bodyCacheMiddleware));

// Validate that any referenced workspace_id belongs to the authenticated organization.
app.use("/v1/*", timed("wsval", workspaceValidationMiddleware));

app.use("/v1/*", timed("wsscope", workspaceScopeMiddleware));

// WebSocket ticket — issues short-lived tokens for the public /v1/ws upgrade
app.route("/v1/ws-ticket", websocketTicket);

// Feature gating — pro-only endpoints (must run before usage tracking)
app.use("/v1/analytics/*", proOnlyMiddleware);
app.use("/v1/inbox/*", proOnlyMiddleware);
app.use("/v1/custom-fields/*", proOnlyMiddleware);
app.use("/v1/short-links/*", proOnlyMiddleware);
app.use("/v1/auto-post-rules/*", proOnlyMiddleware);
app.use("/v1/ai-knowledge", proOnlyMiddleware);
app.use("/v1/ai-knowledge/*", proOnlyMiddleware);
app.use("/v1/ai-agents", proOnlyMiddleware);
app.use("/v1/ai-agents/*", proOnlyMiddleware);
app.use("/v1/byos", proOnlyMiddleware);
app.use("/v1/byos/*", proOnlyMiddleware);

// Tool rate limiting — per-org daily quota for downloads + transcripts
app.use("/v1/tools/*/download", toolRateLimitMiddleware);
app.use("/v1/tools/youtube/transcript", toolRateLimitMiddleware);

// AI feature gating — requires explicit org-level enablement
app.use("/v1/inbox/classify", aiEnabledMiddleware);
app.use("/v1/inbox/suggest-reply", aiEnabledMiddleware);
app.use("/v1/inbox/summarize", aiEnabledMiddleware);
app.use("/v1/inbox/priorities", aiEnabledMiddleware);
app.use("/v1/ai-knowledge", aiEnabledMiddleware);
app.use("/v1/ai-knowledge/*", aiEnabledMiddleware);
app.use("/v1/ai-agents", aiEnabledMiddleware);
app.use("/v1/ai-agents/*", aiEnabledMiddleware);

// Financial authority is live request state, especially for dashboard users
// whose organization role can change without changing their API credential.
// Run these gates before idempotency replay so a demoted principal cannot
// receive a previously stored financial response without reauthorization.
for (const path of ["/v1/billing", "/v1/billing/"]) {
	app.use(path, requireViewBillingMiddleware);
}
for (const path of [
	"/v1/billing/checkout",
	"/v1/billing/portal",
	"/v1/billing/sync",
]) {
	app.use(path, requireManageBillingMiddleware);
}
for (const path of ["/v1/ads", "/v1/ads/*"]) {
	app.use(path, async (c, next) => {
		if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
			return requireManageSpendMiddleware(c, next);
		}
		return next();
	});
}
app.use("/v1/whatsapp/phone-numbers/*", async (c, next) => {
	const isPurchase =
		c.req.method === "POST" &&
		/^\/v1\/whatsapp\/phone-numbers\/purchase\/?$/.test(c.req.path);
	const isRelease =
		c.req.method === "DELETE" &&
		/^\/v1\/whatsapp\/phone-numbers\/[^/]+\/?$/.test(c.req.path);
	if (isPurchase || isRelease) {
		return requireManageBillingMiddleware(c, next);
	}
	return next();
});

// Replay only after current global authorization/entitlement checks have run.
// The receipt itself also carries an authorization fingerprint for route-local
// permission checks that execute downstream.
app.use("/v1/*", timed("idempotency", idempotencyMiddleware));

// Usage tracking (runs after auth + rate limit + feature gate)
app.use("/v1/*", timed("usage", usageTrackingMiddleware));

// Mount versioned routes (flat — avoids 3-level nesting that breaks OpenAPI spec generation)
app.route("/v1/posts", posts);
app.route("/v1/admin", admin);
app.route("/v1/privacy", privacy);
app.route("/v1/billing", billing);
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
app.route("/v1/contacts", contactsRouter);
app.route("/v1/custom-fields", customFields);
app.route("/v1/broadcasts", broadcastsRouter);
app.route("/v1/byos", byos);
app.route("/v1/content-templates", contentTemplatesRouter);
app.route("/v1/tags", tagsRouter);
app.route("/v1/idea-groups", ideaGroupsRouter);
app.route("/v1/ideas", ideasRouter);
app.route("/v1/automations", automations);
app.route("/v1/automations", automationScopedEntrypoints);
app.route("/v1/automations", automationScopedRuns);
app.route("/v1/automation-entrypoints", automationEntrypointsRouter);
app.route("/v1/automation-bindings", automationBindings);
app.route("/v1/automation-runs", automationRunsRouter);
app.route("/v1/contacts", contactAutomationControls);
app.route("/v1/segments", segments);
app.route("/v1/subscription-lists", subscriptionListsRouter);
app.route("/v1/ai-agents", aiAgents);
app.route("/v1/ai-knowledge", aiKnowledge);
app.route("/v1/ref-urls", refUrls);
app.route("/v1/qr-codes", qrCodesRouter);
app.route("/v1/landing-pages", landingPagesRouter);
app.route("/v1/short-links", shortLinksRouter);
app.route("/v1/signatures", signaturesRouter);
app.route("/v1/ads", adsRouter);
app.route("/v1/auto-post-rules", autoPostRulesRouter);
app.route("/v1", crossPostActionsRouter);
app.route("/v1/org-settings", orgSettings);
app.route("/v1/organizations", organizations);
app.route("/v1/invite/tokens", invite);
app.route("/v1", emailIntents);

// OpenAPI spec. Build it only when requested, then retain the compact serialized
// form rather than regenerating a large object graph on every request. Keeping
// this lazy avoids adding OpenAPI generation work to unrelated Worker cold starts.
const openApiConfig: Parameters<typeof app.getOpenAPIDocument>[0] = {
	openapi: "3.1.0",
	info: {
		title: "RelayAPI",
		version: "1.0.0",
		description:
			"Unified social media API — post to 21 platforms via a single API",
	},
	servers: [{ url: "https://api.relayapi.dev" }],
};
let openApiJson: string | undefined;
app.get("/openapi.json", (c) => {
	openApiJson ??= JSON.stringify(app.getOpenAPIDocument(openApiConfig));
	return c.body(openApiJson, 200, {
		"Content-Type": "application/json; charset=UTF-8",
		"Cache-Control": "public, max-age=300, s-maxage=3600",
	});
});

// Swagger UI
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

export default app;
