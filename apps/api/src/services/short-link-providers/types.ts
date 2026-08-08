import type { SingleUnitProviderMutationAggregate } from "../../lib/mutation-provider-boundary";

export type RelayApiProviderRef = {
	provider: "relayapi";
	shortCode: string;
};

export type DubProviderRef = {
	provider: "dub";
	/** Durable client-owned identity sent before the provider call. */
	externalId: string;
	/** Present after a successful create response. */
	linkId?: string;
};

export type ShortIoProviderRef = {
	provider: "short_io";
	/** Local intent identity retained when the create response is ambiguous. */
	intentId: string;
	/** Provider identity returned by POST /links. */
	idString?: string;
	domainId?: number;
};

export type BitlyProviderRef = {
	provider: "bitly";
	/** Local intent identity retained when the create response is ambiguous. */
	intentId: string;
	/** Canonical bitlink identity without a protocol, for example bit.ly/abc. */
	bitlink?: string;
	/** Bitly documents DELETE only for an unedited hash link. */
	editedOrCustom?: boolean;
};

export type ProviderRef =
	| RelayApiProviderRef
	| DubProviderRef
	| ShortIoProviderRef
	| BitlyProviderRef;

export type ProviderCreateResult = {
	shortUrl: string;
	providerRef: ProviderRef;
};

export type ProviderCleanupOutcome =
	| { kind: "deleted" }
	| { kind: "neutralized"; detail: string }
	| { kind: "unsupported"; reason: string }
	| { kind: "unknown"; reason: string };

export type ProviderAnalyticsTarget = {
	key: string;
	shortUrl: string;
	providerRef: ProviderRef;
};

export interface ShortLinkProvider {
	readonly providerType: ShortLinkProviderType;

	/** The default domain for this provider (used to skip already-shortened URLs) */
	readonly shortLinkDomain: string;

	/** Create a remote link under an already-durable local intent. */
	shorten(
		apiKey: string,
		domain: string | null,
		url: string,
		intentId: string,
		providerMutation?: SingleUnitProviderMutationAggregate,
	): Promise<ProviderCreateResult>;

	/** Authenticate with a read-only endpoint. Must not create a remote link. */
	probeCredential(apiKey: string): Promise<void>;

	/** Preserve provider-specific cleanup semantics. */
	deleteLink(
		apiKey: string,
		providerRef: ProviderRef,
	): Promise<ProviderCleanupOutcome>;

	/** Get click count for a single short URL */
	getClickCount(
		apiKey: string,
		target: ProviderAnalyticsTarget,
	): Promise<number>;

	/** Get click counts for multiple short URLs (batch) */
	getClickCounts(
		apiKey: string,
		targets: ProviderAnalyticsTarget[],
	): Promise<Map<string, number>>;
}

export type ShortLinkProviderType = "relayapi" | "dub" | "short_io" | "bitly";
