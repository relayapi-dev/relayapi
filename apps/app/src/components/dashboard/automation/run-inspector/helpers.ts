// Pure helpers for the run inspector suite (Plan 3 — Unit C2, Phase S).
//
// Extracted so they can be covered by tests without pulling React or the
// network layer into the spec file. Anything in here is deterministic and
// has no DOM / network dependency.

// ---------------------------------------------------------------------------
// formatDuration — ms → human-friendly duration string
// ---------------------------------------------------------------------------

/**
 * Format a duration in milliseconds as a compact, human-readable string.
 *
 * Examples:
 *   formatDuration(0)       → "0ms"
 *   formatDuration(450)     → "450ms"
 *   formatDuration(1200)    → "1.2s"
 *   formatDuration(59_000)  → "59s"
 *   formatDuration(83_000)  → "1m 23s"
 *   formatDuration(3_600_000) → "1h 0m"
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;

	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 10) {
		// under 10s → show one decimal
		const s = (ms / 1000).toFixed(1);
		return `${s}s`;
	}
	if (totalSec < 60) return `${totalSec}s`;

	const totalMin = Math.floor(totalSec / 60);
	const remSec = totalSec % 60;
	if (totalMin < 60) {
		if (remSec === 0) return `${totalMin}m`;
		return `${totalMin}m ${remSec}s`;
	}

	const totalHr = Math.floor(totalMin / 60);
	const remMin = totalMin % 60;
	return `${totalHr}h ${remMin}m`;
}

// ---------------------------------------------------------------------------
// statusColor — run status → Tailwind class set
// ---------------------------------------------------------------------------

export type RunStatus =
	| "active"
	| "waiting"
	| "completed"
	| "exited"
	| "failed"
	| string;

/**
 * Map a run status to a bordered pill Tailwind class set. Unknown status
 * values fall back to a neutral muted variant.
 */
export function statusColor(status: RunStatus): string {
	switch (status) {
		case "completed":
			return "text-emerald-600 bg-emerald-500/10 border-emerald-500/30";
		case "active":
			return "text-sky-600 bg-sky-500/10 border-sky-500/30";
		case "waiting":
			return "text-amber-600 bg-amber-500/10 border-amber-500/30";
		case "failed":
			return "text-destructive bg-destructive/10 border-destructive/30";
		case "exited":
			return "text-neutral-600 bg-neutral-500/10 border-neutral-500/30";
		default:
			return "text-muted-foreground bg-muted border-border";
	}
}

// ---------------------------------------------------------------------------
// outcomeIcon — step outcome → lucide icon name
// ---------------------------------------------------------------------------

export type StepOutcome =
	| "advance"
	| "success"
	| "skipped"
	| "waiting"
	| "wait_input"
	| "wait_delay"
	| "failed"
	| "error"
	| "end"
	| string;

/**
 * Map a step outcome label to a lucide icon identifier. The caller resolves
 * the identifier to an actual component — keeping this as a string lets the
 * helper stay pure for testing.
 */
export function outcomeIcon(outcome: StepOutcome): string {
	switch (outcome) {
		case "advance":
		case "success":
			return "check-circle-2";
		case "end":
			return "stop-circle";
		case "skipped":
			return "minus-circle";
		case "waiting":
		case "wait_input":
		case "wait_delay":
			return "clock";
		case "failed":
		case "error":
		case "fail":
			return "x-circle";
		default:
			return "circle";
	}
}

// ---------------------------------------------------------------------------
// outcomeAccent — step outcome → Tailwind accent class for the row
// ---------------------------------------------------------------------------

export function outcomeAccent(outcome: StepOutcome): string {
	switch (outcome) {
		case "advance":
		case "success":
		case "end":
			return "border-emerald-500/40 bg-emerald-500/5";
		case "skipped":
			return "border-border bg-muted/40";
		case "waiting":
		case "wait_input":
		case "wait_delay":
			return "border-amber-500/40 bg-amber-500/5";
		case "failed":
		case "error":
		case "fail":
			return "border-destructive/40 bg-destructive/5";
		default:
			return "border-border bg-background";
	}
}

// ---------------------------------------------------------------------------
// nodeKindIcon — node kind → lucide icon name
// ---------------------------------------------------------------------------

export function nodeKindIcon(kind: string): string {
	switch (kind) {
		case "message":
			return "message-square";
		case "input":
			return "play";
		case "delay":
			return "clock";
		case "condition":
			return "git-branch";
		case "randomizer":
			return "shuffle";
		case "action_group":
			return "zap";
		case "http_request":
			return "globe";
		case "goto":
		case "start_automation":
			return "corner-down-right";
		case "end":
			return "stop-circle";
		default:
			return "bot";
	}
}

// ---------------------------------------------------------------------------
// entrypointSummary — build a 1-line description from a run
// ---------------------------------------------------------------------------

export interface EntrypointSummaryInput {
	entrypoint_id: string | null;
	entrypoint_kind?: string | null;
	entrypoint_label?: string | null;
	binding_id?: string | null;
}

/**
 * Derive a human-friendly entrypoint summary. If the run has no entrypoint
 * id, treat it as a manual enrollment.
 */
export function entrypointSummary(run: EntrypointSummaryInput): string {
	if (!run.entrypoint_id) return "Manual enrollment";
	if (run.entrypoint_label) return run.entrypoint_label;
	if (run.entrypoint_kind) return `Entrypoint: ${run.entrypoint_kind}`;
	return "Automation entrypoint";
}
