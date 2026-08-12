export type DiscordWebhookIdentity = {
	url: string;
	webhookId: string;
	webhookToken: string;
};

/**
 * Parse only Discord-issued incoming webhook URLs. The URL is a bearer
 * credential, so permissive substring matching or redirects can exfiltrate it.
 */
export function parseDiscordWebhookUrl(value: string): DiscordWebhookIdentity {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Discord webhook URL is not a valid URL.");
	}

	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== "discord.com" ||
		parsed.port !== "" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		throw new Error(
			"Discord webhook URL must use the exact https://discord.com origin without credentials, a port, query, or fragment.",
		);
	}

	const match = parsed.pathname.match(
		/^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([A-Za-z0-9._-]+)\/?$/,
	);
	if (!match) {
		throw new Error(
			"Discord webhook URL must match /api/webhooks/{webhook.id}/{webhook.token}.",
		);
	}

	const [, webhookId, webhookToken] = match;
	if (!webhookId || !webhookToken) {
		throw new Error("Discord webhook URL is missing its ID or token.");
	}

	return {
		url: `https://discord.com${parsed.pathname.replace(/\/$/, "")}`,
		webhookId,
		webhookToken,
	};
}
