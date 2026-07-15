import { describe, expect, it } from "bun:test";
import {
	createYouTubeUploadBody,
	getYouTubeUploadRangeHeader,
	parseYouTubeUploadOffset,
} from "../publishers/youtube";

async function readAll(body: ReadableStream<Uint8Array>): Promise<number[]> {
	const reader = body.getReader();
	const output: number[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return output;
		output.push(...value);
	}
}

describe("YouTube resumable upload", () => {
	it("parses the provider's zero-based committed range", () => {
		expect(parseYouTubeUploadOffset(null, 10)).toBe(0);
		expect(parseYouTubeUploadOffset("bytes=0-3", 10)).toBe(4);
		expect(() => parseYouTubeUploadOffset("bytes=2-3", 10)).toThrow(
			"invalid resumable upload range",
		);
		expect(() => parseYouTubeUploadOffset("bytes=0-10", 10)).toThrow(
			"out-of-bounds resumable upload range",
		);
	});

	it("sends Content-Range even when a resume query committed zero bytes", () => {
		expect(getYouTubeUploadRangeHeader(10, 0, false)).toBeUndefined();
		expect(getYouTubeUploadRangeHeader(10, 0, true)).toBe("bytes 0-9/10");
		expect(getYouTubeUploadRangeHeader(10, 4, true)).toBe("bytes 4-9/10");
	});

	it("streams only the suffix not already committed by YouTube", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(Uint8Array.from([0, 1, 2]));
					controller.enqueue(Uint8Array.from([3, 4, 5, 6]));
					controller.enqueue(Uint8Array.from([7, 8, 9]));
					controller.close();
				},
			}),
			{ headers: { "content-length": "10" } },
		);

		const upload = createYouTubeUploadBody(response, 10, 4);
		expect(upload.contentLength).toBe(6);
		expect(await readAll(upload.body)).toEqual([4, 5, 6, 7, 8, 9]);
		expect(await upload.completion).toBe(10);
	});

	it("rejects a changed source before resuming", () => {
		const response = new Response(Uint8Array.from([0, 1, 2]), {
			headers: { "content-length": "3" },
		});
		expect(() => createYouTubeUploadBody(response, 4, 1)).toThrow(
			"Video size changed",
		);
	});
});
