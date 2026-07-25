import { afterEach, describe, expect, it } from "bun:test";
import { uploadMedia } from "./upload-media";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("uploadMedia", () => {
	it("uses the presign flow when both requests succeed", async () => {
		const calls: string[] = [];
		let putHeaders: Headers | undefined;
		const getUrl = (input: RequestInfo | URL) =>
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		globalThis.fetch = (async (input, init) => {
			const url = getUrl(input);
			calls.push(url);

			if (url === "/api/media/presign") {
				return Response.json({
					id: "med_1",
					upload_url: "https://uploads.example.test/file.png",
					upload_headers: {
						"Content-Type": "image/png",
						"If-None-Match": "*",
					},
					url: "https://cdn.example.test/file.png",
				});
			}

			if (url === "https://uploads.example.test/file.png") {
				putHeaders = new Headers(init?.headers);
				return new Response(null, { status: 200 });
			}

			// The presigned PUT is now followed by a confirm call that flips the
			// media row pending -> ready.
			if (url === "/api/media/confirm") {
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
			"/api/media/confirm",
		]);
		expect(putHeaders?.get("content-type")).toBe("image/png");
		expect(putHeaders?.get("if-none-match")).toBe("*");
	});

	it("does not upload the bytes again when confirm fails", async () => {
		const calls: string[] = [];
		const getUrl = (input: RequestInfo | URL) =>
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		globalThis.fetch = (async (input) => {
			const url = getUrl(input);
			calls.push(url);

			if (url === "/api/media/presign") {
				return Response.json({
					id: "med_1",
					upload_url: "https://uploads.example.test/file.png",
					url: "https://cdn.example.test/file.png",
				});
			}

			if (url === "https://uploads.example.test/file.png") {
				return new Response(null, { status: 200 });
			}

			// Confirm rejects (e.g. MIME/size re-validation). The bytes already
			// reached storage, so the proxy must not upload them a second time.
			if (url === "/api/media/confirm") {
				return new Response(null, { status: 400 });
			}
			if (url === "/api/media/med_1") {
				return new Response(null, { status: 204 });
			}

			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const file = new File(["hello"], "hello.png", { type: "image/png" });
		await expect(uploadMedia(file)).rejects.toThrow(
			"Upload confirmation failed: 400",
		);

		expect(calls).toEqual([
			"/api/media/presign",
			"https://uploads.example.test/file.png",
			"/api/media/confirm",
			"/api/media/med_1",
		]);
	});

	it("deletes the intent when confirmation committed but its response was lost", async () => {
		const calls: string[] = [];
		const getUrl = (input: RequestInfo | URL) =>
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		globalThis.fetch = (async (input) => {
			const url = getUrl(input);
			calls.push(url);
			if (url === "/api/media/presign") {
				return Response.json({
					id: "med_lost_confirm",
					upload_url: "https://uploads.example.test/lost.png",
					url: "https://cdn.example.test/lost.png",
				});
			}
			if (url === "https://uploads.example.test/lost.png") {
				return new Response(null, { status: 200 });
			}
			if (url === "/api/media/confirm") {
				// Models a response transport failure after the upstream confirm may
				// already have committed pending -> ready.
				throw new Error("connection reset after commit");
			}
			if (url === "/api/media/med_lost_confirm") {
				return new Response(null, { status: 204 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const file = new File(["hello"], "lost.png", { type: "image/png" });
		await expect(uploadMedia(file)).rejects.toThrow(
			"confirmation could not be completed",
		);
		expect(calls).toEqual([
			"/api/media/presign",
			"https://uploads.example.test/lost.png",
			"/api/media/confirm",
			"/api/media/med_lost_confirm",
		]);
	});

	it("falls back to the direct upload proxy when presign throws", async () => {
		const calls: string[] = [];
		const getUrl = (input: RequestInfo | URL) =>
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
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
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		globalThis.fetch = (async (input) => {
			const url = getUrl(input);
			calls.push(url);

			if (url === "/api/media/presign") {
				return Response.json({
					id: "med_1",
					upload_url: "https://uploads.example.test/file.pdf",
					url: "https://cdn.example.test/file.pdf",
				});
			}

			if (url === "https://uploads.example.test/file.pdf") {
				return new Response(null, { status: 500 });
			}

			if (url === "/api/media/med_1") {
				return new Response(null, { status: 204 });
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
			"/api/media/med_1",
			"/api/media/upload?filename=file.pdf",
		]);
	});

	it("does not fall back while cleanup of a failed presigned intent is ambiguous", async () => {
		const calls: string[] = [];
		const getUrl = (input: RequestInfo | URL) =>
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		globalThis.fetch = (async (input) => {
			const url = getUrl(input);
			calls.push(url);
			if (url === "/api/media/presign") {
				return Response.json({
					id: "med_2",
					upload_url: "https://uploads.example.test/file.pdf",
					url: "https://cdn.example.test/file.pdf",
				});
			}
			if (url === "https://uploads.example.test/file.pdf") {
				throw new Error("connection reset");
			}
			if (url === "/api/media/med_2") {
				return new Response(null, { status: 503 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const file = new File(["pdf"], "file.pdf", { type: "application/pdf" });
		await expect(uploadMedia(file)).rejects.toThrow(
			"pending record could not be cleaned up",
		);
		expect(calls).toEqual([
			"/api/media/presign",
			"https://uploads.example.test/file.pdf",
			"/api/media/med_2",
		]);
	});
});
