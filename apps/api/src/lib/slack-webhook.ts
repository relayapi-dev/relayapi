export type SlackWebhookIdentity = {
	url: string;
	teamId: string;
	serviceId: string;
};

/** Parse only Slack-issued incoming webhook bearer URLs. */
export function parseSlackWebhookUrl(value: string): SlackWebhookIdentity {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Slack webhook URL is not a valid URL.");
	}
	if (
		parsed.protocol !== "https:" ||
		!["hooks.slack.com", "hooks.slack-gov.com"].includes(parsed.hostname) ||
		parsed.port ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error(
			"Slack webhook URL must use the exact Slack or GovSlack HTTPS webhook origin without credentials, a port, query, or fragment.",
		);
	}
	const match = parsed.pathname.match(
		/^\/services\/(T[A-Z0-9]+)\/(B[A-Z0-9]+)\/([A-Za-z0-9_-]+)\/?$/,
	);
	if (!match?.[1] || !match[2] || !match[3]) {
		throw new Error(
			"Slack webhook URL must match /services/{team}/{service}/{secret}.",
		);
	}
	return {
		url: `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`,
		teamId: match[1],
		serviceId: match[2],
	};
}
