import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Zap } from "lucide-react";

interface TriggerNodeData {
	label: string;
	triggerType: string;
	channel: string;
	[key: string]: unknown;
}

function TriggerNodeImpl({ data, selected }: NodeProps) {
	const d = data as TriggerNodeData;
	return (
		<div
			className={`rounded-md border-2 bg-emerald-500/10 px-3 py-2 text-xs min-w-[220px] transition-colors ${
				selected ? "border-emerald-400" : "border-emerald-500/40"
			}`}
		>
			<div className="flex items-center gap-1.5 text-emerald-400">
				<Zap className="size-3.5" />
				<span className="text-[10px] font-semibold uppercase tracking-wide">
					Trigger
				</span>
			</div>
			<div className="mt-1 font-medium text-foreground">{d.label}</div>
			<div className="text-[10px] text-muted-foreground mt-0.5">
				{d.channel} · {d.triggerType}
			</div>
			<Handle
				type="source"
				position={Position.Bottom}
				className="!bg-emerald-500 !border-emerald-500"
			/>
		</div>
	);
}

export const TriggerNode = memo(TriggerNodeImpl);
