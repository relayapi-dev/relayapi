// Run inspector entrypoint (Plan 3 — Unit C2, Task S1 + S6).
//
// Two-column layout:
//   - Left  : <RunHistoryPanel> from Unit C1, emitting onSelectRun(id)
//   - Right : <RunDetail> keyed by the selected runId
//
// The selected run id is mirrored to the URL via `?run_id=X` so the inspector
// deep-links cleanly. We also expose an optional `onShowOnCanvas` callback so
// the detail page can jump the Canvas tab to a node when the user asks.

import { useCallback, useEffect, useState } from "react";
import { RunHistoryPanel } from "@/components/dashboard/automation/flow-builder/run-history-panel";
import { RunDetail } from "./run-detail";

interface Props {
	automationId: string;
	/**
	 * Called when the user clicks "Show on canvas" from the run detail view.
	 * The automation detail page wires this to a tab switch + node selection.
	 */
	onShowOnCanvas?: (nodeKey: string) => void;
	/** Hides the run-history panel's close button (the page controls tabs). */
	onClosePanel?: () => void;
}

/**
 * Read the current ?run_id= query param from the URL (if any). Safe to call
 * during render because it only reads — it never mutates the URL.
 */
function readRunIdFromUrl(): string | null {
	if (typeof window === "undefined") return null;
	try {
		const url = new URL(window.location.href);
		return url.searchParams.get("run_id");
	} catch {
		return null;
	}
}

/**
 * Write the ?run_id= query param to the URL without navigating. Uses
 * `history.replaceState` so the back button is not polluted with intermediate
 * runs the user clicked through.
 */
function syncRunIdToUrl(runId: string | null) {
	if (typeof window === "undefined") return;
	try {
		const url = new URL(window.location.href);
		if (runId) url.searchParams.set("run_id", runId);
		else url.searchParams.delete("run_id");
		const qs = url.searchParams.toString();
		const next = `${url.pathname}${qs ? `?${qs}` : ""}${url.hash}`;
		window.history.replaceState(window.history.state, "", next);
	} catch {
		// Non-fatal — deep-linking just won't persist this click.
	}
}

export function RunInspector({
	automationId,
	onShowOnCanvas,
	onClosePanel,
}: Props) {
	const [selectedRunId, setSelectedRunId] = useState<string | null>(() =>
		readRunIdFromUrl(),
	);

	// React to back/forward navigation so the detail pane tracks the URL.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onPop = () => setSelectedRunId(readRunIdFromUrl());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	const handleSelect = useCallback((runId: string) => {
		setSelectedRunId(runId);
		syncRunIdToUrl(runId);
	}, []);

	return (
		<div className="flex min-h-0 flex-1">
			{/* Detail pane (right column). Renders a placeholder until a run is
			    selected, so the layout stays stable. */}
			<RunDetail
				runId={selectedRunId}
				onShowOnCanvas={onShowOnCanvas}
			/>

			{/* List pane (right edge, matches the existing panel chrome). The
			    RunHistoryPanel renders its own header / filters / scroll area so
			    we just slot it in. */}
			<RunHistoryPanel
				automationId={automationId}
				onClose={onClosePanel ?? (() => undefined)}
				onSelectRun={handleSelect}
			/>
		</div>
	);
}
