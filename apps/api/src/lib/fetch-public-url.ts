import { fetchWithTimeout } from "./fetch-timeout";
import { isBlockedUrlWithDns, isRelayR2PresignedUrl } from "./ssrf-guard";

export class ResponseTooLargeError extends Error {
	readonly maxBytes: number;
	readonly declaredBytes?: number;

	constructor(maxBytes: number, declaredBytes?: number) {
		super(
			declaredBytes === undefined
				? `Response body exceeded the ${maxBytes}-byte limit`
				: `Response declared ${declaredBytes} bytes, exceeding the ${maxBytes}-byte limit`,
		);
		this.name = "ResponseTooLargeError";
		this.maxBytes = maxBytes;
		this.declaredBytes = declaredBytes;
	}
}

export class MissingContentLengthError extends Error {
	constructor() {
		super("A valid Content-Length header is required for this streamed upload");
		this.name = "MissingContentLengthError";
	}
}

export interface BoundedReadableBody {
	body: ReadableStream<Uint8Array>;
	/** Resolves to the bytes actually consumed when the stream reaches EOF. */
	bytesRead: Promise<number>;
}

export interface FixedLengthResponseBody extends BoundedReadableBody {
	contentLength: number;
	/** Includes both source-limit and FixedLengthStream completion checks. */
	completion: Promise<number>;
}

export interface ChunkedResponseBody {
	contentLength: number;
	chunks: AsyncIterable<Uint8Array<ArrayBuffer>>;
}

export type ResponseRefetch = () => Promise<Response>;

/**
 * Await both an outgoing streamed request and its local source pipeline. A
 * provider's non-success response is authoritative even when it stops reading
 * and cancels the body; a successful response is valid only if the whole local
 * body completed.
 */
export async function awaitResponseWithBodyCompletion(
	responsePromise: Promise<Response>,
	completion: Promise<unknown>,
): Promise<Response> {
	const [responseOutcome, completionOutcome] = await Promise.allSettled([
		responsePromise,
		completion,
	]);
	if (responseOutcome.status === "rejected") {
		throw completionOutcome.status === "rejected"
			? completionOutcome.reason
			: responseOutcome.reason;
	}
	if (responseOutcome.value.ok && completionOutcome.status === "rejected") {
		throw completionOutcome.reason;
	}
	return responseOutcome.value;
}

function hasNonIdentityContentEncoding(headers: Headers): boolean {
	const raw = headers.get("content-encoding");
	if (!raw) return false;
	const encodings = raw
		.split(",")
		.map((encoding) => encoding.trim().toLowerCase())
		.filter(Boolean);
	return encodings.some((encoding) => encoding !== "identity");
}

/**
 * A fetched response body exposed to JavaScript is decoded by the runtime. Its
 * origin Content-Length still describes the encoded representation, so remove
 * both representation headers before counting or forwarding decoded bytes.
 */
function normalizeDecodedResponse(response: Response): Response {
	if (!hasNonIdentityContentEncoding(response.headers)) return response;

	const headers = new Headers(response.headers);
	headers.delete("content-encoding");
	headers.delete("content-length");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * Parse a trustworthy numeric Content-Length value. Malformed, negative, and
 * unsafe values, plus lengths for encoded representations whose exposed body
 * is decoded, are treated as unknown and must still be enforced while streaming.
 */
export function parseContentLength(headers: Headers): number | null {
	if (hasNonIdentityContentEncoding(headers)) return null;
	const raw = headers.get("content-length")?.trim();
	if (!raw || !/^\d+$/.test(raw)) return null;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Reject an oversized declared body before any bytes are read. */
export function assertResponseSize(response: Response, maxBytes: number): void {
	const declaredBytes = parseContentLength(response.headers);
	if (declaredBytes !== null && declaredBytes > maxBytes) {
		void response.body?.cancel().catch(() => {});
		throw new ResponseTooLargeError(maxBytes, declaredBytes);
	}
}

/**
 * Wrap a body in a counting stream. This is the enforcement layer for absent,
 * zero, malformed, compressed, or dishonest Content-Length headers.
 */
export function createBoundedReadableBody(
	source: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	declaredBytes: number | null = null,
): BoundedReadableBody {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError("maxBytes must be a non-negative safe integer");
	}
	if (declaredBytes !== null && declaredBytes > maxBytes) {
		void source?.cancel().catch(() => {});
		throw new ResponseTooLargeError(maxBytes, declaredBytes);
	}

	if (!source) {
		return {
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			bytesRead: Promise.resolve(0),
		};
	}

	const reader = source.getReader();
	let total = 0;
	let settled = false;
	let resolveBytes!: (value: number) => void;
	let rejectBytes!: (reason: Error) => void;
	const bytesRead = new Promise<number>((resolve, reject) => {
		resolveBytes = resolve;
		rejectBytes = reject;
	});
	// A downstream consumer observes the stream error. Mark this companion
	// promise handled immediately so cancellation cannot create a floating
	// rejection before the caller awaits it.
	void bytesRead.catch(() => {});

	const resolveOnce = () => {
		if (settled) return;
		settled = true;
		resolveBytes(total);
	};
	const rejectOnce = (reason: unknown) => {
		if (settled) return;
		settled = true;
		rejectBytes(
			reason instanceof Error ? reason : new Error("Body stream was cancelled"),
		);
	};

	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					resolveOnce();
					controller.close();
					return;
				}

				const nextTotal = total + value.byteLength;
				if (nextTotal > maxBytes) {
					const error = new ResponseTooLargeError(maxBytes);
					rejectOnce(error);
					await reader.cancel(error).catch(() => {});
					controller.error(error);
					return;
				}

				total = nextTotal;
				controller.enqueue(value);
			} catch (error) {
				rejectOnce(error);
				controller.error(error);
			}
		},
		async cancel(reason) {
			rejectOnce(reason);
			await reader.cancel(reason).catch(() => {});
		},
	});

	return { body, bytesRead };
}

/** Return a pass-through body that errors as soon as the hard limit is crossed. */
export function getBoundedResponseBody(
	response: Response,
	maxBytes: number,
): ReadableStream<Uint8Array> {
	assertResponseSize(response, maxBytes);
	return createBoundedReadableBody(
		response.body,
		maxBytes,
		parseContentLength(response.headers),
	).body;
}

/**
 * Obtain a trustworthy length for provider protocols that require it before
 * accepting any bytes. Unknown-length sources are measured with O(1) memory,
 * then fetched again so the measured size can be supplied while the second
 * response streams to the provider. The common declared-length path performs
 * no extra read or request.
 */
export async function ensureResponseContentLength(
	response: Response,
	maxBytes: number,
	refetch: ResponseRefetch,
): Promise<Response> {
	response = normalizeDecodedResponse(response);
	assertResponseSize(response, maxBytes);
	const declaredBytes = parseContentLength(response.headers);
	if (declaredBytes !== null && declaredBytes > 0) return response;

	const measured = createBoundedReadableBody(response.body, maxBytes);
	const reader = measured.body.getReader();
	try {
		for (;;) {
			const { done } = await reader.read();
			if (done) break;
		}
		await measured.bytesRead;
	} catch (error) {
		await measured.bytesRead.catch(() => {});
		throw error;
	}

	const contentLength = await measured.bytesRead;
	if (contentLength <= 0) {
		throw new MissingContentLengthError();
	}

	const replay = normalizeDecodedResponse(await refetch());
	if (!replay.ok) {
		void replay.body?.cancel().catch(() => {});
		throw new Error(
			`Media source re-fetch failed with HTTP ${replay.status} ${replay.statusText}`,
		);
	}
	assertResponseSize(replay, maxBytes);
	const replayDeclaredBytes = parseContentLength(replay.headers);
	if (
		replayDeclaredBytes !== null &&
		replayDeclaredBytes > 0 &&
		replayDeclaredBytes !== contentLength
	) {
		void replay.body?.cancel().catch(() => {});
		throw new Error(
			`Media source length changed from ${contentLength} to ${replayDeclaredBytes} bytes while preparing the upload`,
		);
	}

	// The measured value is enforced again while the replay is forwarded, so a
	// source that changes without declaring its new size fails at the boundary.
	const headers = new Headers(replay.headers);
	headers.set("content-length", String(contentLength));
	return new Response(replay.body, {
		status: replay.status,
		statusText: replay.statusText,
		headers,
	});
}

/**
 * Prepare a remote response for a provider endpoint that requires a known
 * Content-Length. In Workers, FixedLengthStream makes the runtime emit that
 * header while retaining streaming backpressure. The fallback keeps unit
 * tests and non-Workers runtimes functional.
 */
export function getFixedLengthResponseBody(
	response: Response,
	maxBytes: number,
): FixedLengthResponseBody {
	assertResponseSize(response, maxBytes);
	const contentLength = parseContentLength(response.headers);
	if (contentLength === null || contentLength <= 0) {
		void response.body?.cancel().catch(() => {});
		throw new MissingContentLengthError();
	}

	const bounded = createBoundedReadableBody(
		response.body,
		Math.min(maxBytes, contentLength),
		contentLength,
	);
	let body = bounded.body;
	let pipeCompletion: Promise<void> = Promise.resolve();
	if (typeof FixedLengthStream !== "undefined") {
		const fixed = new FixedLengthStream(contentLength);
		pipeCompletion = bounded.body.pipeTo(fixed.writable);
		void pipeCompletion.catch(() => {});
		body = fixed.readable;
	}

	const completion = Promise.all([pipeCompletion, bounded.bytesRead]).then(
		([, bytesRead]) => {
			if (bytesRead !== contentLength) {
				throw new Error(
					`Response body length ${bytesRead} did not match declared length ${contentLength}`,
				);
			}
			return bytesRead;
		},
	);
	void completion.catch(() => {});
	return { body, bytesRead: bounded.bytesRead, contentLength, completion };
}

/**
 * Split a known-length response into small sequential upload parts. Only one
 * output part is retained at a time, so peak media memory is O(chunkBytes), not
 * O(contentLength).
 */
export function getChunkedResponseBody(
	response: Response,
	maxBytes: number,
	chunkBytes: number | readonly number[],
): ChunkedResponseBody {
	assertResponseSize(response, maxBytes);
	const contentLength = parseContentLength(response.headers);
	if (contentLength === null || contentLength <= 0) {
		void response.body?.cancel().catch(() => {});
		throw new MissingContentLengthError();
	}
	const partSizes: number[] = [];
	if (typeof chunkBytes === "number") {
		if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
			throw new RangeError("chunkBytes must be a positive safe integer");
		}
		for (
			let remaining = contentLength;
			remaining > 0;
			remaining -= chunkBytes
		) {
			partSizes.push(Math.min(chunkBytes, remaining));
		}
	} else {
		let total = 0;
		for (const partSize of chunkBytes) {
			if (!Number.isSafeInteger(partSize) || partSize <= 0) {
				throw new RangeError(
					"Every response part size must be a positive safe integer",
				);
			}
			partSizes.push(partSize);
			total += partSize;
		}
		if (total !== contentLength) {
			void response.body?.cancel().catch(() => {});
			throw new Error(
				`Provider part sizes total ${total} bytes, expected ${contentLength}`,
			);
		}
	}

	// Enforce the declared size as well as the platform ceiling. A source that
	// understates its length must fail before bytes beyond the initialized upload
	// are forwarded to the provider.
	const bounded = createBoundedReadableBody(
		response.body,
		Math.min(maxBytes, contentLength),
		contentLength,
	);

	const chunks = (async function* (): AsyncGenerator<Uint8Array<ArrayBuffer>> {
		const reader = bounded.body.getReader();
		let partIndex = 0;
		let output = new Uint8Array(partSizes[partIndex] ?? 1);
		let outputOffset = 0;
		let completed = false;

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				let inputOffset = 0;
				while (inputOffset < value.byteLength) {
					const copyBytes = Math.min(
						output.byteLength - outputOffset,
						value.byteLength - inputOffset,
					);
					output.set(
						value.subarray(inputOffset, inputOffset + copyBytes),
						outputOffset,
					);
					inputOffset += copyBytes;
					outputOffset += copyBytes;
					if (outputOffset === output.byteLength) {
						yield output;
						partIndex++;
						output = new Uint8Array(partSizes[partIndex] ?? 1);
						outputOffset = 0;
					}
				}
			}

			if (outputOffset > 0 || partIndex !== partSizes.length) {
				throw new Error(
					"Response ended before all provider upload parts were filled",
				);
			}
			const bytesRead = await bounded.bytesRead;
			if (bytesRead !== contentLength) {
				throw new Error(
					`Response body length ${bytesRead} did not match declared length ${contentLength}`,
				);
			}
			completed = true;
		} finally {
			if (!completed) {
				await reader
					.cancel("Provider upload stopped before EOF")
					.catch(() => {});
				await bounded.bytesRead.catch(() => {});
			}
		}
	})();

	return { contentLength, chunks };
}

async function readBoundedStreamBytes(
	source: ReadableStream<Uint8Array> | null,
	maxBytes: number,
	declaredBytes: number | null,
): Promise<ArrayBuffer> {
	const bounded = createBoundedReadableBody(source, maxBytes, declaredBytes);
	const reader = bounded.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
		}
		await bounded.bytesRead;
	} catch (error) {
		await bounded.bytesRead.catch(() => {});
		throw error;
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes.buffer;
}

/**
 * Read a response into memory with both declared-length and streamed limits.
 * Buffered callers should keep maxBytes small: concatenation has a worst-case
 * transient allocation below 2 * maxBytes plus one source chunk.
 */
export async function readResponseBytes(
	response: Response,
	maxBytes: number,
): Promise<ArrayBuffer> {
	assertResponseSize(response, maxBytes);
	return readBoundedStreamBytes(
		response.body,
		maxBytes,
		parseContentLength(response.headers),
	);
}

/** Parse JSON only after enforcing a small declared and streamed byte limit. */
export async function readResponseJson<T = unknown>(
	response: Response,
	maxBytes: number,
): Promise<T> {
	const bytes = await readResponseBytes(response, maxBytes);
	return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** Bounded request-body reader for webhook/text endpoints. */
export async function readRequestBytes(
	request: Request,
	maxBytes: number,
): Promise<ArrayBuffer> {
	const declaredBytes = parseContentLength(request.headers);
	if (declaredBytes !== null && declaredBytes > maxBytes) {
		void request.body?.cancel().catch(() => {});
		throw new ResponseTooLargeError(maxBytes, declaredBytes);
	}
	return readBoundedStreamBytes(request.body, maxBytes, declaredBytes);
}

/** Decode a request only after the byte-limited reader reaches EOF. */
export async function readRequestText(
	request: Request,
	maxBytes: number,
): Promise<string> {
	return new TextDecoder().decode(await readRequestBytes(request, maxBytes));
}

export async function fetchPublicUrl(
	url: string | URL,
	init: RequestInit & {
		timeout?: number;
		timeoutThroughBody?: boolean;
		maxBytes?: number;
	} = {},
): Promise<Response> {
	const urlString = url instanceof URL ? url.toString() : url;
	const timeout = init.timeout ?? 30_000;
	const callerSignal = init.signal ?? undefined;
	const overallDeadline = init.timeoutThroughBody
		? AbortSignal.timeout(timeout)
		: null;
	const signal = overallDeadline
		? callerSignal
			? AbortSignal.any([callerSignal, overallDeadline])
			: overallDeadline
		: callerSignal;
	if (
		!isRelayR2PresignedUrl(urlString) &&
		(await isBlockedUrlWithDns(urlString, { signal }))
	) {
		throw new Error("Blocked public URL");
	}

	const { maxBytes, ...fetchInit } = init;
	const response = normalizeDecodedResponse(
		await fetchWithTimeout(urlString, {
			...fetchInit,
			redirect: "error",
			signal,
			timeout,
		}),
	);
	if (maxBytes === undefined) return response;

	assertResponseSize(response, maxBytes);
	const body = getBoundedResponseBody(response, maxBytes);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
