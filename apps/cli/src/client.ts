import Relay from "@relayapi/sdk";
import pc from "picocolors";
import { resolveApiKey, resolveBaseUrl } from "./config.js";

export function createClient(): Relay {
	const apiKey = resolveApiKey();
	if (!apiKey) {
		console.error(
			pc.red("No API key configured.") +
				"\n\n" +
				`Run ${pc.bold("relay auth set-key")} to save your API key, or set the ${pc.bold("RELAYAPI_API_KEY")} environment variable.`,
		);
		process.exit(1);
	}

	const baseURL = resolveBaseUrl();
	return new Relay({ apiKey, baseURL: baseURL || undefined });
}
