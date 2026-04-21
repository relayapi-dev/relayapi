// Transcript viewer (Plan 3 — Unit C2, Task S4).
//
// Merges outbound `message`-kind step runs with inbound messages from the
// conversation (if the run has a conversation_id). Renders them as chat
// bubbles in chronological order. Merge tags in the step payload are
// already rendered by the runtime, so we surface whatever `rendered_text`
// / `text` the payload provides and fall back to a neutral placeholder.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepRow {
	id: string;
	node_key: string;
	node_kind: string;
	outcome: string;
	payload: unknown | null;
	executed_at: string;
}

interface StepListResponse {
	data: StepRow[];
	next_cursor: string | null;
	has_more: boolean;
}

interface ConversationMessage {
	id: string;
	conversation_id: string;
	author_name: string | null;
	text: string | null;
	direction: "inbound" | "outbound";
	created_at: string;
}

interface ConversationGetResponse {
	conversation: {
		id: string;
		participant_name: string | null;
		platform: string;
	};
	messages: ConversationMessage[];
}

interface Props {
	runId: string;
	conversationId: string | null;
	channel?: string;
	contactName?: string | null;
}

// ---------------------------------------------------------------------------
// Payload → text resolution
//
// Step payloads for message nodes vary a bit depending on the handler. We
// look for the most common shapes in order of preference:
//   1. payload.rendered_text         — primary: the runtime writes this
//   2. payload.text                  — some handlers use this instead
//   3. payload.message.text          — nested shape (platform sends)
//   4. payload.blocks[0].text        — composer block shape
// and fall back to "(message sent)" so the bubble still appears.
// ---------------------------------------------------------------------------

function payloadToText(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "(message sent)";
	const p = payload as Record<string, unknown>;

	if (typeof p.rendered_text === "string" && p.rendered_text.trim())
		return p.rendered_text;
	if (typeof p.text === "string" && p.text.trim()) return p.text;

	const msg = p.message as Record<string, unknown> | undefined;
	if (msg && typeof msg.text === "string" && msg.text.trim()) return msg.text;

	const blocks = p.blocks as unknown;
	if (Array.isArray(blocks) && blocks.length > 0) {
		for (const b of blocks) {
			if (b && typeof b === "object") {
				const bb = b as Record<string, unknown>;
				if (typeof bb.text === "string" && bb.text.trim()) return bb.text;
			}
		}
	}
	return "(message sent)";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type BubbleEntry = {
	id: string;
	timestamp: string;
	direction: "inbound" | "outbound";
	text: string;
	sourceLabel?: string;
};

export function Transcript({
	runId,
	conversationId,
	channel,
	contactName,
}: Props) {
	const [outbound, setOutbound] = useState<BubbleEntry[]>([]);
	const [inbound, setInbound] = useState<BubbleEntry[]>([]);
	const [loadingOut, setLoadingOut] = useState(true);
	const [loadingIn, setLoadingIn] = useState(!!conversationId);
	const [error, setError] = useState<string | null>(null);

	// Outbound — derived from the run's step log, filtered to message-kind
	// steps that have a payload.
	const loadOutbound = useCallback(async () => {
		setLoadingOut(true);
		try {
			const url = new URL(
				`/api/automation-runs/${runId}/steps`,
				window.location.origin,
			);
			url.searchParams.set("limit", "100");
			const res = await fetch(url.toString());
			if (!res.ok) {
				const body = await res.json().catch(() => null);
				throw new Error(body?.error?.message ?? `Error ${res.status}`);
			}
			const json = (await res.json()) as StepListResponse;
			const bubbles: BubbleEntry[] = [];
			for (const s of json.data) {
				if (s.node_kind !== "message") continue;
				if (s.outcome !== "advance" && s.outcome !== "success") continue;
				bubbles.push({
					id: s.id,
					timestamp: s.executed_at,
					direction: "outbound",
					text: payloadToText(s.payload),
					sourceLabel: s.node_key,
				});
			}
			setOutbound(bubbles);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load transcript");
		} finally {
			setLoadingOut(false);
		}
	}, [runId]);

	// Inbound — only when the run is attached to a conversation.
	const loadInbound = useCallback(async () => {
		if (!conversationId) {
			setInbound([]);
			setLoadingIn(false);
			return;
		}
		setLoadingIn(true);
		try {
			const res = await fetch(
				`/api/inbox/conversations/${conversationId}`,
			);
			if (!res.ok) {
				// Inbound is best-effort — don't surface as a hard error.
				setInbound([]);
				return;
			}
			const json = (await res.json()) as ConversationGetResponse;
			const entries: BubbleEntry[] = (json.messages ?? []).map((m) => ({
				id: m.id,
				timestamp: m.created_at,
				direction: m.direction,
				text: m.text ?? "(empty message)",
				sourceLabel: m.author_name ?? undefined,
			}));
			setInbound(entries);
		} catch {
			setInbound([]);
		} finally {
			setLoadingIn(false);
		}
	}, [conversationId]);

	useEffect(() => {
		void loadOutbound();
	}, [loadOutbound]);

	useEffect(() => {
		void loadInbound();
	}, [loadInbound]);

	// When inbound comes from the conversation, it already contains the
	// outbound messages that the runtime actually sent (since they were
	// persisted to the conversation). In that case, prefer the conversation
	// transcript — it also carries any non-automation messages from agents.
	const merged = useMemo<BubbleEntry[]>(() => {
		if (conversationId && inbound.length > 0) return inbound;
		// Otherwise surface the outbound step-log transcript.
		return outbound;
	}, [conversationId, inbound, outbound]);

	const loading = loadingOut || loadingIn;

	if (loading) {
		return (
			<div className="flex justify-center py-8">
				<Loader2 className="size-4 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (error && merged.length === 0) {
		return (
			<div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
				{error}
			</div>
		);
	}

	if (merged.length === 0) {
		return (
			<div className="p-4 text-center text-xs text-muted-foreground">
				<p>No transcript available yet.</p>
				{!conversationId && (
					<p className="mt-1 text-[10px] text-muted-foreground/70">
						This run isn't attached to a conversation, so inbound messages
						can't be shown.
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center justify-between">
				<span>Transcript</span>
				{channel && (
					<span className="rounded bg-muted px-1.5 py-0 font-mono text-[10px] normal-case text-muted-foreground">
						{channel}
					</span>
				)}
			</div>
			<div className="flex-1 overflow-auto bg-[#fbfcfe] px-3 py-3 space-y-2">
				{merged.map((b) => (
					<Bubble
						key={b.id}
						entry={b}
						contactName={contactName ?? null}
					/>
				))}
				{!conversationId && (
					<p className="pt-3 text-center text-[10px] text-muted-foreground/70">
						Showing outbound messages from this run. Inbound messages require a
						linked conversation.
					</p>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Bubble
// ---------------------------------------------------------------------------

function Bubble({
	entry,
	contactName,
}: {
	entry: BubbleEntry;
	contactName: string | null;
}) {
	const isOutbound = entry.direction === "outbound";
	const author = isOutbound
		? entry.sourceLabel ?? "Automation"
		: entry.sourceLabel ?? contactName ?? "Contact";
	return (
		<div
			className={cn(
				"flex gap-2",
				isOutbound ? "justify-end" : "justify-start",
			)}
		>
			<div
				className={cn(
					"max-w-[85%] rounded-2xl px-3 py-1.5 text-[12px] shadow-sm",
					isOutbound
						? "bg-[#2563eb] text-white rounded-tr-sm"
						: "bg-white border border-[#e6e9ef] text-[#1f2937] rounded-tl-sm",
				)}
			>
				<div
					className={cn(
						"mb-0.5 text-[9px] font-semibold uppercase tracking-wide",
						isOutbound ? "text-white/70" : "text-[#64748b]",
					)}
				>
					{author}
				</div>
				<p className="whitespace-pre-wrap leading-[1.35]">{entry.text}</p>
				<div
					className={cn(
						"mt-0.5 text-[9px]",
						isOutbound ? "text-white/60" : "text-[#94a3b8]",
					)}
				>
					{formatTime(entry.timestamp)}
				</div>
			</div>
		</div>
	);
}

function formatTime(s: string): string {
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return s;
	return d.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}
