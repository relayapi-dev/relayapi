import { describe, expect, it } from "bun:test";
import { createSnapchatMultipartPart } from "../publishers/snapchat";

describe("Snapchat encrypted multipart streaming", () => {
	it("streams multiple cipher outputs as one exact-length multipart part", async () => {
		const multipart = createSnapchatMultipartPart("media.mp4", 3, [
			Uint8Array.from([1, 2, 3]),
			Uint8Array.from([4, 5]),
		]);
		const bytes = new Uint8Array(
			await new Response(multipart.body).arrayBuffer(),
		);
		await multipart.completion;

		expect(bytes.byteLength).toBe(multipart.contentLength);
		const text = new TextDecoder().decode(bytes);
		expect(text).toContain('name="action"\r\n\r\nADD');
		expect(text).toContain('name="part_number"\r\n\r\n3');
		expect(text).toContain('filename="media.mp4"');
		expect(Array.from(bytes).join(",")).toContain("1,2,3,4,5");
	});

	it("does not restore whole-part Blob buffering", async () => {
		const source = await Bun.file(
			`${import.meta.dir}/../publishers/snapchat.ts`,
		).text();
		expect(source).not.toContain("new Blob");
		expect(source).not.toContain("joinCiphertext");
	});
});
