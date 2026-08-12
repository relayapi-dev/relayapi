import { idempotencyReceipts } from "@relayapi/db";
import { and, eq, lte } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { decryptToken, encryptToken } from "../lib/crypto";
import {
	createBoundedReadableBody,
	parseContentLength,
	ResponseTooLargeError,
	readResponseBytes,
} from "../lib/fetch-public-url";
import type { Env, Variables } from "../types";

const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_STREAMED_REPLAY_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_RESPONSE_BYTES = 1024 * 1024;
const KEY_RE = /^[A-Za-z0-9._:-]{8,255}$/;

export function replayBodyForStatus(
	status: number,
	body: string,
): string | null {
	return status === 204 || status === 205 || status === 304 ? null : body;
}

function bytesToHex(value: ArrayBuffer): string {
	return Array.from(new Uint8Array(value), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
	const input =
		typeof value === "string" ? new TextEncoder().encode(value) : value;
	return bytesToHex(await crypto.subtle.digest("SHA-256", input));
}

type ReceiptAuthorization = Pick<
	Variables,
	"orgId" | "keyId" | "permissions" | "workspaceScope"
>;

/**
 * Keep the existing receipt table while making its route namespace specific to
 * the authenticated principal and its current authorization boundary. This
 * prevents a second key in the same organization (or a key whose permissions
 * or workspace scope changed) from receiving a response produced under a
 * different authorization context.
 *
 * The fingerprint is deliberately one-way: receipt rows do not expose API-key
 * IDs or permission/workspace metadata. There is no legacy-route fallback
 * because the service is pre-launch and an unscoped replay would be unsafe.
 */
export async function bindReceiptRoute(
	method: string,
	route: string,
	authorization: ReceiptAuthorization,
): Promise<string> {
	const permissions = [...new Set(authorization.permissions)].sort();
	const workspaceScope =
		authorization.workspaceScope === "all"
			? "all"
			: [...new Set(authorization.workspaceScope)].sort();
	const authorizationHash = await sha256Hex(
		JSON.stringify({
			method,
			organizationId: authorization.orgId,
			principalId: authorization.keyId,
			permissions,
			workspaceScope,
		}),
	);
	return `${route}\nrelay-authorization:${authorizationHash}`;
}

function resourceIdFromBody(text: string): string | null {
	try {
		const body = JSON.parse(text) as Record<string, unknown>;
		for (const key of [
			"id",
			"post_id",
			"thread_group_id",
			"broadcast_id",
			"delivery_id",
		]) {
			if (typeof body[key] === "string") return body[key];
		}
	} catch {
		// Non-JSON responses have no extractable resource id.
	}
	return null;
}

function isReplayableStatus(status: number): boolean {
	return status >= 200 && status < 500 && ![408, 425, 429].includes(status);
}

export function isExplicitlyRetryableConflict(response: Response): boolean {
	return (
		response.status === 409 &&
		response.headers.get("Idempotency-Retryable") === "true" &&
		response.headers.has("Retry-After")
	);
}

type DigestTracker = {
	digest: Promise<string>;
	request: Request;
};

/** Drain an ignored/replayed request with backpressure and no body accumulation. */
async function drainRequestBody(request: Request): Promise<void> {
	if (!request.body || request.bodyUsed) return;
	const reader = request.body.getReader();
	try {
		while (!(await reader.read()).done) {
			// Reading the tracked stream advances the digest one bounded chunk at a time.
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Hash a request while the route consumes it. DigestStream preserves
 * backpressure and avoids retaining the media body in isolate memory.
 */
export function trackRequestDigest(request: Request): DigestTracker {
	const declaredBytes = parseContentLength(request.headers);
	if (
		declaredBytes !== null &&
		declaredBytes > MAX_STREAMED_REPLAY_REQUEST_BYTES
	) {
		void request.body?.cancel().catch(() => {});
		throw new ResponseTooLargeError(
			MAX_STREAMED_REPLAY_REQUEST_BYTES,
			declaredBytes,
		);
	}
	if (!request.body) {
		return {
			digest: sha256Hex(new ArrayBuffer(0)),
			request,
		};
	}

	const bounded = createBoundedReadableBody(
		request.body,
		MAX_STREAMED_REPLAY_REQUEST_BYTES,
		declaredBytes,
	);
	let writeDigest: (chunk: Uint8Array) => Promise<void>;
	let closeDigest: () => Promise<void>;
	let abortDigest: (reason: unknown) => Promise<void>;
	let digestValue: Promise<ArrayBuffer>;
	if (typeof DigestStream !== "undefined") {
		const digestStream = new DigestStream("SHA-256");
		const digestWriter = digestStream.getWriter();
		writeDigest = (chunk) => digestWriter.write(chunk);
		closeDigest = () => digestWriter.close();
		abortDigest = async (reason) => {
			await digestWriter.abort(reason);
		};
		digestValue = digestStream.digest;
	} else {
		// Bun's unit-test runtime does not expose the Workers DigestStream. This
		// bounded branch is exercised outside Workers; deployed requests use the
		// native streaming branch above.
		const chunks: Uint8Array[] = [];
		let total = 0;
		let resolveDigest!: (value: ArrayBuffer) => void;
		let rejectDigest!: (reason: unknown) => void;
		digestValue = new Promise<ArrayBuffer>((resolve, reject) => {
			resolveDigest = resolve;
			rejectDigest = reject;
		});
		writeDigest = async (chunk) => {
			const copy = chunk.slice();
			chunks.push(copy);
			total += copy.byteLength;
		};
		closeDigest = async () => {
			const bytes = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			resolveDigest(await crypto.subtle.digest("SHA-256", bytes));
		};
		abortDigest = async (reason) => rejectDigest(reason);
	}
	const reader = bounded.body.getReader();
	const routeBody = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					await closeDigest();
					controller.close();
					return;
				}
				await writeDigest(value);
				controller.enqueue(value);
			} catch (error) {
				await abortDigest(error).catch(() => {});
				controller.error(error);
			}
		},
		async cancel(reason) {
			await Promise.allSettled([reader.cancel(reason), abortDigest(reason)]);
		},
	});
	const digest = Promise.all([bounded.bytesRead, digestValue]).then(
		([, value]) => bytesToHex(value),
	);
	void digest.catch(() => {});

	const init = {
		body: routeBody,
		// Node-compatible test runtimes require this for streamed request bodies;
		// Workers ignores the extra field.
		duplex: "half",
	} as RequestInit & { duplex: "half" };
	return { digest, request: new Request(request, init) };
}

async function markUnknown(
	db: Variables["db"],
	receiptId: string,
	message: string,
): Promise<void> {
	await db
		.update(idempotencyReceipts)
		.set({
			state: "unknown",
			lastError: message.slice(0, 1_000),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(idempotencyReceipts.id, receiptId),
				eq(idempotencyReceipts.state, "in_progress"),
			),
		);
}

async function expireProvenNotApplied(
	db: Variables["db"],
	receiptId: string,
	requestHash?: string,
): Promise<void> {
	await db
		.update(idempotencyReceipts)
		.set({
			...(requestHash ? { requestHash } : {}),
			expiresAt: new Date(),
			updatedAt: new Date(),
			lastError: "mutation effect was proven not applied",
		})
		.where(
			and(
				eq(idempotencyReceipts.id, receiptId),
				eq(idempotencyReceipts.state, "in_progress"),
			),
		);
}

/** Durable replay protection for authenticated mutations. */
export const idempotencyMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (
		c.req.method === "GET" ||
		c.req.method === "HEAD" ||
		c.req.method === "OPTIONS"
	) {
		await next();
		return;
	}

	const key = c.req.header("idempotency-key");
	if (!key) {
		await next();
		return;
	}
	if (!KEY_RE.test(key)) {
		return c.json(
			{
				error: {
					code: "INVALID_IDEMPOTENCY_KEY",
					message: "Idempotency-Key must be 8-255 safe ASCII characters.",
				},
			},
			400,
		);
	}

	const orgId = c.get("orgId");
	const db = c.get("db");
	const method = c.req.method.toUpperCase();
	const url = new URL(c.req.url);
	url.searchParams.sort();
	const route = await bindReceiptRoute(method, `${url.pathname}${url.search}`, {
		orgId,
		keyId: c.get("keyId"),
		permissions: c.get("permissions"),
		workspaceScope: c.get("workspaceScope"),
	});
	const routeHash = await sha256Hex(route);

	let bodyDigest: Promise<string>;
	try {
		if (c.req.raw.bodyUsed) {
			// The bounded body cache seeded arrayBuffer first, so JSON and allowlisted
			// multipart requests are hashed without decoding or reserialization.
			bodyDigest = sha256Hex(await c.req.arrayBuffer());
		} else {
			const tracked = trackRequestDigest(c.req.raw);
			c.req.raw = tracked.request;
			bodyDigest = tracked.digest;
		}
	} catch (error) {
		if (error instanceof ResponseTooLargeError) {
			return c.json(
				{
					error: {
						code: "PAYLOAD_TOO_LARGE",
						message: "Request body exceeds the 64 MiB API limit.",
					},
				},
				413,
			);
		}
		throw error;
	}

	// For a new streamed request, reserve the key before route/provider I/O.
	// The final byte digest replaces this marker after the route consumes the
	// stream. Existing completed requests are fully digested before replay.
	const provisionalHash = await sha256Hex(
		JSON.stringify({ method, route, state: "streaming" }),
	);
	const now = new Date();
	const inserted = await db
		.insert(idempotencyReceipts)
		.values({
			organizationId: orgId,
			method,
			route,
			routeHash,
			idempotencyKey: key,
			requestHash: provisionalHash,
			expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS),
		})
		.onConflictDoUpdate({
			target: [
				idempotencyReceipts.organizationId,
				idempotencyReceipts.method,
				idempotencyReceipts.routeHash,
				idempotencyReceipts.idempotencyKey,
			],
			set: {
				requestHash: provisionalHash,
				state: "in_progress",
				resourceId: null,
				responseStatus: null,
				responseBodyCiphertext: null,
				responseContentType: null,
				createdAt: now,
				completedAt: null,
				updatedAt: now,
				lastError: null,
				expiresAt: new Date(now.getTime() + RECEIPT_TTL_MS),
			},
			setWhere: lte(idempotencyReceipts.expiresAt, now),
		})
		.returning({ id: idempotencyReceipts.id });

	if (inserted.length === 0) {
		const [existing] = await db
			.select()
			.from(idempotencyReceipts)
			.where(
				and(
					eq(idempotencyReceipts.organizationId, orgId),
					eq(idempotencyReceipts.method, method),
					eq(idempotencyReceipts.routeHash, routeHash),
					eq(idempotencyReceipts.route, route),
					eq(idempotencyReceipts.idempotencyKey, key),
				),
			)
			.limit(1);
		if (!existing) {
			throw new Error("Idempotency receipt conflict could not be loaded");
		}
		if (existing.state === "completed") {
			// A replay never reaches the route, so drain/hash its bounded body now.
			await drainRequestBody(c.req.raw);
			const rawDigest = await bodyDigest;
			const requestHash = await sha256Hex(
				JSON.stringify({ method, route, rawDigest }),
			);
			if (existing.requestHash !== requestHash) {
				return c.json(
					{
						error: {
							code: "IDEMPOTENCY_KEY_REUSED",
							message:
								"This Idempotency-Key was already used with a different request.",
						},
					},
					409,
				);
			}
			if (existing.responseStatus != null && existing.responseBodyCiphertext) {
				const responseBody = await decryptToken(
					existing.responseBodyCiphertext,
					c.env.ENCRYPTION_KEY,
					{ recordId: existing.id, field: "response_body" },
				);
				return new Response(
					replayBodyForStatus(existing.responseStatus, responseBody),
					{
						status: existing.responseStatus,
						headers: {
							"Content-Type":
								existing.responseContentType ?? "application/json",
							"Idempotency-Replayed": "true",
						},
					},
				);
			}
		}
		return c.json(
			{
				error: {
					code:
						existing.state === "unknown"
							? "IDEMPOTENCY_OUTCOME_UNKNOWN"
							: "IDEMPOTENCY_IN_PROGRESS",
					message:
						existing.state === "unknown"
							? "The original operation may have completed and requires reconciliation."
							: "The original operation is still in progress.",
				},
			},
			409,
			{ "Retry-After": "2" },
		);
	}

	const receiptId = inserted[0]?.id;
	if (!receiptId) throw new Error("Idempotency receipt was not returned");
	try {
		await next();
		// Routes that intentionally ignore a body still need a final digest.
		await drainRequestBody(c.req.raw);
		const rawDigest = await bodyDigest;
		const requestHash = await sha256Hex(
			JSON.stringify({ method, route, rawDigest }),
		);
		if (isExplicitlyRetryableConflict(c.res)) {
			// The route has already persisted a durable domain operation and is
			// explicitly asking the caller to resume it. Release only this outer
			// HTTP replay receipt; the domain operation remains the idempotency and
			// provider-reconciliation authority.
			await db
				.update(idempotencyReceipts)
				.set({
					requestHash,
					expiresAt: new Date(),
					updatedAt: new Date(),
					lastError: "retry delegated to durable domain operation",
				})
				.where(
					and(
						eq(idempotencyReceipts.id, receiptId),
						eq(idempotencyReceipts.state, "in_progress"),
					),
				);
			c.res.headers.set("Idempotency-Replayed", "false");
			return;
		}

		if (!isReplayableStatus(c.res.status)) {
			if (c.get("mutationEffectTracker")?.isProvenNotApplied()) {
				await expireProvenNotApplied(db, receiptId, requestHash);
				c.res.headers.set("Idempotency-Replayed", "false");
				return;
			}
			await db
				.update(idempotencyReceipts)
				.set({
					requestHash,
					state: "unknown",
					responseStatus: c.res.status,
					lastError: "response class is not safe to replay",
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(idempotencyReceipts.id, receiptId),
						eq(idempotencyReceipts.state, "in_progress"),
					),
				);
			c.res.headers.set("Idempotency-Replayed", "false");
			return;
		}

		let responseBody: string;
		try {
			const responseBytes = await readResponseBytes(
				c.res.clone(),
				MAX_REPLAY_RESPONSE_BYTES,
			);
			responseBody = new TextDecoder().decode(responseBytes);
		} catch (error) {
			await markUnknown(
				db,
				receiptId,
				error instanceof Error
					? error.message
					: "response could not be retained",
			);
			c.res.headers.set("Idempotency-Replayed", "false");
			return;
		}

		const encryptedBody = await encryptToken(
			responseBody,
			c.env.ENCRYPTION_KEY,
			{ recordId: receiptId, field: "response_body" },
		);
		await db
			.update(idempotencyReceipts)
			.set({
				requestHash,
				state: "completed",
				responseStatus: c.res.status,
				responseBodyCiphertext: encryptedBody,
				responseContentType: c.res.headers.get("content-type"),
				resourceId: resourceIdFromBody(responseBody),
				completedAt: new Date(),
				updatedAt: new Date(),
				lastError: null,
			})
			.where(
				and(
					eq(idempotencyReceipts.id, receiptId),
					eq(idempotencyReceipts.state, "in_progress"),
				),
			);
		c.res.headers.set("Idempotency-Replayed", "false");
	} catch (error) {
		if (c.get("mutationEffectTracker")?.isProvenNotApplied()) {
			await expireProvenNotApplied(db, receiptId);
		} else {
			await markUnknown(
				db,
				receiptId,
				error instanceof Error ? error.message : "request handler failed",
			);
		}
		throw error;
	}
});
