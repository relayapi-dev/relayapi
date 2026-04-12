import { Hono } from "hono";
import { exchangeAndSaveAccount } from "./connect";
import type { Env } from "../types";
import { isAllowedCustomerRedirectUrl } from "../lib/customer-redirect";

const app = new Hono<{ Bindings: Env }>();

interface OAuthState {
	org_id: string;
	platform: string;
	method?: string | null;
	redirect_url: string;
	code_verifier: string | null;
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

	const stateData = await c.env.KV.get<OAuthState>(
		`oauth-state:${state}`,
		"json",
	);

	if (!stateData) {
		return c.text("Invalid or expired state token", 400);
	}

	// Delete state immediately (one-time use)
	await c.env.KV.delete(`oauth-state:${state}`);

	const { org_id, platform, method, redirect_url, code_verifier } = stateData;
	if (!isAllowedCustomerRedirectUrl(redirect_url)) {
		return c.text("Invalid redirect target", 400);
	}
	const redirectUrl = new URL(redirect_url);

	// Handle OAuth errors from the provider
	if (error) {
		redirectUrl.searchParams.set("status", "error");
		redirectUrl.searchParams.set("error", error);
		if (errorDescription) {
			redirectUrl.searchParams.set("error_description", errorDescription);
		}
		redirectUrl.searchParams.set("platform", platform);
		return c.redirect(redirectUrl.toString(), 302);
	}

	if (!code) {
		redirectUrl.searchParams.set("status", "error");
		redirectUrl.searchParams.set("error", "missing_code");
		redirectUrl.searchParams.set("error_description", "No authorization code received");
		redirectUrl.searchParams.set("platform", platform);
		return c.redirect(redirectUrl.toString(), 302);
	}

	// Build the redirect_uri that was sent to the OAuth provider (must match for token exchange)
	const apiBaseUrl = c.env.API_BASE_URL || "https://api.relayapi.dev";
	const oauthRedirectUri = `${apiBaseUrl}/connect/oauth/callback`;

	try {
		const result = await exchangeAndSaveAccount({
			env: c.env,
			orgId: org_id,
			platform,
			code,
			redirectUri: oauthRedirectUri,
			codeVerifier: code_verifier ?? undefined,
			method: method ?? undefined,
		});

		redirectUrl.searchParams.set("platform", platform);

		if (result.status === "success") {
			redirectUrl.searchParams.set("status", "success");
			redirectUrl.searchParams.set("account_id", result.account.id);
		} else if (result.status === "pending_selection") {
			redirectUrl.searchParams.set("status", "pending_selection");
		} else {
			redirectUrl.searchParams.set("status", "error");
			redirectUrl.searchParams.set("error_code", result.code);
			redirectUrl.searchParams.set("error_message", result.message);
		}

		return c.redirect(redirectUrl.toString(), 302);
	} catch (err) {
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
