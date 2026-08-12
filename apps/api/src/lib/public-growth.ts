import type { Env } from "../types";

export type PublicResourceScope =
	| {
			kind: "organization";
			organizationId: string;
			organizationSlug: string;
	  }
	| {
			kind: "workspace";
			organizationId: string;
			organizationSlug: string;
			workspaceId: string;
			workspaceSlug: string;
	  };

function publicBaseUrl(
	env: Pick<Env, "PUBLIC_LINK_BASE_URL" | "API_BASE_URL">,
): string {
	return (
		env.PUBLIC_LINK_BASE_URL?.trim() ||
		env.API_BASE_URL?.trim() ||
		"https://go.relayapi.dev"
	).replace(/\/+$/, "");
}

function scopedPath(
	prefix: "r" | "l",
	scope: PublicResourceScope,
	resourceId: string,
	slug: string,
): string {
	const organizationId = encodeURIComponent(scope.organizationId);
	const organization = encodeURIComponent(scope.organizationSlug);
	const stableResource = encodeURIComponent(resourceId);
	const resource = encodeURIComponent(slug);
	return scope.kind === "organization"
		? `/${prefix}/${organizationId}/${organization}/o/${stableResource}/${resource}`
		: `/${prefix}/${organizationId}/${organization}/w/${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.workspaceSlug)}/${stableResource}/${resource}`;
}

export function refPublicUrl(
	env: Pick<Env, "PUBLIC_LINK_BASE_URL" | "API_BASE_URL">,
	scope: PublicResourceScope,
	resourceId: string,
	slug: string,
): string {
	return `${publicBaseUrl(env)}${scopedPath("r", scope, resourceId, slug)}`;
}

export function landingPagePublicUrl(
	env: Pick<Env, "PUBLIC_LINK_BASE_URL" | "API_BASE_URL">,
	scope: PublicResourceScope,
	resourceId: string,
	slug: string,
): string {
	return `${publicBaseUrl(env)}${scopedPath("l", scope, resourceId, slug)}`;
}

export function landingPageConversionUrl(
	env: Pick<Env, "PUBLIC_LINK_BASE_URL" | "API_BASE_URL">,
	scope: PublicResourceScope,
	resourceId: string,
	slug: string,
): string {
	return `${landingPagePublicUrl(env, scope, resourceId, slug)}/conversions`;
}

export function qrScanUrl(
	env: Pick<Env, "PUBLIC_LINK_BASE_URL" | "API_BASE_URL">,
	publicId: string,
): string {
	return `${publicBaseUrl(env)}/q/${encodeURIComponent(publicId)}`;
}

export function qrImageUrl(
	env: Pick<Env, "PUBLIC_LINK_BASE_URL" | "API_BASE_URL">,
	publicId: string,
): string {
	return `${publicBaseUrl(env)}/q/${encodeURIComponent(publicId)}.svg`;
}

/**
 * A caller-provided idempotency key is authoritative. Public GET requests fall
 * back to Cloudflare's per-request ray id; local/non-Cloudflare requests get a
 * fresh key so distinct visits are never collapsed into a durable fingerprint.
 */
export function publicGrowthIdempotencyKey(
	headers: Headers,
	explicit?: string | null,
): string {
	const requested = explicit?.trim() || headers.get("Idempotency-Key")?.trim();
	if (requested) return requested.slice(0, 200);
	const ray = headers.get("CF-Ray")?.trim();
	if (ray) return `cf-ray:${ray}`.slice(0, 200);
	return `request:${crypto.randomUUID()}`;
}
