import { describe, expect, it } from "bun:test";
import { getPlatformProperties } from "../src/internal/detect-platform";
import { toFile } from "../src/internal/to-file";
import { createForm } from "../src/internal/uploads";

describe("SDK runtime detection", () => {
	it("detects Cloudflare Workers before a nodejs_compat process shim", () => {
		const headers = getPlatformProperties({
			navigator: { userAgent: "Cloudflare-Workers" },
			process: {
				[Symbol.toStringTag]: "process",
				arch: "x64",
				platform: "linux",
				version: "v24.0.0",
			},
		});

		expect(headers).toMatchObject({
			"X-Stainless-OS": "Unknown",
			"X-Stainless-Arch": "unknown",
			"X-Stainless-Runtime": "edge",
			"X-Stainless-Runtime-Version": "unknown",
		});
	});

	it("does not require a Node process in an edge runtime", () => {
		const headers = getPlatformProperties({ edgeRuntime: "vercel-edge" });

		expect(headers["X-Stainless-Runtime"]).toBe("edge");
		expect(headers["X-Stainless-Runtime-Version"]).toBe("unknown");
	});
});

describe("SDK multipart encoding", () => {
	it("preserves the default nested bracket format", async () => {
		const form = await createForm(
			{
				metadata: { caption: "hello", flags: [true, false] },
				files: [new File(["image"], "image.txt", { type: "text/plain" })],
			},
			fetch,
		);

		expect(Array.from(form.keys())).toEqual([
			"metadata[caption]",
			"metadata[flags][]",
			"metadata[flags][]",
			"files[]",
		]);
		expect(form.getAll("metadata[flags][]")).toEqual(["true", "false"]);
	});

	it("supports dotted objects and indexed or repeated arrays", async () => {
		const indexed = await createForm(
			{
				metadata: { items: [{ label: "first" }, { label: "second" }] },
			},
			fetch,
			{ objectFormat: "dots", arrayFormat: "indices" },
		);
		const repeated = await createForm({ tags: ["one", "two"] }, fetch, {
			arrayFormat: "repeat",
		});

		expect(Array.from(indexed.entries())).toEqual([
			["metadata.items[0].label", "first"],
			["metadata.items[1].label", "second"],
		]);
		expect(repeated.getAll("tags")).toEqual(["one", "two"]);
	});

	it("normalizes structurally compatible blobs from another runtime", async () => {
		const bytes = new TextEncoder().encode("portable");
		const foreignBlob = {
			name: "portable.txt",
			size: bytes.byteLength,
			type: "text/plain",
			async arrayBuffer() {
				return bytes.buffer.slice(0);
			},
		};

		const form = await createForm({ file: foreignBlob }, fetch);
		const file = form.get("file");

		expect(file).toBeInstanceOf(File);
		expect((file as File).name).toBe("portable.txt");
		expect((file as File).type).toStartWith("text/plain");
		expect(await (file as File).text()).toBe("portable");
	});
});

describe("SDK async upload chunks", () => {
	it("accepts supported chunk types and preserves their bytes", async () => {
		async function* chunks() {
			yield new Uint8Array([65]);
			yield new Blob(["B"], { type: "text/plain" });
		}

		const file = await toFile(chunks(), "letters.txt");

		expect(await file.text()).toBe("AB");
		expect(file.type).toStartWith("text/plain");
	});

	it("rejects an unsupported chunk with its position", async () => {
		async function* chunks(): AsyncIterable<any> {
			yield new Uint8Array([65]);
			yield { bytes: [66] };
		}

		expect(toFile(chunks(), "invalid.bin")).rejects.toThrow(
			"Invalid async iterable chunk at index 1",
		);
	});
});
