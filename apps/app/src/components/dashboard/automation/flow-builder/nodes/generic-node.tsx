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
	content: "border-sky-500/40 bg-sky-500/5",
	input: "border-violet-500/40 bg-violet-500/5",
	logic: "border-amber-500/40 bg-amber-500/5",
	ops: "border-neutral-500/40 bg-neutral-500/5",
	ai: "border-fuchsia-500/40 bg-fuchsia-500/5",
	action: "border-teal-500/40 bg-teal-500/5",
	platform_send: "border-indigo-500/40 bg-indigo-500/5",
	flow: "border-neutral-500/40 bg-neutral-500/5",
};

const CATEGORY_ICON_COLOR: Record<string, string> = {
	content: "text-sky-400",
	input: "text-violet-400",
	logic: "text-amber-400",
	ops: "text-neutral-400",
	ai: "text-fuchsia-400",
	action: "text-teal-400",
	platform_send: "text-indigo-400",
	flow: "text-neutral-400",
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
			className={`rounded-md border bg-card/90 px-3 py-2 text-xs min-w-[220px] transition-colors ${color} ${
				selected ? "ring-2 ring-ring ring-offset-1 ring-offset-background" : ""
			}`}
		>
			<Handle
				type="target"
				position={Position.Top}
				className="!bg-muted-foreground !border-muted-foreground"
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
				className="!bg-muted-foreground !border-muted-foreground"
			/>
		</div>
	);
}

export const GenericNode = memo(GenericNodeImpl);
