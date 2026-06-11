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

	const stateData = await c.env.KV.get<OAuthState>(
		`oauth-state:${state}`,
		"json",
	);

	if (!stateData) {
		return c.text("Invalid or expired state token", 400);
	}

	// One-time-use enforcement. KV get->delete is not atomic and KV is eventually
	// consistent, so two near-simultaneous hits of the same callback URL (double
	// click, browser prefetch, link scanners) could both pass the state check and
	// both re-exchange the same authorization code — which providers like Google
	// then treat as a replay and revoke all tokens for. Mitigate by writing a
	// short-TTL "claimed" marker and bailing if we did not win the claim.
	const claimKey = `oauth-state-claimed:${state}`;
	if (await c.env.KV.get(claimKey)) {
		return c.text("This authorization link has already been used.", 400);
	}
	await c.env.KV.put(claimKey, "1", { expirationTtl: 600 });
	// Delete state immediately (one-time use)
	await c.env.KV.delete(`oauth-state:${state}`);

	const { org_id, platform, method, redirect_url, code_verifier, headless } = stateData;
	if (!isAllowedCustomerRedirectUrl(redirect_url)) {
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
		await c.env.KV.put(`pending-oauth:${state}`, JSON.stringify({ platform, ...payload }), {
			expirationTtl: 600,
		});
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
			waitUntil: (p) => c.executionCtx.waitUntil(p),
		});

		if (headless) {
			if (result.status === "success") {
				return storeHeadlessResult({ status: "success", account: result.account });
			}
			if (result.status === "pending_selection") {
				return storeHeadlessResult({ status: "pending_selection" });
			}
			return storeHeadlessResult({
				status: "error",
				error_code: result.code,
				error_message: result.message,
			});
		}

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
