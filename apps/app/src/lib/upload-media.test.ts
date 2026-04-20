import { afterEach, describe, expect, it } from "bun:test";
import { uploadMedia } from "./upload-media";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("uploadMedia", () => {
	it("uses the presign flow when both requests succeed", async () => {
		const calls: string[] = [];
		const getUrl = (input: RequestInfo | URL) =>
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		globalThis.fetch = (async (input) => {
			const url = getUrl(input);
			calls.push(url);

			if (url === "/api/media/presign") {
				return Response.json({
					upload_url: "https://uploads.example.test/file.png",
					url: "https://cdn.example.test/file.png",
				});
			}

			if (url === "https://uploads.example.test/file.png") {
				return new Response(null, { status: 200 });
			}

			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const file = new File(["hello"], "hello.png", { type: "image/png" });
		const result = await uploadMedia(file);

		expect(result).toEqual({
			url: "https://cdn.example.test/file.png",
			type: "image/png",
			filename: "hello.png",
			size: 5,
		});
		expect(calls).toEqual([
			"/api/media/presign",
			"https://uploads.example.test/file.png",
		]);
	});

	it("falls back to the direct upload proxy when presign throws", async () => {
		const calls: string[] = [];
		const getUrl = (input: RequestInfo | URL) =>
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		globalThis.fetch = (async (input) => {
			const url = getUrl(input);
			calls.push(url);

			if (url === "/api/media/presign") {
				throw new Error("network down");
			}

			if (url === "/api/media/upload?filename=voice.webm") {
				return Response.json({
					url: "https://cdn.example.test/voice.webm",
				});
			}

			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const file = new File(["audio"], "voice.webm", { type: "audio/webm" });
		const result = await uploadMedia(file);

		expect(result).toEqual({
			url: "https://cdn.example.test/voice.webm",
			type: "audio/webm",
			filename: "voice.webm",
			size: 5,
		});
		expect(calls).toEqual([
			"/api/media/presign",
			"/api/media/upload?filename=voice.webm",
		]);
	});

	it("falls back to the direct upload proxy when the presigned PUT fails", async () => {
		const calls: string[] = [];
		const getUrl = (input: RequestInfo | URL) =>
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		globalThis.fetch = (async (input) => {
			const url = getUrl(input);
			calls.push(url);

			if (url === "/api/media/presign") {
				return Response.json({
					upload_url: "https://uploads.example.test/file.pdf",
					url: "https://cdn.example.test/file.pdf",
				});
			}

			if (url === "https://uploads.example.test/file.pdf") {
				return new Response(null, { status: 500 });
			}

			if (url === "/api/media/upload?filename=file.pdf") {
				return Response.json({
					url: "https://cdn.example.test/file.pdf",
				});
			}

			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const file = new File(["pdf"], "file.pdf", { type: "application/pdf" });
		const result = await uploadMedia(file);

		expect(result).toEqual({
			url: "https://cdn.example.test/file.pdf",
			type: "application/pdf",
			filename: "file.pdf",
			size: 3,
		});
		expect(calls).toEqual([
			"/api/media/presign",
			"https://uploads.example.test/file.pdf",
			"/api/media/upload?filename=file.pdf",
		]);
	});
});
