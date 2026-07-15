import { describe, expect, it } from "bun:test";
import { decryptToken } from "../lib/crypto";
import { ActionSchema } from "../schemas/automation-actions";
import type { Graph } from "../schemas/automation-graph";
import { webhookHandlers } from "../services/automations/actions/webhook";
import {
	redactAutomationGraphSecrets,
	sealAutomationGraphSecrets,
} from "../services/automations/graph-secrets";
import { simulate } from "../services/automations/simulator";
import type { RunContext } from "../services/automations/types";

const SECRETS = [
	"url-user-value",
	"url-password-value",
	"query-secret-value",
	"path-secret-value",
	"header-secret-value",
	"bearer-secret-value",
	"webhook-body-secret-value",
	"http-url-secret-value",
	"http-header-secret-value",
	"http-body-secret-value",
];

function graphWithInlineSecrets(): Graph {
	return {
		schema_version: 1,
		root_node_key: "actions",
		nodes: [
			{
				key: "actions",
				kind: "action_group",
				config: {
					actions: [
						{
							id: "action_1",
							type: "webhook_out",
							url: "https://url-user-value:url-password-value@example.com/services/path-secret-value/hook?key=query-secret-value",
							headers: { "X-Provider-Key": "header-secret-value" },
							body: '{"webhook":"webhook-body-secret-value"}',
							auth: { mode: "bearer", token: "bearer-secret-value" },
						},
					],
				},
				ports: [],
			},
			{
				key: "http",
				kind: "http_request",
				config: {
					url: "https://http.example.com/http-url-secret-value",
					method: "POST",
					headers: { "X-HTTP-Key": "http-header-secret-value" },
					body: '{"http":"http-body-secret-value"}',
				},
				ports: [],
			},
		],
		edges: [],
	};
}

function expectNoCredential(value: unknown): void {
	const serialized = JSON.stringify(value);
	for (const secret of SECRETS) expect(serialized).not.toContain(secret);
}

describe("automation graph credential redaction", () => {
	it("treats every outbound URL, including its path, as write-only", async () => {
		const inserted: Array<{
			id: string;
			ciphertext: string;
			kind: string;
		}> = [];
		const db = {
			select: () => ({ from: () => ({ where: async () => [] }) }),
			insert: () => ({
				values: (value: { id: string; ciphertext: string; kind: string }) => ({
					onConflictDoUpdate: async () => inserted.push(value),
				}),
			}),
			delete: () => ({ where: async () => undefined }),
		};
		const source = graphWithInlineSecrets();
		const node = source.nodes[0];
		if (!node) throw new Error("test graph is missing its action node");
		const action = (node.config.actions as Array<Record<string, unknown>>)[0];
		if (!action) throw new Error("test graph is missing its webhook action");
		action.url = "https://hooks.example.com/services/plain-path-token";
		action.headers = {};
		action.auth = { mode: "none" };

		const sealed = await sealAutomationGraphSecrets(
			db as unknown as Parameters<typeof sealAutomationGraphSecrets>[0],
			`test=${"22".repeat(32)}`,
			"org_test",
			"auto_test",
			source,
		);

		expectNoCredential(sealed);
		expect(JSON.stringify(sealed)).not.toContain("plain-path-token");
		expect(action.url).toContain("plain-path-token");
		expect(inserted).toHaveLength(2);
	});

	it("persists only AAD-bound ciphertext and a redacted graph", async () => {
		const inserted: Array<{
			id: string;
			ciphertext: string;
			kind: string;
		}> = [];
		const db = {
			select: () => ({
				from: () => ({ where: async () => [] }),
			}),
			insert: () => ({
				values: (value: { id: string; ciphertext: string; kind: string }) => ({
					onConflictDoUpdate: async () => {
						inserted.push(value);
					},
				}),
			}),
			delete: () => ({ where: async () => undefined }),
		};
		const encryptionKey = `test=${"11".repeat(32)}`;
		const graph = await sealAutomationGraphSecrets(
			db as unknown as Parameters<typeof sealAutomationGraphSecrets>[0],
			encryptionKey,
			"org_test",
			"auto_test",
			graphWithInlineSecrets(),
		);

		expectNoCredential(graph);
		expect(inserted).toHaveLength(2);
		const plaintextByKind = new Map<string, Record<string, unknown>>();
		for (const row of inserted) {
			expectNoCredential(row.ciphertext);
			expect(row.ciphertext).toStartWith("enc:v2:");
			const plaintext = await decryptToken(row.ciphertext, encryptionKey, {
				recordId: row.id,
				field: "credentials",
			});
			plaintextByKind.set(
				row.kind,
				JSON.parse(plaintext) as Record<string, unknown>,
			);
		}

		expect(plaintextByKind.get("webhook_out")).toEqual({
			url: "https://url-user-value:url-password-value@example.com/services/path-secret-value/hook?key=query-secret-value",
			headers: { "X-Provider-Key": "header-secret-value" },
			auth: { token: "bearer-secret-value" },
			body: '{"webhook":"webhook-body-secret-value"}',
		});
		expect(plaintextByKind.get("http_request")).toEqual({
			url: "https://http.example.com/http-url-secret-value",
			headers: { "X-HTTP-Key": "http-header-secret-value" },
			body: '{"http":"http-body-secret-value"}',
		});
	});

	it("removes URL, header, and auth values without mutating the source graph", () => {
		const source = graphWithInlineSecrets();
		const redacted = redactAutomationGraphSecrets(source);

		expectNoCredential(redacted);
		for (const secret of SECRETS)
			expect(JSON.stringify(source)).toContain(secret);
		const node = redacted.nodes[0];
		if (!node) throw new Error("test graph is missing its action node");
		const action = (node.config.actions as Array<Record<string, unknown>>)[0];
		expect(action?.credentials_configured).toBe(true);
		expect(action?.url).toBe("https://redacted.invalid/");
		expect(action?.configured_headers).toEqual(["X-Provider-Key"]);
		expect(action?.headers).toEqual({});
		expect(action?.body).toBeUndefined();
		expect(action?.body_configured).toBe(true);
		expect(action?.auth).toEqual({ mode: "bearer" });

		const httpNode = redacted.nodes.find((node) => node.key === "http");
		if (!httpNode) throw new Error("test graph is missing its HTTP node");
		expect(httpNode.config.url).toBe("https://redacted.invalid/");
		expect(httpNode.config.configured_headers).toEqual(["X-HTTP-Key"]);
		expect(httpNode.config.headers).toEqual({});
		expect(httpNode.config.body).toBeUndefined();
		expect(httpNode.config.body_configured).toBe(true);
		expect(httpNode.config.credentials_configured).toBe(true);

		const redactedAgain = redactAutomationGraphSecrets(redacted);
		const repeatedAction = (
			redactedAgain.nodes[0]?.config.actions as
				| Array<Record<string, unknown>>
				| undefined
		)?.[0];
		const repeatedHttp = redactedAgain.nodes.find(
			(node) => node.key === "http",
		);
		expect(repeatedAction?.configured_headers).toEqual(["X-Provider-Key"]);
		expect(repeatedHttp?.config.configured_headers).toEqual(["X-HTTP-Key"]);
	});

	it("clears individual stored fields without clearing the destination", async () => {
		type StoredSecret = {
			id: string;
			organizationId: string;
			automationId: string;
			nodeKey: string;
			actionId: string;
			kind: string;
			ciphertext: string;
		};
		const rows: StoredSecret[] = [];
		const db = {
			select: () => ({ from: () => ({ where: async () => rows }) }),
			insert: () => ({
				values: (value: StoredSecret) => ({
					onConflictDoUpdate: async () => {
						const index = rows.findIndex((row) => row.id === value.id);
						if (index === -1) rows.push(value);
						else rows[index] = { ...rows[index], ...value };
					},
				}),
			}),
			delete: () => ({ where: async () => undefined }),
		};
		const encryptionKey = `test=${"33".repeat(32)}`;
		const sealed = await sealAutomationGraphSecrets(
			db as unknown as Parameters<typeof sealAutomationGraphSecrets>[0],
			encryptionKey,
			"org_test",
			"auto_test",
			graphWithInlineSecrets(),
		);

		const sealedActionNode = sealed.nodes[0];
		if (!sealedActionNode)
			throw new Error("test graph is missing its action node");
		const action = (
			sealedActionNode.config.actions as Array<Record<string, unknown>>
		)[0];
		if (!action) throw new Error("test graph is missing its webhook action");
		action.configured_headers = [];
		action.body_configured = false;
		action.auth = { mode: "none" };
		const http = sealed.nodes.find((node) => node.key === "http");
		if (!http) throw new Error("test graph is missing its HTTP node");
		http.config.configured_headers = [];
		http.config.body_configured = false;

		const resealed = await sealAutomationGraphSecrets(
			db as unknown as Parameters<typeof sealAutomationGraphSecrets>[0],
			encryptionKey,
			"org_test",
			"auto_test",
			sealed,
		);

		for (const row of rows) {
			const plaintext = JSON.parse(
				await decryptToken(row.ciphertext, encryptionKey, {
					recordId: row.id,
					field: "credentials",
				}),
			) as Record<string, unknown>;
			expect(plaintext).toEqual(
				expect.objectContaining({
					url: expect.any(String),
				}),
			);
			expect(plaintext.headers).toBeUndefined();
			expect(plaintext.body).toBeUndefined();
			if (row.kind === "webhook_out") {
				expect(plaintext.auth).toBeUndefined();
			}
		}
		const resealedActionNode = resealed.nodes[0];
		if (!resealedActionNode)
			throw new Error("test graph is missing its action node");
		const resealedAction = (
			resealedActionNode.config.actions as Array<Record<string, unknown>>
		)[0];
		expect(resealedAction?.configured_headers).toEqual([]);
		expect(resealedAction?.body_configured).toBe(false);
		expect(resealedAction?.credentials_configured).toBe(true);
		expect(http.config.credentials_configured).toBe(true);
	});

	it("keeps simulation payloads free of inline credentials", async () => {
		const result = await simulate({
			graph: redactAutomationGraphSecrets(graphWithInlineSecrets()),
		});
		expectNoCredential(result);
		expect(result.steps[0]?.payload).toBeDefined();
	});

	it("fails inline execution without copying credentials into run payloads", async () => {
		const graph = graphWithInlineSecrets();
		const node = graph.nodes[0];
		if (!node) throw new Error("test graph is missing its action node");
		const rawAction = (
			node.config.actions as Array<Record<string, unknown>>
		)[0];
		const action = ActionSchema.parse(rawAction);
		const context = {
			runId: "run_test",
			automationId: "auto_test",
			organizationId: "org_test",
			contactId: "contact_test",
			conversationId: null,
			channel: "telegram",
			graph,
			context: {},
			now: new Date(0),
			db: {} as RunContext["db"],
			env: {},
		} satisfies RunContext;
		let errorMessage = "";
		try {
			const handler = webhookHandlers.webhook_out as unknown as (
				value: typeof action,
				ctx: RunContext,
			) => Promise<void>;
			await handler(action, context);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}
		const persistedRunPayload = {
			action_results: [{ id: action.id, ok: false, error: errorMessage }],
		};
		expectNoCredential(persistedRunPayload);
		expect(errorMessage).toBe(
			"webhook_out: inline credentials must be sealed before execution",
		);
	});
});
