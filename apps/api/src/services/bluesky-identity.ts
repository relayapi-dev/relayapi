import { readResponseJson } from "../lib/fetch-public-url";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";

const IDENTITY_RESPONSE_LIMIT = 256 * 1024;

type DidDocument = {
	id?: string;
	alsoKnownAs?: string[];
	service?: Array<{
		id?: string;
		type?: string;
		serviceEndpoint?: string;
	}>;
};

export function didDocumentUrl(did: string): string {
	if (/^did:plc:[a-z2-7]{24}$/.test(did)) {
		return `https://plc.directory/${encodeURIComponent(did)}`;
	}
	if (did.startsWith("did:web:")) {
		const segments = did
			.slice("did:web:".length)
			.split(":")
			.map((segment) => decodeURIComponent(segment));
		const host = segments.shift();
		if (!host || host.includes("/") || host.includes("@")) {
			throw new Error("Unsupported did:web identifier.");
		}
		const path =
			segments.length === 0
				? "/.well-known/did.json"
				: `/${segments.map(encodeURIComponent).join("/")}/did.json`;
		return `https://${host}${path}`;
	}
	throw new Error("Only did:plc and did:web identities are supported.");
}

export function pdsFromDidDocument(
	did: string,
	handle: string,
	document: DidDocument,
): string {
	if (document.id !== did) {
		throw new Error("The DID document does not match the resolved identity.");
	}
	const normalizedHandle = handle.replace(/^@/, "").toLowerCase();
	if (
		!document.alsoKnownAs?.some(
			(alias) => alias.toLowerCase() === `at://${normalizedHandle}`,
		)
	) {
		throw new Error("The DID document does not claim the requested handle.");
	}
	const service = document.service?.find(
		(item) =>
			(item.id === "#atproto_pds" || item.id === `${did}#atproto_pds`) &&
			item.type === "AtprotoPersonalDataServer",
	);
	if (!service?.serviceEndpoint) {
		throw new Error("The identity has no AT Protocol PDS service endpoint.");
	}
	let endpoint: URL;
	try {
		endpoint = new URL(service.serviceEndpoint);
	} catch {
		throw new Error("The identity contains an invalid PDS endpoint.");
	}
	if (
		endpoint.protocol !== "https:" ||
		endpoint.username ||
		endpoint.password ||
		endpoint.port ||
		endpoint.pathname !== "/" ||
		endpoint.search ||
		endpoint.hash
	) {
		throw new Error("The PDS endpoint must be a public HTTPS origin.");
	}
	return endpoint.origin;
}

/**
 * Official identity-resolution guidance:
 * https://docs.bsky.app/docs/advanced-guides/resolving-identities
 * Backend services resolve handle -> DID, resolve the DID document, verify the
 * handle bidirectionally, then use the #atproto_pds service endpoint.
 */
export async function resolveBlueskyPds(
	handle: string,
): Promise<{ did: string; pdsUrl: string }> {
	const normalizedHandle = handle.replace(/^@/, "").trim().toLowerCase();
	const resolveUrl = new URL(
		"https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle",
	);
	resolveUrl.searchParams.set("handle", normalizedHandle);
	const resolveResponse = await fetch(resolveUrl, { redirect: "error" });
	if (!resolveResponse.ok) {
		void resolveResponse.body?.cancel().catch(() => undefined);
		throw new Error("Bluesky could not resolve this handle.");
	}
	const resolved = await readResponseJson<{ did?: string }>(
		resolveResponse,
		IDENTITY_RESPONSE_LIMIT,
	);
	if (!resolved.did)
		throw new Error("Bluesky returned no DID for this handle.");

	const documentUrl = didDocumentUrl(resolved.did);
	if (await isBlockedUrlWithDns(documentUrl)) {
		throw new Error("The DID document resolves to a private or reserved host.");
	}
	const didResponse = await fetch(documentUrl, { redirect: "error" });
	if (!didResponse.ok) {
		void didResponse.body?.cancel().catch(() => undefined);
		throw new Error("The account DID document could not be loaded.");
	}
	const document = await readResponseJson<DidDocument>(
		didResponse,
		IDENTITY_RESPONSE_LIMIT,
	);
	const pdsUrl = pdsFromDidDocument(resolved.did, normalizedHandle, document);
	if (await isBlockedUrlWithDns(pdsUrl)) {
		throw new Error("The account PDS resolves to a private or reserved host.");
	}
	return { did: resolved.did, pdsUrl };
}
