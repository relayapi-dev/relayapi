import type { OAuthConfig } from "../config/oauth";
import { fetchPublicUrl, readResponseJson } from "../lib/fetch-public-url";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";

const MAX_MASTODON_OAUTH_RESPONSE_BYTES = 256 * 1024;
const GRANULAR_SCOPES = [
	"read:accounts",
	"write:statuses",
	"write:media",
] as const;

export interface MastodonOAuthState {
	instance_url: string;
	auth_url: string;
	token_url: string;
	profile_url: string;
	client_id: string;
	client_secret: string;
	scopes: string[];
}

export class MastodonOAuthSetupError extends Error {
	readonly code:
		| "INVALID_INSTANCE_URL"
		| "INSTANCE_UNREACHABLE"
		| "INSTANCE_OAUTH_UNSUPPORTED";

	constructor(code: MastodonOAuthSetupError["code"], message: string) {
		super(message);
		this.name = "MastodonOAuthSetupError";
		this.code = code;
	}
}

function sameOriginEndpoint(
	value: unknown,
	instanceOrigin: string,
): string | null {
	if (typeof value !== "string") return null;
	try {
		const endpoint = new URL(value);
		if (
			endpoint.protocol !== "https:" ||
			endpoint.origin !== instanceOrigin ||
			endpoint.username ||
			endpoint.password ||
			endpoint.hash
		) {
			return null;
		}
		return endpoint.toString();
	} catch {
		return null;
	}
}

async function normalizeInstanceOrigin(
	rawInstanceUrl: string,
): Promise<string> {
	let parsed: URL;
	try {
		parsed = new URL(rawInstanceUrl.trim());
	} catch {
		throw new MastodonOAuthSetupError(
			"INVALID_INSTANCE_URL",
			"instance_url must be a valid HTTPS Mastodon origin.",
		);
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		(parsed.pathname !== "/" && parsed.pathname !== "") ||
		parsed.search ||
		parsed.hash
	) {
		throw new MastodonOAuthSetupError(
			"INVALID_INSTANCE_URL",
			"instance_url must be a public HTTPS origin without credentials, a path, a query, or a fragment.",
		);
	}
	const origin = parsed.origin;
	if (await isBlockedUrlWithDns(origin)) {
		throw new MastodonOAuthSetupError(
			"INVALID_INSTANCE_URL",
			"instance_url must resolve only to public internet addresses.",
		);
	}
	return origin;
}

/**
 * Register a confidential OAuth client on the selected Mastodon instance.
 *
 * Official docs:
 * - Discovery: https://docs.joinmastodon.org/methods/oauth/#discover-oauth-server-configuration
 * - Registration: https://docs.joinmastodon.org/methods/apps/#create-an-application
 *
 * GET {instance}/.well-known/oauth-authorization-server, then
 * POST {instance}/api/v1/apps with client_name, redirect_uris, scopes, website.
 */
export async function registerMastodonOAuthClient(params: {
	instanceUrl: string;
	redirectUri: string;
	website: string;
}): Promise<MastodonOAuthState> {
	const instanceUrl = await normalizeInstanceOrigin(params.instanceUrl);
	let authUrl = `${instanceUrl}/oauth/authorize`;
	let tokenUrl = `${instanceUrl}/oauth/token`;
	let registrationUrl = `${instanceUrl}/api/v1/apps`;
	let scopes: string[] = [...GRANULAR_SCOPES];

	try {
		const metadataResponse = await fetchPublicUrl(
			`${instanceUrl}/.well-known/oauth-authorization-server`,
			{
				headers: { Accept: "application/json" },
				timeout: 10_000,
				timeoutThroughBody: true,
			},
		);
		if (metadataResponse.ok) {
			const metadata = await readResponseJson<{
				authorization_endpoint?: string;
				token_endpoint?: string;
				app_registration_endpoint?: string;
				scopes_supported?: unknown;
			}>(metadataResponse, MAX_MASTODON_OAUTH_RESPONSE_BYTES);
			authUrl =
				sameOriginEndpoint(metadata.authorization_endpoint, instanceUrl) ??
				authUrl;
			tokenUrl =
				sameOriginEndpoint(metadata.token_endpoint, instanceUrl) ?? tokenUrl;
			registrationUrl =
				sameOriginEndpoint(metadata.app_registration_endpoint, instanceUrl) ??
				registrationUrl;
			const supported = Array.isArray(metadata.scopes_supported)
				? metadata.scopes_supported.filter(
						(scope): scope is string => typeof scope === "string",
					)
				: [];
			if (
				supported.length > 0 &&
				!GRANULAR_SCOPES.every((scope) => supported.includes(scope))
			) {
				scopes = ["read", "write"];
			}
		} else {
			void metadataResponse.body?.cancel().catch(() => undefined);
		}
	} catch {
		// Mastodon before 4.3 does not expose authorization-server metadata. Its
		// documented conventional endpoints remain the compatibility fallback.
	}

	const registrationResponse = await fetchPublicUrl(registrationUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			client_name: "RelayAPI",
			redirect_uris: [params.redirectUri],
			scopes: scopes.join(" "),
			website: params.website,
		}),
		timeout: 10_000,
		timeoutThroughBody: true,
	});
	if (!registrationResponse.ok) {
		void registrationResponse.body?.cancel().catch(() => undefined);
		throw new MastodonOAuthSetupError(
			registrationResponse.status >= 500
				? "INSTANCE_UNREACHABLE"
				: "INSTANCE_OAUTH_UNSUPPORTED",
			"The selected Mastodon instance did not accept OAuth application registration.",
		);
	}
	const registration = await readResponseJson<{
		client_id?: unknown;
		client_secret?: unknown;
	}>(registrationResponse, MAX_MASTODON_OAUTH_RESPONSE_BYTES);
	if (
		typeof registration.client_id !== "string" ||
		!registration.client_id ||
		typeof registration.client_secret !== "string" ||
		!registration.client_secret
	) {
		throw new MastodonOAuthSetupError(
			"INSTANCE_OAUTH_UNSUPPORTED",
			"The selected Mastodon instance returned an invalid OAuth registration response.",
		);
	}

	return {
		instance_url: instanceUrl,
		auth_url: authUrl,
		token_url: tokenUrl,
		profile_url: `${instanceUrl}/api/v1/accounts/verify_credentials`,
		client_id: registration.client_id,
		client_secret: registration.client_secret,
		scopes,
	};
}

export function mastodonOAuthConfigFromState(
	state: MastodonOAuthState,
): OAuthConfig {
	return {
		authUrl: state.auth_url,
		tokenUrl: state.token_url,
		profileUrl: state.profile_url,
		scopes: state.scopes,
		getClientId: () => state.client_id,
		getClientSecret: () => state.client_secret,
		requiresPublicEndpointValidation: true,
	};
}
