import { automationSecrets, type Database, generateId } from "@relayapi/db";
import { and, eq, notInArray } from "drizzle-orm";
import {
	activeEncryptionKeyId,
	decryptToken,
	encryptToken,
} from "../../lib/crypto";
import type { Graph } from "../../schemas/automation-graph";

const REDACTED_URL = "https://redacted.invalid/";

type SecretDb = Pick<Database, "select" | "insert" | "delete">;

export interface WebhookSecretBundle {
	url?: string;
	headers?: Record<string, string>;
	body?: string;
	auth?: {
		token?: string;
		username?: string;
		password?: string;
		secret?: string;
	};
}

export type HttpRequestSecretBundle = Pick<
	WebhookSecretBundle,
	"url" | "headers" | "body"
>;

export class AutomationSecretInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AutomationSecretInputError";
	}
}

function cloneGraph(graph: Graph): Graph {
	return structuredClone(graph);
}

function webhookActions(graph: Graph): Array<{
	nodeKey: string;
	action: Record<string, unknown>;
}> {
	const actions: Array<{
		nodeKey: string;
		action: Record<string, unknown>;
	}> = [];
	for (const node of graph.nodes) {
		if (node.kind !== "action_group") continue;
		const configured = (node.config as { actions?: unknown }).actions;
		if (!Array.isArray(configured)) continue;
		for (const value of configured) {
			if (
				value &&
				typeof value === "object" &&
				(value as { type?: unknown }).type === "webhook_out"
			) {
				actions.push({
					nodeKey: node.key,
					action: value as Record<string, unknown>,
				});
			}
		}
	}
	return actions;
}

function httpRequestNodes(graph: Graph): Array<{
	nodeKey: string;
	config: Record<string, unknown>;
}> {
	return graph.nodes
		.filter((node) => node.kind === "http_request")
		.map((node) => ({
			nodeKey: node.key,
			config: node.config as Record<string, unknown>,
		}));
}

function sanitizeUrl(value: unknown): {
	storedUrl: string;
	secretUrl?: string;
} {
	if (typeof value !== "string" || value === REDACTED_URL) {
		return { storedUrl: REDACTED_URL };
	}
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new Error("unsupported webhook URL protocol");
		}
		// Treat the complete destination as write-only. Provider credentials are
		// routinely embedded in path segments, subdomains, and fragments—not only
		// userinfo/query parameters—so no portion belongs in graph JSON or run data.
		return { storedUrl: REDACTED_URL, secretUrl: value };
	} catch {
		return { storedUrl: REDACTED_URL, secretUrl: value };
	}
}

function isOnlyRedactedUrl(value: unknown): boolean {
	return value === REDACTED_URL;
}

function configuredHeaderNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((name): name is string => typeof name === "string")
		.sort();
}

function redactAction(action: Record<string, unknown>): void {
	const headers =
		action.headers && typeof action.headers === "object"
			? (action.headers as Record<string, unknown>)
			: {};
	const auth =
		action.auth && typeof action.auth === "object"
			? (action.auth as Record<string, unknown>)
			: { mode: "none" };
	const sensitiveAuth = ["token", "username", "password", "secret"].some(
		(key) => typeof auth[key] === "string" && auth[key] !== "",
	);
	const sanitizedUrl = sanitizeUrl(action.url);
	const bodyConfigured =
		typeof action.body === "string" && action.body.length > 0;
	const inlineHeaderNames = Object.keys(headers).sort();
	action.url = sanitizedUrl.storedUrl;
	action.headers = {};
	action.configured_headers =
		inlineHeaderNames.length > 0
			? inlineHeaderNames
			: configuredHeaderNames(action.configured_headers);
	delete action.body;
	action.body_configured = Boolean(action.body_configured || bodyConfigured);
	action.auth = { mode: typeof auth.mode === "string" ? auth.mode : "none" };
	action.credentials_configured = Boolean(
		action.secret_ref ||
			Object.keys(headers).length > 0 ||
			sensitiveAuth ||
			sanitizedUrl.secretUrl ||
			bodyConfigured,
	);
	delete action.clear_credentials;
}

function redactHttpRequest(config: Record<string, unknown>): void {
	const headers =
		config.headers && typeof config.headers === "object"
			? (config.headers as Record<string, unknown>)
			: {};
	const bodyConfigured =
		typeof config.body === "string" && config.body.length > 0;
	const sanitizedUrl = sanitizeUrl(config.url);
	const inlineHeaderNames = Object.keys(headers).sort();
	config.url = sanitizedUrl.storedUrl;
	config.headers = {};
	config.configured_headers =
		inlineHeaderNames.length > 0
			? inlineHeaderNames
			: configuredHeaderNames(config.configured_headers);
	delete config.body;
	config.body_configured = Boolean(config.body_configured || bodyConfigured);
	config.credentials_configured = Boolean(
		config.secret_ref ||
			sanitizedUrl.secretUrl ||
			Object.keys(headers).length > 0 ||
			bodyConfigured,
	);
	delete config.clear_credentials;
}

/** Defense-in-depth serializer that never exposes write-only graph fields. */
export function redactAutomationGraphSecrets(graph: Graph): Graph {
	const redacted = cloneGraph(graph);
	for (const { action } of webhookActions(redacted)) redactAction(action);
	for (const { config } of httpRequestNodes(redacted))
		redactHttpRequest(config);
	return redacted;
}

/**
 * Move all write-only webhook credentials out of a graph in one DB preload.
 * The returned graph is safe to persist and serialize.
 */
export async function sealAutomationGraphSecrets(
	db: SecretDb,
	encryptionKey: string,
	organizationId: string,
	automationId: string,
	graph: Graph,
): Promise<Graph> {
	const sealed = cloneGraph(graph);
	const existingRows = await db
		.select()
		.from(automationSecrets)
		.where(
			and(
				eq(automationSecrets.organizationId, organizationId),
				eq(automationSecrets.automationId, automationId),
			),
		);
	const byId = new Map(existingRows.map((row) => [row.id, row]));
	const byAction = new Map(
		existingRows.map((row) => [`${row.nodeKey}\u0000${row.actionId}`, row]),
	);
	const retainedIds: string[] = [];

	for (const { nodeKey, action } of webhookActions(sealed)) {
		const actionId =
			typeof action.id === "string" && action.id !== ""
				? action.id
				: generateId("act_");
		action.id = actionId;
		const suppliedRef =
			typeof action.secret_ref === "string" ? action.secret_ref : null;
		const existing = suppliedRef
			? byId.get(suppliedRef)
			: byAction.get(`${nodeKey}\u0000${actionId}`);
		if (
			existing &&
			(existing.organizationId !== organizationId ||
				existing.automationId !== automationId ||
				existing.nodeKey !== nodeKey ||
				existing.actionId !== actionId ||
				existing.kind !== "webhook_out")
		) {
			throw new AutomationSecretInputError(
				"automation secret reference does not belong to this action",
			);
		}
		if (suppliedRef && !existing) {
			throw new AutomationSecretInputError(
				"automation secret reference was not found",
			);
		}

		if (action.clear_credentials === true) {
			action.url = REDACTED_URL;
			action.headers = {};
			delete action.body;
			action.body_configured = false;
			const currentAuth =
				action.auth && typeof action.auth === "object"
					? (action.auth as Record<string, unknown>)
					: {};
			action.auth = {
				mode: typeof currentAuth.mode === "string" ? currentAuth.mode : "none",
			};
			delete action.secret_ref;
			redactAction(action);
			action.credentials_configured = false;
			continue;
		}

		const rawHeaders =
			action.headers && typeof action.headers === "object"
				? Object.fromEntries(
						Object.entries(action.headers as Record<string, unknown>).filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === "string" && entry[1] !== "",
						),
					)
				: {};
		const rawAuth =
			action.auth && typeof action.auth === "object"
				? (action.auth as Record<string, unknown>)
				: {};
		const authSecrets = Object.fromEntries(
			["token", "username", "password", "secret"]
				.map((key) => [key, rawAuth[key]])
				.filter(
					(entry): entry is [string, string] =>
						typeof entry[1] === "string" && entry[1] !== "",
				),
		);
		const sanitizedUrl = sanitizeUrl(action.url);
		const rawBody =
			typeof action.body === "string" && action.body.length > 0
				? action.body
				: undefined;
		const newSecretUrl = isOnlyRedactedUrl(action.url)
			? undefined
			: sanitizedUrl.secretUrl;
		const clearHeaders =
			Array.isArray(action.configured_headers) &&
			configuredHeaderNames(action.configured_headers).length === 0 &&
			Object.keys(rawHeaders).length === 0;
		const clearBody = action.body_configured === false && rawBody === undefined;
		const clearAuth =
			rawAuth.mode === "none" && Object.keys(authSecrets).length === 0;
		const hasNewSecret =
			Object.keys(rawHeaders).length > 0 ||
			Object.keys(authSecrets).length > 0 ||
			Boolean(newSecretUrl) ||
			Boolean(rawBody);
		const hasSecretMutation =
			hasNewSecret || clearHeaders || clearBody || clearAuth;

		if (hasSecretMutation) {
			const secretId = existing?.id ?? generateId("asec_");
			let previous: WebhookSecretBundle = {};
			if (existing) {
				const plaintext = await decryptToken(
					existing.ciphertext,
					encryptionKey,
					{ recordId: existing.id, field: "credentials" },
				);
				previous = JSON.parse(plaintext) as WebhookSecretBundle;
			}
			const bundle: WebhookSecretBundle = {
				...(newSecretUrl
					? { url: newSecretUrl }
					: previous.url
						? { url: previous.url }
						: {}),
				...(Object.keys(rawHeaders).length > 0
					? { headers: rawHeaders }
					: clearHeaders
						? {}
						: previous.headers
							? { headers: previous.headers }
							: {}),
				...(Object.keys(authSecrets).length > 0
					? { auth: authSecrets }
					: clearAuth
						? {}
						: previous.auth
							? { auth: previous.auth }
							: {}),
				...(rawBody
					? { body: rawBody }
					: clearBody
						? {}
						: previous.body
							? { body: previous.body }
							: {}),
			};
			const ciphertext = await encryptToken(
				JSON.stringify(bundle),
				encryptionKey,
				{ recordId: secretId, field: "credentials" },
			);
			await db
				.insert(automationSecrets)
				.values({
					id: secretId,
					organizationId,
					automationId,
					nodeKey,
					actionId,
					kind: "webhook_out",
					ciphertext,
					keyId: activeEncryptionKeyId(encryptionKey),
				})
				.onConflictDoUpdate({
					target: automationSecrets.id,
					set: {
						ciphertext,
						keyId: activeEncryptionKeyId(encryptionKey),
						updatedAt: new Date(),
					},
				});
			action.secret_ref = secretId;
			retainedIds.push(secretId);
		} else if (existing) {
			action.secret_ref = existing.id;
			retainedIds.push(existing.id);
		} else {
			delete action.secret_ref;
		}
		redactAction(action);
	}

	for (const { nodeKey, config } of httpRequestNodes(sealed)) {
		const actionId = nodeKey;
		const suppliedRef =
			typeof config.secret_ref === "string" ? config.secret_ref : null;
		const existing = suppliedRef
			? byId.get(suppliedRef)
			: byAction.get(`${nodeKey}\u0000${actionId}`);
		if (
			existing &&
			(existing.organizationId !== organizationId ||
				existing.automationId !== automationId ||
				existing.nodeKey !== nodeKey ||
				existing.actionId !== actionId ||
				existing.kind !== "http_request")
		) {
			throw new AutomationSecretInputError(
				"automation secret reference does not belong to this HTTP request",
			);
		}
		if (suppliedRef && !existing) {
			throw new AutomationSecretInputError(
				"automation HTTP request secret reference was not found",
			);
		}

		if (config.clear_credentials === true) {
			delete config.secret_ref;
			config.url = REDACTED_URL;
			config.headers = {};
			delete config.body;
			config.body_configured = false;
			redactHttpRequest(config);
			config.credentials_configured = false;
			continue;
		}

		const rawHeaders =
			config.headers && typeof config.headers === "object"
				? Object.fromEntries(
						Object.entries(config.headers as Record<string, unknown>).filter(
							(entry): entry is [string, string] =>
								typeof entry[1] === "string" && entry[1] !== "",
						),
					)
				: {};
		const sanitizedUrl = sanitizeUrl(config.url);
		const newSecretUrl = isOnlyRedactedUrl(config.url)
			? undefined
			: sanitizedUrl.secretUrl;
		const rawBody =
			typeof config.body === "string" && config.body.length > 0
				? config.body
				: undefined;
		const clearHeaders =
			Array.isArray(config.configured_headers) &&
			configuredHeaderNames(config.configured_headers).length === 0 &&
			Object.keys(rawHeaders).length === 0;
		const clearBody = config.body_configured === false && rawBody === undefined;
		const hasNewSecret =
			Boolean(newSecretUrl) ||
			Object.keys(rawHeaders).length > 0 ||
			Boolean(rawBody);
		const hasSecretMutation = hasNewSecret || clearHeaders || clearBody;

		if (hasSecretMutation) {
			const secretId = existing?.id ?? generateId("asec_");
			let previous: HttpRequestSecretBundle = {};
			if (existing) {
				const plaintext = await decryptToken(
					existing.ciphertext,
					encryptionKey,
					{ recordId: existing.id, field: "credentials" },
				);
				previous = JSON.parse(plaintext) as HttpRequestSecretBundle;
			}
			const bundle: HttpRequestSecretBundle = {
				...(newSecretUrl
					? { url: newSecretUrl }
					: previous.url
						? { url: previous.url }
						: {}),
				...(Object.keys(rawHeaders).length > 0
					? { headers: rawHeaders }
					: clearHeaders
						? {}
						: previous.headers
							? { headers: previous.headers }
							: {}),
				...(rawBody
					? { body: rawBody }
					: clearBody
						? {}
						: previous.body
							? { body: previous.body }
							: {}),
			};
			if (!bundle.url) {
				throw new AutomationSecretInputError(
					"http_request requires a destination URL",
				);
			}
			const ciphertext = await encryptToken(
				JSON.stringify(bundle),
				encryptionKey,
				{ recordId: secretId, field: "credentials" },
			);
			await db
				.insert(automationSecrets)
				.values({
					id: secretId,
					organizationId,
					automationId,
					nodeKey,
					actionId,
					kind: "http_request",
					ciphertext,
					keyId: activeEncryptionKeyId(encryptionKey),
				})
				.onConflictDoUpdate({
					target: automationSecrets.id,
					set: {
						ciphertext,
						keyId: activeEncryptionKeyId(encryptionKey),
						updatedAt: new Date(),
					},
				});
			config.secret_ref = secretId;
			retainedIds.push(secretId);
		} else if (existing) {
			config.secret_ref = existing.id;
			retainedIds.push(existing.id);
		} else {
			throw new AutomationSecretInputError(
				"http_request requires write-only request configuration",
			);
		}
		redactHttpRequest(config);
	}

	await db
		.delete(automationSecrets)
		.where(
			and(
				eq(automationSecrets.organizationId, organizationId),
				eq(automationSecrets.automationId, automationId),
				...(retainedIds.length > 0
					? [notInArray(automationSecrets.id, retainedIds)]
					: []),
			),
		);
	return sealed;
}

export async function loadAutomationWebhookSecret(
	db: Pick<Database, "select">,
	encryptionKey: string,
	params: {
		id: string;
		organizationId: string;
		automationId: string;
		actionId: string;
	},
): Promise<WebhookSecretBundle> {
	const [row] = await db
		.select({ ciphertext: automationSecrets.ciphertext })
		.from(automationSecrets)
		.where(
			and(
				eq(automationSecrets.id, params.id),
				eq(automationSecrets.organizationId, params.organizationId),
				eq(automationSecrets.automationId, params.automationId),
				eq(automationSecrets.actionId, params.actionId),
			),
		)
		.limit(1);
	if (!row) throw new Error("webhook_out: credential reference is unavailable");
	const plaintext = await decryptToken(row.ciphertext, encryptionKey, {
		recordId: params.id,
		field: "credentials",
	});
	const parsed = JSON.parse(plaintext) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("webhook_out: credential reference is invalid");
	}
	return parsed as WebhookSecretBundle;
}

export async function loadAutomationHttpRequestSecret(
	db: Pick<Database, "select">,
	encryptionKey: string,
	params: {
		id: string;
		organizationId: string;
		automationId: string;
		nodeKey: string;
	},
): Promise<HttpRequestSecretBundle> {
	const [row] = await db
		.select({ ciphertext: automationSecrets.ciphertext })
		.from(automationSecrets)
		.where(
			and(
				eq(automationSecrets.id, params.id),
				eq(automationSecrets.organizationId, params.organizationId),
				eq(automationSecrets.automationId, params.automationId),
				eq(automationSecrets.nodeKey, params.nodeKey),
				eq(automationSecrets.actionId, params.nodeKey),
				eq(automationSecrets.kind, "http_request"),
			),
		)
		.limit(1);
	if (!row)
		throw new Error("http_request: credential reference is unavailable");
	const plaintext = await decryptToken(row.ciphertext, encryptionKey, {
		recordId: params.id,
		field: "credentials",
	});
	const parsed = JSON.parse(plaintext) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("http_request: credential reference is invalid");
	}
	return parsed as HttpRequestSecretBundle;
}
