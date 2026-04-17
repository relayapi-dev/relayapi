import { memo, useEffect, useRef, useState } from "react";
import {
	BaseEdge,
	EdgeLabelRenderer,
	getBezierPath,
	type EdgeProps,
} from "@xyflow/react";

const LABEL_STYLES: Record<string, string> = {
	yes: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
	no: "bg-red-500/15 text-red-400 border-red-500/40",
	captured: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40",
	timeout: "bg-amber-500/15 text-amber-400 border-amber-500/40",
	no_match: "bg-red-500/15 text-red-400 border-red-500/40",
	handoff: "bg-indigo-500/15 text-indigo-400 border-indigo-500/40",
	complete: "bg-sky-500/15 text-sky-400 border-sky-500/40",
	next: "bg-muted text-muted-foreground border-border",
};

const FALLBACK_STYLE = "bg-muted text-muted-foreground border-border";

function styleFor(label: string | undefined): string {
	if (!label) return FALLBACK_STYLE;
	return LABEL_STYLES[label] ?? "bg-sky-500/15 text-sky-400 border-sky-500/40";
}

interface EdgeData {
	label?: string;
	// Labels that are valid outputs of the source node. Includes the node-type
	// catalog (e.g. ["yes","no"] for condition) + any custom branch labels from
	// the source node's config (randomizer branches, split_test variants, etc.).
	availableLabels?: string[];
	onChangeLabel?: (edgeId: string, label: string) => void;
	readOnly?: boolean;
}

function LabeledEdgeImpl({
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	id,
	markerEnd,
	style,
	data,
}: EdgeProps) {
	const [edgePath, labelX, labelY] = getBezierPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
	});

	const d = (data ?? {}) as EdgeData;
	const [editing, setEditing] = useState(false);
	const [customOpen, setCustomOpen] = useState(false);
	const [customText, setCustomText] = useState("");
	const popoverRef = useRef<HTMLDivElement>(null);

	// Close popover on outside click.
	useEffect(() => {
		if (!editing) return;
		const onDoc = (e: MouseEvent) => {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
				setEditing(false);
				setCustomOpen(false);
			}
		};
		window.addEventListener("mousedown", onDoc);
		return () => window.removeEventListener("mousedown", onDoc);
	}, [editing]);

	const commit = (label: string) => {
		if (id && d.onChangeLabel) d.onChangeLabel(id, label);
		setEditing(false);
		setCustomOpen(false);
		setCustomText("");
	};

	const labelText = d.label ?? "next";
	const cls = styleFor(d.label);

	return (
		<>
			<BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
			<EdgeLabelRenderer>
				<div
					style={{
						position: "absolute",
						transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
						pointerEvents: "all",
						zIndex: editing ? 50 : undefined,
					}}
					className="nodrag nopan"
				>
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							if (!d.readOnly) setEditing((v) => !v);
						}}
						className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${cls} ${
							d.readOnly ? "cursor-default" : "hover:ring-1 hover:ring-ring"
						}`}
						title={d.readOnly ? undefined : "Click to change branch label"}
					>
						{labelText}
					</button>

					{editing && !d.readOnly && (
						<div
							ref={popoverRef}
							className="absolute left-1/2 top-[calc(100%+4px)] -translate-x-1/2 min-w-[140px] rounded-md border border-border bg-popover shadow-md py-1 text-[11px]"
						>
							<div className="px-2 py-1 text-[9px] uppercase tracking-wider text-muted-foreground">
								Branch label
							</div>
							{(d.availableLabels ?? ["next"]).map((lbl) => (
								<button
									key={lbl}
									type="button"
									onClick={() => commit(lbl)}
									className={`w-full text-left px-2 py-1 hover:bg-accent/50 ${
										lbl === d.label ? "font-medium" : ""
									}`}
								>
									{lbl}
								</button>
							))}
							<div className="border-t border-border mt-0.5 pt-0.5">
								{customOpen ? (
									<div className="px-2 py-1 flex items-center gap-1">
										<input
											type="text"
											autoFocus
											value={customText}
											onChange={(e) => setCustomText(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter" && customText.trim()) {
													commit(customText.trim());
												} else if (e.key === "Escape") {
													setCustomOpen(false);
												}
											}}
											placeholder="custom label"
											className="h-6 flex-1 text-[11px] rounded border border-input bg-background px-1.5"
										/>
										<button
											type="button"
											onClick={() => customText.trim() && commit(customText.trim())}
											className="text-[10px] px-1.5 py-0.5 rounded bg-primary text-primary-foreground hover:opacity-90"
										>
											ok
										</button>
									</div>
								) : (
									<button
										type="button"
										onClick={() => setCustomOpen(true)}
										className="w-full text-left px-2 py-1 text-muted-foreground hover:bg-accent/50"
									>
										Custom…
									</button>
								)}
							</div>
						</div>
					)}
				</div>
			</EdgeLabelRenderer>
		</>
	);
}

export const LabeledEdge = memo(LabeledEdgeImpl);
