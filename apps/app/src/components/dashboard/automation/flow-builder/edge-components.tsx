import { memo } from "react";
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

	const label = (data as { label?: string } | undefined)?.label;
	const cls = label ? LABEL_STYLES[label] ?? "bg-muted text-muted-foreground border-border" : null;

	return (
		<>
			<BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
			{label && cls && (
				<EdgeLabelRenderer>
					<div
						style={{
							position: "absolute",
							transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
							pointerEvents: "all",
						}}
						className={`rounded-full border px-2 py-0.5 text-[10px] font-medium nodrag nopan ${cls}`}
					>
						{label}
					</div>
				</EdgeLabelRenderer>
			)}
		</>
	);
}

export const LabeledEdge = memo(LabeledEdgeImpl);
