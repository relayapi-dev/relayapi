/**
 * Mailchimp API keys end in the account's server prefix (for example `-us21`).
 *
 * Official reference:
 * https://mailchimp.com/developer/marketing/docs/fundamentals/
 * Section: "API structure"
 * Root URL: https://<dc>.api.mailchimp.com/3.0/
 */
const MAILCHIMP_DATACENTER_PATTERN = /^[a-z]{2}[0-9]+$/;

export function isMailchimpDatacenter(value: string): boolean {
	return MAILCHIMP_DATACENTER_PATTERN.test(value);
}

export function getMailchimpDatacenter(apiKey: string): string | null {
	const separator = apiKey.lastIndexOf("-");
	if (separator <= 0 || separator === apiKey.length - 1) return null;

	const datacenter = apiKey.slice(separator + 1);
	return isMailchimpDatacenter(datacenter) ? datacenter : null;
}

/**
 * Construct a Mailchimp URL and enforce its origin after URL resolution.
 * The path assertion also prevents an absolute or scheme-relative path from
 * overriding the validated datacenter host.
 */
export function buildMailchimpApiUrl(datacenter: string, path = "/3.0/"): URL {
	if (!isMailchimpDatacenter(datacenter)) {
		throw new Error("Invalid Mailchimp datacenter");
	}

	const expectedHostname = `${datacenter}.api.mailchimp.com`;
	const base = new URL(`https://${expectedHostname}/`);
	const url = new URL(path, base);

	if (
		url.protocol !== "https:" ||
		url.hostname !== expectedHostname ||
		url.port !== "" ||
		url.username !== "" ||
		url.password !== ""
	) {
		throw new Error("Invalid Mailchimp API URL");
	}

	return url;
}
