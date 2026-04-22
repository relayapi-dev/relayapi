// apps/api/src/services/automations/input-resume.ts
//
// Resumes a `waiting` run that is parked at an `input` node when an inbound
// message arrives. Validates the inbound text against the input node's
// config, chooses the port (`captured` / `invalid` / `skip`) or re-prompts on
// retry, then updates the run and re-enters `runLoop` so the chosen edge can
// be walked.
//
// The `timeout` port is NOT driven from here — that's the scheduler's job
// (see `scheduler.ts`, `input_timeout`). Wait/resume/timeout semantics match
// spec §8.6.

import { automationRuns, automations, type Database } from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Graph } from "../../schemas/automation-graph";
import { runLoop } from "./runner";

export type InputResumeOutcome =
	| { port: "captured"; capturedValue: unknown }
	| { port: "invalid" }
	| { port: "skip" }
	| { port: "retry" };

/**
 * Attachment metadata captured from the inbound message. Populated by the
 * per-platform normalizers (Instagram / Facebook / WhatsApp / Telegram).
 * Platforms that only expose a URL still populate `url` — mime/size
 * validation simply won't trigger for them in v1.
 */
export type AttachmentInput = {
	id?: string;
	url?: string;
	filename?: string;
	mime_type?: string;
	size_bytes?: number;
} | null;

export type InputConfig = {
	field?: string;
	input_type?: "text" | "email" | "phone" | "number" | "choice" | "file";
	choices?: Array<{ value: string; label: string; match?: string[] }>;
	validation?: { pattern?: string; min?: number; max?: number };
	timeout_min?: number;
	max_retries?: number;
	skip_allowed?: boolean;
	/**
	 * Only applies when `input_type === "file"`. If provided and non-empty,
	 * the inbound attachment's `mime_type` must match one of these values
	 * exactly (case-sensitive, matching the Meta/Twilio convention).
	 */
	accepted_mime_types?: string[];
	/**
	 * Only applies when `input_type === "file"`. If provided, the inbound
	 * attachment's `size_bytes` must be at most this many megabytes
	 * (1 MB == 1024 * 1024 bytes). Missing sizes are accepted — platforms
	 * that don't surface size (e.g. Instagram media) can't be size-gated.
	 */
	max_size_mb?: number;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose phone validator — accepts international + / digits / spaces / dashes /
// parens, at least 7 digits/graphemes. Strict validation happens at send time.
const PHONE_RE = /^[+]?[\d\s\-()]{7,}$/;

/**
 * Pure decision function — given a node config, an inbound message, and the
 * current retry count, pick a port or decide to retry. No I/O.
 *
 * Retry semantics: a config's `max_retries` counts the TOTAL number of
 * attempts. With `max_retries: 2`, the first failure retries (count 0 → 1),
 * the second failure exits through `invalid` (count would be 2, which equals
 * max_retries).
 */
export function resolveInputResume(
	config: InputConfig,
	inboundText: string,
	attachment: AttachmentInput,
	retryCount: number,
): InputResumeOutcome {
	const trimmed = (inboundText ?? "").trim();
	const maxRetries = config.max_retries ?? 1;
	const canRetry = retryCount + 1 < maxRetries;

	// "skip" keyword always takes precedence when allowed.
	if (config.skip_allowed && trimmed.toLowerCase() === "skip") {
		return { port: "skip" };
	}

	switch (config.input_type) {
		case "file": {
			if (!attachment) {
				return canRetry ? { port: "retry" } : { port: "invalid" };
			}
			// Mime-type enforcement — skip when the operator hasn't set a list.
			if (
				config.accepted_mime_types &&
				config.accepted_mime_types.length > 0
			) {
				const mime = attachment.mime_type ?? "";
				if (!config.accepted_mime_types.includes(mime)) {
					return canRetry ? { port: "retry" } : { port: "invalid" };
				}
			}
			// Size enforcement — only when operator AND platform both provide a
			// number. Some platforms (e.g. Instagram media) don't expose size.
			if (
				config.max_size_mb &&
				typeof attachment.size_bytes === "number" &&
				attachment.size_bytes > config.max_size_mb * 1024 * 1024
			) {
				return canRetry ? { port: "retry" } : { port: "invalid" };
			}
			return {
				port: "captured",
				capturedValue: attachment,
			};
		}

		case "choice": {
			const choices = Array.isArray(config.choices) ? config.choices : [];
			if (choices.length === 0) {
				// Nothing to match against — treat as invalid.
				return canRetry ? { port: "retry" } : { port: "invalid" };
			}
			const t = trimmed.toLowerCase();
			const matched = choices.find((c) => {
				const haystack = [
					c.value.toLowerCase(),
					c.label.toLowerCase(),
					...(Array.isArray(c.match)
						? c.match.map((m) => m.toLowerCase())
						: []),
				];
				return haystack.includes(t);
			});
			if (matched) return { port: "captured", capturedValue: matched.value };
			return canRetry ? { port: "retry" } : { port: "invalid" };
		}

		case "email": {
			if (EMAIL_RE.test(trimmed)) {
				return { port: "captured", capturedValue: trimmed };
			}
			return canRetry ? { port: "retry" } : { port: "invalid" };
		}

		case "phone": {
			if (PHONE_RE.test(trimmed)) {
				return { port: "captured", capturedValue: trimmed };
			}
			return canRetry ? { port: "retry" } : { port: "invalid" };
		}

		case "number": {
			if (trimmed.length === 0) {
				return canRetry ? { port: "retry" } : { port: "invalid" };
			}
			const n = Number(trimmed);
			if (Number.isNaN(n)) {
				return canRetry ? { port: "retry" } : { port: "invalid" };
			}
			return { port: "captured", capturedValue: n };
		}

		default: {
			// Default: free text. Reject empty strings; optionally enforce
			// `validation.pattern` if supplied.
			if (trimmed.length === 0) {
				return canRetry ? { port: "retry" } : { port: "invalid" };
			}
			const pattern = config.validation?.pattern;
			if (pattern) {
				try {
					const re = new RegExp(pattern);
					if (!re.test(trimmed)) {
						return canRetry ? { port: "retry" } : { port: "invalid" };
					}
				} catch {
					// Malformed regex — treat as "no constraint" so operator mistakes
					// don't wedge runs.
				}
			}
			return { port: "captured", capturedValue: trimmed };
		}
	}
}

/**
 * Resume a single waiting run. Loads run + graph, resolves the port against
 * the current input node, updates the run, and kicks `runLoop` when the run
 * has actually advanced.
 *
 * Returns:
 *   - "advanced"  — the run was resumed and re-entered runLoop. Callers must
 *                   NOT also fire entrypoint matching for the inbound (spec:
 *                   a reply to a pending input does not start a new flow).
 *   - "retried"   — input was invalid but retries remained; the run stays
 *                   parked on the same node. Callers should still suppress
 *                   entrypoint matching — the contact is mid-flow.
 *   - "completed" — no outgoing edge for the chosen port; run marked done.
 *   - "race"      — the run was no longer waiting-for-input by the time we
 *                   looked at it (another worker took it, or the graph
 *                   changed). Caller MAY fall through to entrypoint matching.
 */
export async function resumeWaitingRunOnInput(
	db: Database,
	runId: string,
	inboundText: string,
	attachment: AttachmentInput,
	env: Record<string, unknown>,
): Promise<"advanced" | "retried" | "completed" | "race"> {
	const run = await db.query.automationRuns.findFirst({
		where: eq(automationRuns.id, runId),
	});
	if (!run) return "race";
	if (run.status !== "waiting" || run.waitingFor !== "input") return "race";
	if (!run.currentNodeKey) return "race";

	const automation = await db.query.automations.findFirst({
		where: eq(automations.id, run.automationId),
	});
	if (!automation) return "race";

	const graph = (automation.graph ?? {
		schema_version: 1,
		root_node_key: null,
		nodes: [],
		edges: [],
	}) as Graph;

	const node = graph.nodes.find((n) => n.key === run.currentNodeKey);
	if (!node || node.kind !== "input") return "race";

	const config = (node.config ?? {}) as InputConfig;
	const ctx = ((run.context as Record<string, unknown>) ?? {}) as Record<
		string,
		unknown
	>;
	const retryMap =
		(ctx._input_retries as Record<string, number> | undefined) ?? {};
	const currentRetries = retryMap[node.key] ?? 0;

	const outcome = resolveInputResume(
		config,
		inboundText,
		attachment,
		currentRetries,
	);

	if (outcome.port === "retry") {
		// Re-prompt — increment retry, leave the run parked on the same input
		// node so the next inbound message can be evaluated. The prompt itself
		// is whatever message node the operator wired BEFORE this input; v1
		// does not auto-re-send it.
		const updatedContext: Record<string, unknown> = {
			...ctx,
			_input_retries: { ...retryMap, [node.key]: currentRetries + 1 },
			last_input_value: inboundText ?? "",
		};
		await db
			.update(automationRuns)
			.set({
				context: updatedContext,
				updatedAt: new Date(),
			})
			.where(eq(automationRuns.id, runId));
		return "retried";
	}

	// captured / invalid / skip
	const updatedContext: Record<string, unknown> = { ...ctx };
	if (outcome.port === "captured") {
		updatedContext.last_input_value = outcome.capturedValue;
		if (config.field) {
			updatedContext[config.field] = outcome.capturedValue;
		}
	} else {
		updatedContext.last_input_value = inboundText ?? "";
	}

	// Input node is being exited — clear this node's entry from the retry
	// counter so replaying the flow (e.g. via a sub-flow jump) starts fresh.
	// Preserve other nodes' counters, and drop the whole `_input_retries`
	// key entirely if this was the last one.
	const remaining: Record<string, number> = { ...retryMap };
	delete remaining[node.key];
	if (Object.keys(remaining).length > 0) {
		updatedContext._input_retries = remaining;
	} else {
		delete updatedContext._input_retries;
	}

	const edge = graph.edges.find(
		(e) => e.from_node === node.key && e.from_port === outcome.port,
	);

	if (!edge) {
		// Operator didn't wire this port — graceful completion. Matches the
		// runner's behavior when an advance port has no outgoing edge.
		await db
			.update(automationRuns)
			.set({
				status: "completed",
				exitReason: "completed",
				completedAt: new Date(),
				context: updatedContext,
				currentPortKey: outcome.port,
				waitingFor: null,
				waitingUntil: null,
				updatedAt: new Date(),
			})
			.where(eq(automationRuns.id, runId));
		return "completed";
	}

	await db
		.update(automationRuns)
		.set({
			status: "active",
			waitingFor: null,
			waitingUntil: null,
			currentNodeKey: edge.to_node,
			currentPortKey: edge.to_port,
			context: updatedContext,
			updatedAt: new Date(),
		})
		.where(eq(automationRuns.id, runId));

	// Ensure handlers find a `db` binding on env too, mirroring enrollContact.
	await runLoop(db, runId, { db, ...env });
	return "advanced";
}
