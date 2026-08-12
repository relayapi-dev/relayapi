const DEFAULT_TIMEOUT_MS = 30_000;

export interface BoundedFetchOptions {
	label: string;
	maxBytes: number;
	timeoutMs?: number;
	fetcher?: typeof fetch;
}

function boundedLength(response: Response): number | undefined {
	const header = response.headers.get("content-length");
	if (!header) return undefined;
	const value = Number(header);
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export async function fetchBounded(
	input: string | URL,
	init: RequestInit,
	options: BoundedFetchOptions,
): Promise<{ response: Response; bytes: Uint8Array }> {
	const fetcher = options.fetcher ?? fetch;
	let response: Response;
	try {
		const deadline = AbortSignal.timeout(
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
		response = await fetcher(input, {
			...init,
			signal: init.signal
				? AbortSignal.any([init.signal, deadline])
				: deadline,
		});
	} catch (error) {
		const timedOut =
			error instanceof Error &&
			(error.name === "TimeoutError" || error.name === "AbortError");
		throw new Error(
			timedOut
				? `${options.label} timed out`
				: `${options.label} could not be completed`,
			{ cause: error },
		);
	}

	const declaredLength = boundedLength(response);
	if (declaredLength !== undefined && declaredLength > options.maxBytes) {
		await response.body?.cancel();
		throw new Error(`${options.label} exceeded ${options.maxBytes} bytes`);
	}

	const reader = response.body?.getReader();
	if (!reader) return { response, bytes: new Uint8Array() };
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		size += chunk.value.byteLength;
		if (size > options.maxBytes) {
			await reader.cancel();
			throw new Error(`${options.label} exceeded ${options.maxBytes} bytes`);
		}
		chunks.push(chunk.value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { response, bytes };
}

export function parseJsonBytes<T>(bytes: Uint8Array, label: string): T {
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as T;
	} catch (error) {
		throw new Error(`${label} returned malformed JSON`, { cause: error });
	}
}
