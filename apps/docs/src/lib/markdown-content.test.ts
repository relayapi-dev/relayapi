/// <reference types="bun-types" />

import { beforeEach, describe, expect, test } from "bun:test";
import {
	clearMarkdownContentCache,
	fetchMarkdownContent,
} from "./markdown-content";

describe("Markdown content cache", () => {
	beforeEach(() => clearMarkdownContentCache());

	test("rejects non-success responses and retries after a transient failure", async () => {
		let attempts = 0;
		const request = async () => {
			attempts += 1;
			return attempts === 1
				? new Response("temporary", { status: 503, statusText: "Unavailable" })
				: new Response("# Ready", { status: 200 });
		};

		await expect(fetchMarkdownContent("/page.mdx", request)).rejects.toThrow(
			"503 Unavailable",
		);
		await expect(fetchMarkdownContent("/page.mdx", request)).resolves.toBe(
			"# Ready",
		);
		expect(attempts).toBe(2);
	});

	test("deduplicates concurrent successful requests", async () => {
		let attempts = 0;
		const request = async () => {
			attempts += 1;
			return new Response("# Cached", { status: 200 });
		};

		const [first, second] = await Promise.all([
			fetchMarkdownContent("/cached.mdx", request),
			fetchMarkdownContent("/cached.mdx", request),
		]);

		expect(first).toBe("# Cached");
		expect(second).toBe("# Cached");
		expect(attempts).toBe(1);
	});
});
