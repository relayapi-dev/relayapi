// apps/api/src/routes/automation-webhook-trigger.ts
//
// Public webhook endpoint for inbound automation triggers. Mounted under
// /v1/webhooks/automation-trigger/:slug (no API key auth — HMAC verification
// happens inside the receiver).

import { createDb } from "@relayapi/db";
import { Hono } from "hono";
import {
	ResponseTooLargeError,
	readRequestText,
} from "../lib/fetch-public-url";
import { receiveAutomationWebhook } from "../services/automations/webhook-receiver";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();
const MAX_AUTOMATION_WEBHOOK_BYTES = 256 * 1024;

app.post("/:slug", async (c) => {
	const slug = c.req.param("slug");
	let rawBody: string;
	try {
		rawBody = await readRequestText(c.req.raw, MAX_AUTOMATION_WEBHOOK_BYTES);
	} catch (error) {
		if (error instanceof ResponseTooLargeError) {
			return c.json(
				{
					error: {
						code: "payload_too_large",
						message: "webhook payload exceeds the 256 KiB limit",
					},
				},
				413,
			);
		}
		throw error;
	}
	const signatureHeader = c.req.header("x-relay-signature") ?? null;
	// Required replay-protection timestamp. The signature covers
	// `${timestamp}.${body}` and stale timestamps are rejected.
	const timestampHeader = c.req.header("x-relay-timestamp") ?? null;

	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const result = await receiveAutomationWebhook(
		db,
		{ slug, rawBody, signatureHeader, timestampHeader },
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
		case "stale_timestamp":
			return c.json(
				{
					error: {
						code: "stale_timestamp",
						message: "timestamp outside the allowed window",
					},
				},
				401,
			);
		case "duplicate":
			return c.json(
				{
					accepted: true,
					duplicate: true,
					status: result.receiptStatus,
					...(result.runId ? { run_id: result.runId } : {}),
				},
				202,
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
		case "enrollment_blocked":
			return c.json(
				{
					error: {
						code: "enrollment_blocked",
						message: "automation entrypoint policy blocked enrollment",
						details: { reason: result.reason },
					},
				},
				409,
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
