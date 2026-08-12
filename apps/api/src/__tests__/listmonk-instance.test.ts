import { describe, expect, test } from "bun:test";
import {
	listmonkApiUrl,
	parseListmonkInstanceUrl,
} from "../lib/listmonk-instance";

describe("Listmonk instance authority", () => {
	test("normalizes a connection-owned HTTPS base", () => {
		expect(parseListmonkInstanceUrl("https://lists.example/relay/")).toBe(
			"https://lists.example/relay",
		);
		expect(
			listmonkApiUrl("https://lists.example/relay/", "/api/campaigns/7"),
		).toBe("https://lists.example/relay/api/campaigns/7");
	});

	test("rejects credential-bearing or ambiguous bases", () => {
		for (const value of [
			"http://lists.example",
			"https://user:secret@lists.example",
			"https://lists.example/?next=https://attacker.example",
			"https://lists.example/#fragment",
		]) {
			expect(() => parseListmonkInstanceUrl(value)).toThrow();
		}
	});
});
