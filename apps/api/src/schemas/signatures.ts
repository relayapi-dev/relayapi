import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// --- Create signature ---

export const CreateSignatureBody = z.object({
	name: z.string().min(1).max(200).describe("Signature name"),
	content: z.string().min(1).max(2000).describe("Signature text"),
	is_default: z.boolean().default(false).describe("Set as the default signature"),
	position: z.enum(["append", "prepend"]).default("append").describe("Where to inject the signature"),
	workspace_id: z.string().optional().describe("Workspace ID to scope this signature to"),
});

// --- Update signature ---

export const UpdateSignatureBody = z.object({
	name: z.string().min(1).max(200).optional().describe("Signature name"),
	content: z.string().min(1).max(2000).optional().describe("Signature text"),
	is_default: z.boolean().optional().describe("Set as the default signature"),
	position: z.enum(["append", "prepend"]).optional().describe("Where to inject the signature"),
});

// --- Signature response ---

export const SignatureResponse = z.object({
	id: z.string().describe("Signature ID"),
	name: z.string().describe("Signature name"),
	content: z.string().describe("Signature text"),
	is_default: z.boolean().describe("Whether this is the default signature"),
	position: z.enum(["append", "prepend"]).describe("Injection position"),
	workspace_id: z.string().nullable().describe("Workspace ID"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

// --- Paginated list ---

export const SignatureListResponse = paginatedResponse(SignatureResponse);
