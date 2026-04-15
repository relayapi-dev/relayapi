export const API_BASE_URL =
	import.meta.env.API_BASE_URL ||
	(import.meta.env.DEV ? "http://localhost:8789" : "https://api.relayapi.dev");
