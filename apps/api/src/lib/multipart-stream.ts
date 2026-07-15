import {
	ensureResponseContentLength,
	getFixedLengthResponseBody,
	type ResponseRefetch,
} from "./fetch-public-url";

export interface StreamingMultipartFile {
	fieldName: string;
	filename: string;
	contentType: string;
	response: Response;
	maxBytes: number;
	refetch: ResponseRefetch;
}

export interface StreamingMultipartBody {
	body: ReadableStream<Uint8Array>;
	contentType: string;
	contentLength: number;
	completion: Promise<void>;
}

function escapeDispositionValue(value: string): string {
	return value.replace(/[\r\n]/g, " ").replace(/["\\]/g, "_");
}

/**
 * Construct a single-file multipart/form-data body without creating a Blob of
 * the media. Prefix/suffix metadata is tiny; file bytes retain source-to-origin
 * backpressure. FixedLengthStream makes Workers emit the calculated length.
 */
export async function createStreamingMultipartBody(
	fields: Iterable<readonly [string, string]>,
	file: StreamingMultipartFile,
): Promise<StreamingMultipartBody> {
	return createStreamingMultipartFilesBody(fields, [file]);
}

/**
 * Construct a bounded multi-file multipart body. Source bodies remain streamed
 * and retain backpressure; only the small field and disposition headers are
 * materialized in memory.
 */
export async function createStreamingMultipartFilesBody(
	fields: Iterable<readonly [string, string]>,
	files: readonly StreamingMultipartFile[],
): Promise<StreamingMultipartBody> {
	const boundary = `relayapi-${crypto.randomUUID()}`;
	const encoder = new TextEncoder();
	const entries: Array<
		| { kind: "bytes"; bytes: Uint8Array }
		| { kind: "stream"; reader: ReadableStreamDefaultReader<Uint8Array> }
	> = [];
	const sourceCompletions: Promise<number>[] = [];
	let contentLength = 0;
	let fieldsText = "";
	for (const [name, value] of fields) {
		fieldsText += `--${boundary}\r\nContent-Disposition: form-data; name="${escapeDispositionValue(name)}"\r\n\r\n${value}\r\n`;
	}
	if (fieldsText) {
		const fieldBytes = encoder.encode(fieldsText);
		entries.push({ kind: "bytes", bytes: fieldBytes });
		contentLength += fieldBytes.byteLength;
	}

	try {
		for (const file of files) {
			const header = encoder.encode(
				`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="${escapeDispositionValue(file.fieldName)}"; filename="${escapeDispositionValue(file.filename)}"\r\n` +
					`Content-Type: ${file.contentType.replace(/[\r\n]/g, "")}\r\n\r\n`,
			);
			const response = await ensureResponseContentLength(
				file.response,
				file.maxBytes,
				file.refetch,
			);
			const source = getFixedLengthResponseBody(response, file.maxBytes);
			const trailer = encoder.encode("\r\n");
			entries.push(
				{ kind: "bytes", bytes: header },
				{ kind: "stream", reader: source.body.getReader() },
				{ kind: "bytes", bytes: trailer },
			);
			sourceCompletions.push(source.completion);
			contentLength +=
				header.byteLength + source.contentLength + trailer.byteLength;
		}
	} catch (error) {
		await Promise.all(
			entries
				.filter(
					(
						entry,
					): entry is {
						kind: "stream";
						reader: ReadableStreamDefaultReader<Uint8Array>;
					} => entry.kind === "stream",
				)
				.map((entry) => entry.reader.cancel(error).catch(() => {})),
		);
		throw error;
	}

	const suffix = encoder.encode(`--${boundary}--\r\n`);
	entries.push({ kind: "bytes", bytes: suffix });
	contentLength += suffix.byteLength;
	let entryIndex = 0;

	const combined = new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				const entry = entries[entryIndex];
				if (!entry) {
					controller.close();
					return;
				}
				if (entry.kind === "bytes") {
					entryIndex++;
					controller.enqueue(entry.bytes);
					return;
				}
				const { done, value } = await entry.reader.read();
				if (done) {
					entryIndex++;
					continue;
				}
				controller.enqueue(value);
				return;
			}
		},
		async cancel(reason) {
			await Promise.all(
				entries
					.slice(entryIndex)
					.filter(
						(
							entry,
						): entry is {
							kind: "stream";
							reader: ReadableStreamDefaultReader<Uint8Array>;
						} => entry.kind === "stream",
					)
					.map((entry) => entry.reader.cancel(reason).catch(() => {})),
			);
		},
	});

	let body = combined;
	let outerCompletion: Promise<void> = Promise.resolve();
	if (typeof FixedLengthStream !== "undefined") {
		const fixed = new FixedLengthStream(contentLength);
		outerCompletion = combined.pipeTo(fixed.writable);
		void outerCompletion.catch(() => {});
		body = fixed.readable;
	}
	const completion = Promise.all([outerCompletion, ...sourceCompletions]).then(
		() => undefined,
	);
	void completion.catch(() => {});

	return {
		body,
		contentType: `multipart/form-data; boundary=${boundary}`,
		contentLength,
		completion,
	};
}
