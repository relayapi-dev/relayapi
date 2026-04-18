import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
	MessageSquare,
	Keyboard,
	GitBranch,
	Clock,
	Shuffle,
	Bot,
	Globe,
	Tag,
	Send,
	CornerDownRight,
	StopCircle,
	Box,
	AlertCircle,
} from "lucide-react";

interface GenericNodeData {
	label: string;
	key: string;
	nodeType: string;
	category: string;
	summary?: string;
	hasError?: boolean;
	highlighted?: boolean;
	dimmed?: boolean;
	[key: string]: unknown;
}

const ICONS: Record<string, typeof Box> = {
	content: MessageSquare,
	input: Keyboard,
	logic: GitBranch,
	ops: Clock,
	ai: Bot,
	action: Tag,
	platform_send: Send,
	flow: CornerDownRight,
};

const COLORS: Record<string, string> = {
	content: "border-sky-500/60",
	input: "border-violet-500/60",
	logic: "border-amber-500/60",
	ops: "border-neutral-400",
	ai: "border-fuchsia-500/60",
	action: "border-teal-500/60",
	platform_send: "border-indigo-500/60",
	flow: "border-neutral-400",
};

const CATEGORY_ICON_COLOR: Record<string, string> = {
	content: "text-sky-600",
	input: "text-violet-600",
	logic: "text-amber-600",
	ops: "text-neutral-600",
	ai: "text-fuchsia-600",
	action: "text-teal-600",
	platform_send: "text-indigo-600",
	flow: "text-neutral-600",
};

function resolveIcon(nodeType: string, category: string) {
	if (nodeType === "goto") return CornerDownRight;
	if (nodeType === "end") return StopCircle;
	if (nodeType === "http_request") return Globe;
	if (nodeType === "randomizer" || nodeType === "split") return Shuffle;
	return ICONS[category] ?? Box;
}

function GenericNodeImpl({ data, selected }: NodeProps) {
	const d = data as GenericNodeData;
	const Icon = resolveIcon(d.nodeType, d.category);
	const color = COLORS[d.category] ?? "border-neutral-500/40 bg-neutral-500/5";
	const iconColor =
		CATEGORY_ICON_COLOR[d.category] ?? "text-muted-foreground";

	return (
		<div
			className={`rounded-md border-2 bg-card px-3 py-2 text-xs min-w-[220px] shadow-sm transition-all ${color} ${
				selected ? "ring-2 ring-ring ring-offset-1 ring-offset-background" : ""
			} ${d.hasError ? "border-destructive ring-1 ring-destructive/40" : ""} ${
				d.highlighted ? "ring-2 ring-sky-500 shadow-lg shadow-sky-500/20" : ""
			} ${d.dimmed ? "opacity-40" : ""}`}
			title={d.hasError ? "This node has validation errors — check the banner above" : undefined}
		>
			<Handle
				type="target"
				position={Position.Top}
				className="!bg-foreground !border-foreground"
			/>
			<div className="flex items-center justify-between gap-1.5">
				<div className={`flex items-center gap-1.5 ${iconColor}`}>
					<Icon className="size-3.5" />
					<span className="text-[10px] font-semibold uppercase tracking-wide">
						{d.nodeType.replace(/_/g, " ")}
					</span>
				</div>
				{d.hasError && (
					<AlertCircle className="size-3 text-destructive" />
				)}
			</div>
			<div className="mt-1 font-medium text-foreground truncate">
				{d.key}
			</div>
			{d.summary && (
				<div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
					{d.summary}
				</div>
			)}
			<Handle
				type="source"
				position={Position.Bottom}
				className="!bg-foreground !border-foreground"
			/>
		</div>
	);
}

export const GenericNode = memo(GenericNodeImpl);
