import { afterAll, describe, expect, it } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { AdReportProviderRequest } from "../schemas/ads-advanced";
import { decompressGzipIfPresent } from "../services/ad-report-jobs";
import type { AdReportRequest } from "../services/ad-report-normalization";
import { parseAdReportRows } from "../services/ad-report-normalization";

const originalDecompressionStream = Object.getOwnPropertyDescriptor(
	globalThis,
	"DecompressionStream",
);

if (typeof globalThis.DecompressionStream === "undefined") {
	class BunTestGzipDecompressionStream {
		readonly readable: ReadableStream<Uint8Array>;
		readonly writable: WritableStream<BufferSource>;

		constructor(format: CompressionFormat) {
			if (format !== "gzip")
				throw new TypeError(`Unsupported format: ${format}`);
			const chunks: Uint8Array[] = [];
			const stream = new TransformStream<BufferSource, Uint8Array>({
				transform(chunk) {
					const view =
						chunk instanceof ArrayBuffer
							? new Uint8Array(chunk)
							: new Uint8Array(
									chunk.buffer,
									chunk.byteOffset,
									chunk.byteLength,
								);
					chunks.push(view.slice());
				},
				flush(controller) {
					const size = chunks.reduce(
						(total, chunk) => total + chunk.byteLength,
						0,
					);
					const compressed = new Uint8Array(size);
					let offset = 0;
					for (const chunk of chunks) {
						compressed.set(chunk, offset);
						offset += chunk.byteLength;
					}
					controller.enqueue(new Uint8Array(gunzipSync(compressed)));
				},
			});
			this.readable = stream.readable;
			this.writable = stream.writable;
		}
	}

	Object.defineProperty(globalThis, "DecompressionStream", {
		configurable: true,
		value: BunTestGzipDecompressionStream,
	});
}

afterAll(() => {
	if (originalDecompressionStream) {
		Object.defineProperty(
			globalThis,
			"DecompressionStream",
			originalDecompressionStream,
		);
	} else {
		Reflect.deleteProperty(globalThis, "DecompressionStream");
	}
});

function chunkedText(
	value: string,
	chunkSizes: readonly number[],
): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(value);
	let offset = 0;
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.byteLength) {
				controller.close();
				return;
			}
			const size = chunkSizes[index++ % chunkSizes.length] ?? 1;
			const end = Math.min(bytes.byteLength, offset + size);
			controller.enqueue(bytes.slice(offset, end));
			offset = end;
		},
	});
}

function chunkedBytes(
	value: Uint8Array,
	chunkSizes: readonly number[],
): ReadableStream<Uint8Array> {
	let offset = 0;
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= value.byteLength) {
				controller.close();
				return;
			}
			const size = chunkSizes[index++ % chunkSizes.length] ?? 1;
			const end = Math.min(value.byteLength, offset + size);
			controller.enqueue(value.slice(offset, end));
			offset = end;
		},
	});
}

async function streamBytes(
	source: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	return new Uint8Array(await new Response(source).arrayBuffer());
}

async function collect(
	source: AsyncIterable<{
		dimensions: Record<string, unknown>;
		metrics: Record<string, string | number | null>;
	}>,
) {
	const rows = [];
	for await (const row of source) rows.push(row);
	return rows;
}

const tiktokRequest: AdReportRequest = {
	platform: "tiktok",
	report_type: "BASIC",
	data_level: "AUCTION_CAMPAIGN",
	dimensions: ["campaign_id", "campaign_name"],
	metrics: ["spend", "clicks"],
	start_date: "2026-08-01",
	end_date: "2026-08-02",
	filters: [],
	output_format: "CSV_DOWNLOAD",
};

describe("advanced ad report streaming normalization", () => {
	it("sniffs gzip magic across one-byte stream chunks without losing prefix bytes", async () => {
		const plaintext = new TextEncoder().encode('{"data":[]}');
		const compressed = new Uint8Array(gzipSync(plaintext));
		expect(
			await streamBytes(
				await decompressGzipIfPresent(chunkedBytes(compressed, [1])),
			),
		).toEqual(plaintext);
		expect(
			await streamBytes(
				await decompressGzipIfPresent(chunkedBytes(plaintext, [1, 2])),
			),
		).toEqual(plaintext);
		expect(
			await streamBytes(
				await decompressGzipIfPresent(
					chunkedBytes(new Uint8Array([0x1f]), [1]),
				),
			),
		).toEqual(new Uint8Array([0x1f]));
		expect(
			await streamBytes(
				await decompressGzipIfPresent(chunkedBytes(new Uint8Array(), [1])),
			),
		).toEqual(new Uint8Array());
	});

	it("parses chunk-split RFC4180 CSV without turning identifiers into metrics", async () => {
		const csv =
			'campaign_id,campaign_name,spend,clicks\r\n42,"Launch, ""North""",12.50,3\r\n';
		const rows = await collect(
			parseAdReportRows(chunkedText(csv, [1, 2, 5, 3]), "csv", tiktokRequest),
		);

		expect(rows).toEqual([
			{
				dimensions: {
					campaign_id: "42",
					campaign_name: 'Launch, "North"',
				},
				metrics: { spend: 12.5, clicks: 3 },
			},
		]);
	});

	it("streams X JSON envelope items and expands id_data points", async () => {
		const request: AdReportRequest = {
			platform: "twitter",
			entity: "LINE_ITEM",
			entity_ids: ["li-1"],
			start_time: "2026-08-01T00:00:00Z",
			end_time: "2026-08-02T00:00:00Z",
			granularity: "DAY",
			placement: "ALL_ON_TWITTER",
			metric_groups: ["ENGAGEMENT"],
		};
		const json = JSON.stringify({
			data: [
				{
					id: "li-1",
					id_data: [
						{
							segment: { date: "2026-08-01" },
							metrics: {
								impressions: [25, 30],
								engagements: [4, 6],
							},
						},
					],
				},
			],
		});
		const rows = await collect(
			parseAdReportRows(chunkedText(json, [2, 1, 7]), "json", request),
		);

		expect(rows).toEqual([
			{
				dimensions: {
					id: "li-1",
					segment: { date: "2026-08-01" },
					time_index: 0,
				},
				metrics: { impressions: 25, engagements: 4 },
			},
			{
				dimensions: {
					id: "li-1",
					segment: { date: "2026-08-01" },
					time_index: 1,
				},
				metrics: { impressions: 30, engagements: 6 },
			},
		]);
	});

	it("fails closed on malformed CSV width and rejects XLSX at admission", async () => {
		await expect(
			collect(
				parseAdReportRows(
					chunkedText("campaign_id,spend\n42\n", [3]),
					"csv",
					tiktokRequest,
				),
			),
		).rejects.toThrow("header width");
		expect(
			AdReportProviderRequest.safeParse({
				...tiktokRequest,
				output_format: "XLSX_DOWNLOAD",
			}).success,
		).toBe(false);
	});
});
