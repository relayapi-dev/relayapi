import { readFile } from "node:fs/promises";
import resources from "../production-resources.json";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();

function boundedInteger(
	name: string,
	fallback: number,
	maximum: number,
): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new Error(`${name} must be an integer between 1 and ${maximum}`);
	}
	return parsed;
}

async function readBoundedText(response: Response): Promise<string> {
	const declaredLength = Number.parseInt(
		response.headers.get("content-length") ?? "0",
		10,
	);
	if (declaredLength > MAX_RESPONSE_BYTES) {
		throw new Error("Production smoke response exceeded the size limit");
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_RESPONSE_BYTES) {
			await reader.cancel("response exceeded release-smoke size limit");
			throw new Error("Production smoke response exceeded the size limit");
		}
		chunks.push(value);
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => compareText(left, right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

async function request(path: string): Promise<Response> {
	const baseUrl = process.env.PRODUCTION_API_URL ?? resources.apiBaseUrl;
	const url = new URL(path, baseUrl);
	if (url.protocol !== "https:") {
		throw new Error("Production smoke target must use HTTPS");
	}
	return fetch(url, {
		headers: {
			accept: "application/json",
			"cache-control": "no-cache",
			"user-agent": "relayapi-release-smoke/1",
		},
		cache: "no-store",
		signal: AbortSignal.timeout(10_000),
	});
}

async function verifyHealth(): Promise<void> {
	const response = await request("/health");
	if (!response.ok) {
		throw new Error(`Production health check returned HTTP ${response.status}`);
	}
	const value = JSON.parse(await readBoundedText(response)) as unknown;
	if (
		!value ||
		typeof value !== "object" ||
		(value as { status?: unknown }).status !== "ok"
	) {
		throw new Error("Production health response did not satisfy its contract");
	}
}

async function verifyOpenApi(): Promise<void> {
	const [response, pinnedText] = await Promise.all([
		request("/openapi.json"),
		readFile(new URL("../../docs/openapi.json", import.meta.url), "utf8"),
	]);
	if (!response.ok) {
		throw new Error(`Production OpenAPI returned HTTP ${response.status}`);
	}
	const production = JSON.parse(await readBoundedText(response)) as unknown;
	const pinned = JSON.parse(pinnedText) as unknown;
	if (
		!production ||
		typeof production !== "object" ||
		!(production as { openapi?: unknown }).openapi ||
		!(production as { paths?: unknown }).paths
	) {
		throw new Error("Production OpenAPI response is not a valid API contract");
	}

	const [productionHash, pinnedHash] = await Promise.all(
		[production, pinned].map(async (document) => {
			const bytes = encoder.encode(JSON.stringify(canonicalize(document)));
			const digest = await crypto.subtle.digest("SHA-256", bytes);
			return Buffer.from(digest).toString("hex");
		}),
	);
	if (productionHash !== pinnedHash) {
		throw new Error(
			"Production OpenAPI contract differs from the reviewed checkout",
		);
	}
}

async function smokeProduction(): Promise<void> {
	const attempts = boundedInteger("RELEASE_SMOKE_ATTEMPTS", 12, 30);
	const delayMs = boundedInteger("RELEASE_SMOKE_DELAY_MS", 5_000, 30_000);
	const healthOnly = process.argv.includes("--health-only");
	let lastError: unknown;

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			await verifyHealth();
			if (!healthOnly) await verifyOpenApi();
			console.log(
				healthOnly
					? "Production health contract passed."
					: "Production health and OpenAPI contracts match the reviewed release.",
			);
			return;
		} catch (error) {
			lastError = error;
			if (attempt < attempts) {
				console.warn(
					`Production smoke attempt ${attempt}/${attempts} failed; retrying.`,
				);
				await Bun.sleep(delayMs);
			}
		}
	}

	throw new Error("Production release smoke checks did not converge", {
		cause: lastError,
	});
}

await smokeProduction();
