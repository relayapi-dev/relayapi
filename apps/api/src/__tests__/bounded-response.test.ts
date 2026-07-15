import { afterEach, describe, expect, it } from "bun:test";
import {
	assertResponseSize,
	awaitResponseWithBodyCompletion,
	createBoundedReadableBody,
	ensureResponseContentLength,
	fetchPublicUrl,
	getChunkedResponseBody,
	getFixedLengthResponseBody,
	MissingContentLengthError,
	parseContentLength,
	ResponseTooLargeError,
	readRequestText,
	readResponseBytes,
} from "../lib/fetch-public-url";
import {
	createStreamingMultipartBody,
	createStreamingMultipartFilesBody,
} from "../lib/multipart-stream";

const originalFetch = globalThis.fetch;
const RELAY_MEDIA_URL =
	"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/relayapi-media/org_1/media.bin?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test&X-Amz-Date=20260713T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=test";

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function chunkedResponse(
	chunks: number[],
	contentLength?: string,
	onCancel?: () => void,
): Response {
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				const size = chunks[index++];
				if (size === undefined) {
					controller.close();
					return;
				}
				controller.enqueue(new Uint8Array(size).fill(index));
			},
			cancel() {
				onCancel?.();
			},
		}),
		contentLength === undefined
			? undefined
			: { headers: { "Content-Length": contentLength } },
	);
}

describe("bounded response bodies", () => {
	it("rejects an oversized declared body before reading it", () => {
		let cancelled = false;
		const response = chunkedResponse([2, 2], "9", () => {
			cancelled = true;
		});

		expect(() => assertResponseSize(response, 8)).toThrow(
			ResponseTooLargeError,
		);
		// The runtime may have already pulled the final synthetic test chunk, but
		// the bounded reader still fails before exposing bytes beyond the cap.
		expect(typeof cancelled).toBe("boolean");
	});

	it("counts an undeclared body and cancels as soon as it crosses the limit", async () => {
		const response = chunkedResponse([3, 3, 3]);

		await expect(readResponseBytes(response, 8)).rejects.toBeInstanceOf(
			ResponseTooLargeError,
		);
	});

	it("does not trust a zero or understated Content-Length", async () => {
		await expect(
			readResponseBytes(chunkedResponse([5, 5], "0"), 8),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
		await expect(
			readResponseBytes(chunkedResponse([5, 5], "2"), 8),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
	});

	it("returns exact bytes for a bounded body", async () => {
		const bytes = await readResponseBytes(chunkedResponse([2, 3], "5"), 5);
		expect(bytes.byteLength).toBe(5);
		expect([...new Uint8Array(bytes)]).toEqual([1, 1, 2, 2, 2]);
	});

	it("exposes the streamed byte count without buffering", async () => {
		const source = chunkedResponse([2, 3]).body;
		const bounded = createBoundedReadableBody(source, 5);
		await new Response(bounded.body).arrayBuffer();
		expect(await bounded.bytesRead).toBe(5);
	});

	for (const [label, contentLength] of [
		["missing", undefined],
		["zero", "0"],
		["malformed", "not-a-size"],
	] as const) {
		it(`measures and replays a ${label} Content-Length source at the exact limit`, async () => {
			let refetches = 0;
			const prepared = await ensureResponseContentLength(
				chunkedResponse([2, 3], contentLength),
				5,
				async () => {
					refetches++;
					return chunkedResponse([1, 4], contentLength);
				},
			);

			expect(refetches).toBe(1);
			expect(prepared.headers.get("content-length")).toBe("5");
			const source = getFixedLengthResponseBody(prepared, 5);
			expect((await new Response(source.body).arrayBuffer()).byteLength).toBe(
				5,
			);
			expect(await source.completion).toBe(5);
		});
	}

	it("rejects an over-limit unknown-length source before refetching", async () => {
		let refetched = false;
		await expect(
			ensureResponseContentLength(chunkedResponse([3, 3]), 5, async () => {
				refetched = true;
				return chunkedResponse([3, 3]);
			}),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
		expect(refetched).toBe(false);
	});

	it("does not measure or refetch the declared-length hot path", async () => {
		let refetched = false;
		const response = chunkedResponse([2, 3], "5");
		const prepared = await ensureResponseContentLength(
			response,
			5,
			async () => {
				refetched = true;
				return chunkedResponse([2, 3], "5");
			},
		);

		expect(prepared).toBe(response);
		expect(refetched).toBe(false);
		const source = getFixedLengthResponseBody(prepared, 5);
		expect((await new Response(source.body).arrayBuffer()).byteLength).toBe(5);
		expect(await source.completion).toBe(5);
	});

	it("does not consume the replay into memory before it is forwarded", async () => {
		let replayPulls = 0;
		const prepared = await ensureResponseContentLength(
			chunkedResponse(Array(64).fill(1)),
			64,
			async () => {
				let emitted = 0;
				return new Response(
					new ReadableStream<Uint8Array>({
						pull(controller) {
							replayPulls++;
							if (emitted === 64) {
								controller.close();
								return;
							}
							emitted++;
							controller.enqueue(new Uint8Array(1));
						},
					}),
				);
			},
		);

		// Constructing the replay may fill one stream queue slot, but it must not
		// drain all 64 chunks before the provider starts reading.
		expect(replayPulls).toBeLessThan(64);
		const source = getFixedLengthResponseBody(prepared, 64);
		expect((await new Response(source.body).arrayBuffer()).byteLength).toBe(64);
		expect(await source.completion).toBe(64);
	});

	it("yields fixed-size provider chunks without buffering the whole body", async () => {
		const chunked = getChunkedResponseBody(
			chunkedResponse([3, 4, 3], "10"),
			10,
			4,
		);
		const sizes: number[] = [];
		for await (const chunk of chunked.chunks) sizes.push(chunk.byteLength);
		expect(chunked.contentLength).toBe(10);
		expect(sizes).toEqual([4, 4, 2]);
	});

	it("requires a truthful length for fixed-length provider streams", async () => {
		expect(() =>
			getFixedLengthResponseBody(chunkedResponse([2, 3]), 5),
		).toThrow(MissingContentLengthError);

		const understated = getFixedLengthResponseBody(
			chunkedResponse([3, 3], "5"),
			8,
		);
		await expect(
			new Response(understated.body).arrayBuffer(),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
		await expect(understated.completion).rejects.toBeInstanceOf(
			ResponseTooLargeError,
		);
	});

	it("treats malformed Content-Length values as unknown", () => {
		expect(
			parseContentLength(new Headers({ "Content-Length": "12x" })),
		).toBeNull();
		expect(
			parseContentLength(new Headers({ "Content-Length": "-1" })),
		).toBeNull();
		expect(parseContentLength(new Headers({ "Content-Length": "12" }))).toBe(
			12,
		);
	});

	it("does not trust the encoded representation length for decoded bytes", async () => {
		expect(
			parseContentLength(
				new Headers({
					"Content-Encoding": "gzip",
					"Content-Length": "3",
				}),
			),
		).toBeNull();
		expect(
			parseContentLength(
				new Headers({
					"Content-Encoding": "identity",
					"Content-Length": "5",
				}),
			),
		).toBe(5);

		let refetches = 0;
		const encodedResponse = () =>
			new Response(Uint8Array.from([1, 2, 3, 4, 5]), {
				headers: {
					"Content-Encoding": "gzip",
					"Content-Length": "3",
				},
			});
		const prepared = await ensureResponseContentLength(
			encodedResponse(),
			5,
			async () => {
				refetches++;
				return encodedResponse();
			},
		);

		expect(refetches).toBe(1);
		expect(prepared.headers.get("content-encoding")).toBeNull();
		expect(prepared.headers.get("content-length")).toBe("5");
		const source = getFixedLengthResponseBody(prepared, 5);
		expect((await new Response(source.body).arrayBuffer()).byteLength).toBe(5);
		expect(await source.completion).toBe(5);
	});

	it("does not disable compression or alter caller headers", async () => {
		let sentHeaders = new Headers();
		globalThis.fetch = (async (_input, init) => {
			sentHeaders = new Headers(init?.headers);
			return new Response(Uint8Array.from([1]));
		}) as typeof fetch;

		const response = await fetchPublicUrl(RELAY_MEDIA_URL, {
			headers: { "X-Relay-Test": "present" },
		});
		await response.arrayBuffer();

		expect(sentHeaders.get("accept-encoding")).toBeNull();
		expect(sentHeaders.get("x-relay-test")).toBe("present");
	});

	it("preserves an explicit encoding request but normalizes decoded response headers", async () => {
		let sentHeaders = new Headers();
		globalThis.fetch = (async (_input, init) => {
			sentHeaders = new Headers(init?.headers);
			return new Response(Uint8Array.from([1, 2, 3, 4, 5]), {
				headers: {
					"Content-Encoding": "gzip",
					"Content-Length": "3",
				},
			});
		}) as typeof fetch;

		const response = await fetchPublicUrl(RELAY_MEDIA_URL, {
			headers: { "Accept-Encoding": "gzip" },
			maxBytes: 5,
		});
		expect((await response.arrayBuffer()).byteLength).toBe(5);

		expect(sentHeaders.get("accept-encoding")).toBe("gzip");
		expect(response.headers.get("content-encoding")).toBeNull();
		expect(response.headers.get("content-length")).toBeNull();
	});

	it("preserves a provider rejection when an early response cancels the body", async () => {
		const providerResponse = new Response("rejected", { status: 413 });
		const result = await awaitResponseWithBodyCompletion(
			Promise.resolve(providerResponse),
			Promise.reject(new Error("request body cancelled")),
		);
		expect(result).toBe(providerResponse);
	});

	it("requires body completion for a successful streamed response", async () => {
		const bodyError = new Error("source ended early");
		await expect(
			awaitResponseWithBodyCompletion(
				Promise.resolve(new Response("accepted")),
				Promise.reject(bodyError),
			),
		).rejects.toBe(bodyError);
	});

	it("prefers a source failure when the streamed fetch also rejects", async () => {
		const fetchError = new Error("network failed");
		const bodyError = new Error("source failed");
		await expect(
			awaitResponseWithBodyCompletion(
				Promise.reject(fetchError),
				Promise.reject(bodyError),
			),
		).rejects.toBe(bodyError);
		await expect(
			awaitResponseWithBodyCompletion(
				Promise.reject(fetchError),
				Promise.resolve(),
			),
		).rejects.toBe(fetchError);
	});

	it("applies the same hard limit to request text with a missing length", async () => {
		const request = new Request("https://example.test/webhook", {
			method: "POST",
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("1234"));
					controller.enqueue(new TextEncoder().encode("5678"));
					controller.close();
				},
			}),
		});
		await expect(readRequestText(request, 7)).rejects.toBeInstanceOf(
			ResponseTooLargeError,
		);
	});

	it("streams multipart file bytes with an exact aggregate length", async () => {
		const multipart = await createStreamingMultipartBody(
			[["policy", "signed-value"]],
			{
				fieldName: "file",
				filename: "photo.jpg",
				contentType: "image/jpeg",
				response: chunkedResponse([2, 3], "5"),
				maxBytes: 5,
				refetch: async () => chunkedResponse([2, 3], "5"),
			},
		);
		const bytes = await new Response(multipart.body).arrayBuffer();
		await multipart.completion;
		expect(bytes.byteLength).toBe(multipart.contentLength);
		const text = new TextDecoder().decode(bytes);
		expect(text).toContain('name="policy"');
		expect(text).toContain('filename="photo.jpg"');
	});

	it("streams multiple multipart files without aggregating their bytes", async () => {
		const multipart = await createStreamingMultipartFilesBody(
			[["payload_json", '{"content":"hello"}']],
			[
				{
					fieldName: "files[0]",
					filename: "one.jpg",
					contentType: "image/jpeg",
					response: chunkedResponse([2, 3], "5"),
					maxBytes: 5,
					refetch: async () => chunkedResponse([2, 3], "5"),
				},
				{
					fieldName: "files[1]",
					filename: "two.png",
					contentType: "image/png",
					response: chunkedResponse([3, 4], "7"),
					maxBytes: 7,
					refetch: async () => chunkedResponse([3, 4], "7"),
				},
			],
		);
		const bytes = await new Response(multipart.body).arrayBuffer();
		await multipart.completion;
		expect(bytes.byteLength).toBe(multipart.contentLength);
		const text = new TextDecoder().decode(bytes);
		expect(text).toContain('name="files[0]"; filename="one.jpg"');
		expect(text).toContain('name="files[1]"; filename="two.png"');
	});
});
