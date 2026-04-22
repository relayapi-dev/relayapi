// apps/api/src/routes/automation-webhook-trigger.ts
//
// Public webhook endpoint for inbound automation triggers. Mounted under
// /v1/webhooks/automation-trigger/:slug (no API key auth — HMAC verification
// happens inside the receiver).

import { createDb } from "@relayapi/db";
import { Hono } from "hono";
import type { Env } from "../types";
import { receiveAutomationWebhook } from "../services/automations/webhook-receiver";

const app = new Hono<{ Bindings: Env }>();

app.post("/:slug", async (c) => {
	const slug = c.req.param("slug");
	const rawBody = await c.req.text();
	const signatureHeader = c.req.header("x-relay-signature") ?? null;

	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const result = await receiveAutomationWebhook(
		db,
		{ slug, rawBody, signatureHeader },
		c.env as unknown as Record<string, unknown>,
	);

	switch (result.status) {
		case "ok":
			return c.json(
				{
					run_id: result.runId,
					automation_id: result.automationId,
				},
				202,
			);
		case "bad_signature":
			return c.json(
				{
					error: {
						code: "bad_signature",
						message: "signature verification failed",
					},
				},
				401,
			);
		case "unknown_slug":
			return c.json(
				{
					error: {
						code: "not_found",
						message: "webhook slug not found",
					},
				},
				404,
			);
		case "bad_payload":
			return c.json(
				{
					error: { code: "bad_payload", message: result.error },
				},
				400,
			);
		case "contact_lookup_failed":
			return c.json(
				{
					error: {
						code: "contact_lookup_failed",
						message:
							result.reason === "no_default_workspace"
								? "organization has no workspace to anchor a new contact"
								: "could not resolve contact",
						...(result.reason ? { details: { reason: result.reason } } : {}),
					},
				},
				422,
			);
		case "enrollment_failed":
			return c.json(
				{
					error: {
						code: "enrollment_failed",
						message: result.error,
					},
				},
				500,
			);
	}
});

export default app;
