import { bitlyProvider } from "./bitly";
import { dubProvider } from "./dub";
import { createRelayApiProvider } from "./relayapi";
import { shortIoProvider } from "./short-io";
import type { ShortLinkProvider, ShortLinkProviderType } from "./types";

export type { ShortLinkProvider, ShortLinkProviderType };
export { createRelayApiProvider };

const thirdPartyProviders: Record<string, ShortLinkProvider> = {
	dub: dubProvider,
	short_io: shortIoProvider,
	bitly: bitlyProvider,
};

/**
 * Get a provider instance by type.
 * Third-party providers are singletons. The built-in "relayapi" provider
 * requires request-scoped DB/KV/organization context — use
 * createRelayApiProvider() directly for that.
 */
export function getProvider(
	type: ShortLinkProviderType,
): ShortLinkProvider | null {
	return thirdPartyProviders[type] ?? null;
}
