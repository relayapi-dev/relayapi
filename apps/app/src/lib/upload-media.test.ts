import { afterEach, describe, expect, it } from "bun:test";
import { uploadMedia } from "./upload-media";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("uploadMedia", () => {
	it("uses resumable multipart upload above 64 MiB and returns the stable reference URL", async () => {
		const calls: string[] = [];
		let completionBody: unknown;
		const file = {
			name: "large-video.mp4",
			type: "video/mp4",
			size: 64 * 1024 * 1024 + 1,
			slice: () => new Blob(["part"], { type: "video/mp4" }),
		} as File;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			calls.push(url);
			if (url === "/api/media/uploads") {
				expect(JSON.parse(String(init?.body))).toEqual({
					filename: "large-video.mp4",
					content_type: "video/mp4",
					size_bytes: 64 * 1024 * 1024 + 1,
					workspace_id: "ws_video",
				});
				return Response.json({
					id: "mup_large",
					media_id: "med_large",
					mode: "multipart",
					status: "created",
					part_size: 64 * 1024 * 1024,
					part_count: 2,
				});
			}
			if (url === "/api/media/uploads/mup_large/parts") {
				return Response.json({
					parts: [1, 2].map((part) => ({
						part_number: part,
						upload_url: `https://uploads.example.test/part-${part}`,
						upload_headers: {},
					})),
				});
			}
			if (url.startsWith("https://uploads.example.test/part-")) {
				return new Response(null, {
					status: 200,
					headers: { ETag: `"etag-${url.at(-1)}"` },
				});
			}
			if (url === "/api/media/uploads/mup_large/complete") {
				completionBody = JSON.parse(String(init?.body));
				return Response.json({
					id: "med_large",
					filename: "large-video.mp4",
					mime_type: "video/mp4",
					size: 64 * 1024 * 1024 + 1,
					url: "https://signed.example.test/temporary",
					reference_url: "https://media.example.test/stable/large-video.mp4",
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as unknown as typeof fetch;

		const result = await uploadMedia(file, { workspaceId: "ws_video" });

		expect(result.url).toBe(
			"https://media.example.test/stable/large-video.mp4",
		);
		expect(completionBody).toEqual({
			parts: [
				{ part_number: 1, etag: '"etag-1"' },
				{ part_number: 2, etag: '"etag-2"' },
			],
		});
		expect(calls).toEqual([
			"/api/media/uploads",
			"/api/media/uploads/mup_large/parts",
			"https://uploads.example.test/part-1",
			"https://uploads.example.test/part-2",
			"/api/media/uploads/mup_large/complete",
		]);
	});

	it("aborts multipart state when storage does not expose an ETag", async () => {
		const file = {
			name: "large-video.mp4",
			type: "video/mp4",
			size: 64 * 1024 * 1024 + 1,
			slice: () => new Blob(["part"], { type: "video/mp4" }),
		} as File;
		let aborted = false;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url === "/api/media/uploads") {
				return Response.json({
					id: "mup_no_etag",
					media_id: "med_no_etag",
					mode: "multipart",
					status: "created",
					part_size: 64 * 1024 * 1024,
					part_count: 2,
				});
			}
			if (url === "/api/media/uploads/mup_no_etag/parts") {
				return Response.json({
					parts: [1, 2].map((part) => ({
						part_number: part,
						upload_url: `https://uploads.example.test/no-etag-${part}`,
						upload_headers: {},
					})),
				});
			}
			if (url.startsWith("https://uploads.example.test/no-etag-")) {
				return new Response(null, { status: 200 });
			}
			if (url === "/api/media/uploads/mup_no_etag") {
				if (aborted) return new Response(null, { status: 204 });
				return Response.json({
					id: "mup_no_etag",
					status: "uploading",
					media: null,
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as unknown as typeof fetch;
		const priorFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = typeof input === "string" ? input : input.toString();
			if (
				url === "/api/media/uploads/mup_no_etag" &&
				init?.method === "DELETE"
			) {
				aborted = true;
				return new Response(null, { status: 204 });
			}
			return priorFetch(input, init);
		}) as unknown as typeof fetch;

		await expect(uploadMedia(file)).rejects.toThrow("did not expose ETag");
		expect(aborted).toBe(true);
	});

	it("rejects media above 200 MiB before making a request", async () => {
		let requested = false;
		globalThis.fetch = (async () => {
			requested = true;
			throw new Error("unexpected");
		}) as unknown as typeof fetch;
		const file = {
			name: "too-large.mp4",
			type: "video/mp4",
			size: 200 * 1024 * 1024 + 1,
		} as File;

		await expect(uploadMedia(file)).rejects.toThrow("cannot exceed 200 MiB");
		expect(requested).toBe(false);
	});

	it("keeps presigned and fallback uploads in the requested workspace", async () => {
		let presignBody: unknown;
		const calls: string[] = [];
		globalThis.fetch = (async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			calls.push(url);
			if (url === "/api/media/presign") {
				presignBody = JSON.parse(String(init?.body));
				throw new Error("presign unavailable");
			}
			if (
				url ===
				"/api/media/upload?filename=workspace.png&workspace_id=ws_automation"
			) {
				return Response.json({
					id: "med_workspace",
					url: "https://media.example/workspace.png",
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const file = new File(["image"], "workspace.png", { type: "image/png" });
		await uploadMedia(file, { workspaceId: "ws_automation" });

		expect(presignBody).toEqual({
			filename: "workspace.png",
			content_type: "image/png",
			workspace_id: "ws_automation",
		});
		expect(calls.at(-1)).toBe(
			"/api/media/upload?filename=workspace.png&workspace_id=ws_automation",
		);
	});

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
			id: "med_1",
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
					id: "med_voice",
					url: "https://cdn.example.test/voice.webm",
				});
			}

			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const file = new File(["audio"], "voice.webm", { type: "audio/webm" });
		const result = await uploadMedia(file);

		expect(result).toEqual({
			id: "med_voice",
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

	it("keeps a fallback upload usable against an API build with no media id", async () => {
		// The app and API Workers deploy independently, so an app-first rollout
		// talks to an API that returns only `url`. The bytes are already stored by
		// then, so failing here would report an error for a successful upload and
		// orphan the object.
		const getUrl = (input: RequestInfo | URL) =>
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		globalThis.fetch = (async (input) => {
			const url = getUrl(input);
			if (url === "/api/media/presign") throw new Error("network down");
			if (url === "/api/media/upload?filename=voice.webm") {
				return Response.json({
					url: "https://cdn.example.test/voice.webm",
					type: "audio/webm",
					size: 5,
					filename: "voice.webm",
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
		expect(result.id).toBeUndefined();
	});

	it("still rejects a fallback upload that returns no URL", async () => {
		const getUrl = (input: RequestInfo | URL) =>
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		globalThis.fetch = (async (input) => {
			const url = getUrl(input);
			if (url === "/api/media/presign") throw new Error("network down");
			if (url === "/api/media/upload?filename=voice.webm") {
				return Response.json({ id: "med_voice" });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const file = new File(["audio"], "voice.webm", { type: "audio/webm" });
		expect(uploadMedia(file)).rejects.toThrow("without a media URL");
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
					id: "med_pdf",
					url: "https://cdn.example.test/file.pdf",
				});
			}

			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const file = new File(["pdf"], "file.pdf", { type: "application/pdf" });
		const result = await uploadMedia(file);

		expect(result).toEqual({
			id: "med_pdf",
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
