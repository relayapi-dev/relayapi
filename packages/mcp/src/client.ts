import Relay from "@relayapi/sdk";
import type { Config } from "./config";

export function createRelayClient(config: Config): Relay {
	return new Relay({
		apiKey: config.apiKey,
		baseURL: config.baseURL,
	});
}

export type RelayClient = Relay;
