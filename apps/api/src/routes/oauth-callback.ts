import { createDb } from "@relayapi/db";
import { Hono } from "hono";
import { parseApiKeyWorkspaceScope } from "../lib/api-key-workspace-scope";
import { isAllowedCustomerRedirectUrl } from "../lib/customer-redirect";
import { appPublicOrigin } from "../lib/deployment-mode";
import { validatePersistedOperationalScope } from "../lib/request-access";
import { claimOneTimeCapability } from "../services/one-time-capability";
import type { Env } from "../types";
import { exchangeAndSaveAccount } from "./connect";

const app = new Hono<{ Bindings: Env }>();

interface OAuthState {
	org_id: string;
	initiator_key_id: string;
	initial_workspace_scope: "all" | string[];
	workspace_id: string | null;
	workspace_id_was_explicit?: boolean;
	settings_revision: number;
	platform: string;
	connection_operation_id: string;
	method?: string | null;
	redirect_url: string;
	code_verifier: string | null;
	headless?: boolean;
}

/**
 * Server-side OAuth callback handler.
 *
 * OAuth providers redirect users here after authorization.
 * This route exchanges the code for tokens, saves the account,
 * then 302-redirects the user to the customer's original redirect_url.
 *
 * No auth middleware — the state token links back to the authenticated session.
 */
app.get("/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");
	const errorDescription = c.req.query("error_description");

	// Look up the stored state to find the customer's redirect URL
	if (!state) {
		return c.text("Missing state parameter", 400);
	}

	const db = createDb(c.env.HYPERDRIVE.connectionString);
	const stateData = await claimOneTimeCapability<OAuthState>(
		db,
		c.env.ENCRYPTION_KEY,
		"oauth_state",
		state,
	);

	if (!stateData) {
		return c.text("Invalid or expired state token", 400);
	}

	const {
		org_id,
		initiator_key_id,
		initial_workspace_scope,
		workspace_id,
		workspace_id_was_explicit,
		platform,
		connection_operation_id,
		method,
		redirect_url,
		code_verifier,
		headless,
	} = stateData;
	if (
		!isAllowedCustomerRedirectUrl(
			redirect_url,
			new URL(appPublicOrigin(c.env)).hostname,
		)
	) {
		return c.text("Invalid redirect target", 400);
	}
	const redirectUrl = new URL(redirect_url);

	// In headless mode there is no customer redirect to forward query params to:
	// the OAuth result is stored under `pending-oauth:{state}` for the caller to
	// poll via GET /connect/pending-data, and the user's browser lands on a
	// minimal confirmation page here.
	const storeHeadlessResult = async (
		payload: Record<string, unknown>,
	): Promise<Response> => {
		await c.env.KV.put(
			`pending-oauth:${state}`,
			JSON.stringify({
				organization_id: org_id,
				initiator_key_id,
				initial_workspace_scope,
				workspace_id,
				platform,
				...payload,
			}),
			{
				expirationTtl: 600,
			},
		);
		return c.html(
			"<!doctype html><html><body><p>You can return to your application now.</p></body></html>",
		);
	};

	// Handle OAuth errors from the provider
	if (error) {
		if (headless) {
			return storeHeadlessResult({
				status: "error",
				error,
				error_description: errorDescription ?? null,
			});
		}
		redirectUrl.searchParams.set("status", "error");
		redirectUrl.searchParams.set("error", error);
		if (errorDescription) {
			redirectUrl.searchParams.set("error_description", errorDescription);
		}
		redirectUrl.searchParams.set("platform", platform);
		return c.redirect(redirectUrl.toString(), 302);
	}

	if (!code) {
		if (headless) {
			return storeHeadlessResult({
				status: "error",
				error: "missing_code",
				error_description: "No authorization code received",
			});
		}
		redirectUrl.searchParams.set("status", "error");
		redirectUrl.searchParams.set("error", "missing_code");
		redirectUrl.searchParams.set(
			"error_description",
			"No authorization code received",
		);
		redirectUrl.searchParams.set("platform", platform);
		return c.redirect(redirectUrl.toString(), 302);
	}

	// Build the redirect_uri that was sent to the OAuth provider (must match for token exchange)
	const apiBaseUrl = c.env.API_BASE_URL || "https://api.relayapi.dev";
	const oauthRedirectUri = `${apiBaseUrl}/connect/oauth/callback`;
	const initialWorkspaceScope = parseApiKeyWorkspaceScope({
		workspace_scope: initial_workspace_scope,
	});
	const validation = initiator_key_id
		? await validatePersistedOperationalScope(db, {
				apiKeyId: initiator_key_id,
				organizationId: org_id,
				workspaceId: workspace_id,
				resourceName: "connected account",
			})
		: null;
	if (initialWorkspaceScope === null || !validation?.ok) {
		const code =
			validation && !validation.ok
				? validation.code
				: "CONNECTION_INITIATOR_INVALID";
		const message =
			validation && !validation.ok
				? validation.message
				: "The OAuth connection authorization is invalid.";
		if (headless) {
			return storeHeadlessResult({
				status: "error",
				error_code: code,
				error_message: message,
			});
		}
		redirectUrl.searchParams.set("status", "error");
		redirectUrl.searchParams.set("error_code", code);
		redirectUrl.searchParams.set("error_message", message);
		redirectUrl.searchParams.set("platform", platform);
		return c.redirect(redirectUrl.toString(), 302);
	}

	try {
		const result = await exchangeAndSaveAccount({
			env: c.env,
			orgId: org_id,
			initiatorKeyId: initiator_key_id,
			authorizedWorkspaceScope: initialWorkspaceScope,
			workspaceId: workspace_id,
			workspaceWasExplicit: workspace_id_was_explicit ?? workspace_id !== null,
			platform,
			code,
			redirectUri: oauthRedirectUri,
			codeVerifier: code_verifier ?? undefined,
			method: method ?? undefined,
			connectionOperationId: connection_operation_id,
			waitUntil: (p) => c.executionCtx.waitUntil(p),
		});
		if (headless) {
			if (result.status === "success") {
				return storeHeadlessResult({
					status: "success",
					account: result.account,
				});
			}
			if (result.status === "pending_selection") {
				return storeHeadlessResult({
					status: "pending_selection",
					connect_token: result.connectToken,
				});
			}
			return storeHeadlessResult({
				status: "error",
				error_code: result.code,
				error_message: result.message,
			});
		}

		redirectUrl.searchParams.set("platform", platform);
		if (workspace_id)
			redirectUrl.searchParams.set("workspace_id", workspace_id);

		if (result.status === "success") {
			redirectUrl.searchParams.set("status", "success");
			redirectUrl.searchParams.set("account_id", result.account.id);
		} else if (result.status === "pending_selection") {
			redirectUrl.searchParams.set("status", "pending_selection");
			redirectUrl.searchParams.set("connect_token", result.connectToken);
		} else {
			redirectUrl.searchParams.set("status", "error");
			redirectUrl.searchParams.set("error_code", result.code);
			redirectUrl.searchParams.set("error_message", result.message);
		}

		return c.redirect(redirectUrl.toString(), 302);
	} catch (err) {
		if (headless) {
			return storeHeadlessResult({
				status: "error",
				error_code: "TOKEN_EXCHANGE_FAILED",
				error_message:
					err instanceof Error ? err.message : "OAuth token exchange failed",
			});
		}
		redirectUrl.searchParams.set("status", "error");
		redirectUrl.searchParams.set("error_code", "TOKEN_EXCHANGE_FAILED");
		redirectUrl.searchParams.set(
			"error_message",
			err instanceof Error ? err.message : "OAuth token exchange failed",
		);
		redirectUrl.searchParams.set("platform", platform);
		return c.redirect(redirectUrl.toString(), 302);
	}
});

export default app;
