import type { ShortLinkProvider, ShortLinkProviderType } from "./types";
import { dubProvider } from "./dub";
import { shortIoProvider } from "./short-io";
import { bitlyProvider } from "./bitly";
import { createRelayApiProvider } from "./relayapi";

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
 * requires KV + baseUrl — use createRelayApiProvider() directly for that.
 */
export function getProvider(type: ShortLinkProviderType): ShortLinkProvider | null {
	return thirdPartyProviders[type] ?? null;
}
