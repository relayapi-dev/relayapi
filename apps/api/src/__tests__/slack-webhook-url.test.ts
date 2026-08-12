import { describe, expect, test } from "bun:test";
import { parseSlackWebhookUrl } from "../lib/slack-webhook";

describe("parseSlackWebhookUrl", () => {
	test("accepts Slack and GovSlack incoming webhook origins", () => {
		expect(
			parseSlackWebhookUrl(
				"https://hooks.slack.com/services/T00000000/B00000000/secret_value",
			),
		).toEqual({
			url: "https://hooks.slack.com/services/T00000000/B00000000/secret_value",
			teamId: "T00000000",
			serviceId: "B00000000",
		});
		expect(
			parseSlackWebhookUrl("https://hooks.slack-gov.com/services/T1/B2/secret")
				.teamId,
		).toBe("T1");
	});

	test.each([
		"https://evil.test/hooks.slack.com/services/T1/B2/secret",
		"https://hooks.slack.com.evil.test/services/T1/B2/secret",
		"http://hooks.slack.com/services/T1/B2/secret",
		"https://hooks.slack.com/services/T1/B2/secret?next=evil",
		"https://hooks.slack.com/not-services/T1/B2/secret",
	])("rejects unsafe URL %s", (value) => {
		expect(() => parseSlackWebhookUrl(value)).toThrow();
	});
});
