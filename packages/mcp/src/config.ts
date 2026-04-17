export interface Config {
	apiKey: string;
	baseURL?: string;
}

export function loadConfig(): Config {
	const apiKey = process.env.RELAYAPI_KEY ?? process.env.RELAY_API_KEY;
	if (!apiKey) {
		throw new Error(
			"RELAYAPI_KEY is not set. Provide a rlay_live_* or rlay_test_* key via the RELAYAPI_KEY environment variable.",
		);
	}
	return {
		apiKey,
		baseURL: process.env.RELAYAPI_BASE_URL ?? process.env.RELAY_BASE_URL,
	};
}
