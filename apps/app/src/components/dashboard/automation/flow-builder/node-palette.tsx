import { useMemo } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AutomationSchema, SchemaNodeDef } from "./types";

const CATEGORY_ORDER = [
	"content",
	"input",
	"logic",
	"ai",
	"action",
	"ops",
	"platform_send",
	"flow",
];

const CATEGORY_LABEL: Record<string, string> = {
	content: "Content",
	input: "Input",
	logic: "Logic",
	ai: "AI",
	action: "Actions",
	ops: "Ops",
	platform_send: "Platform sends",
	flow: "Flow control",
};

interface Props {
	schema: AutomationSchema;
	channel: string;
	onAddNode: (def: SchemaNodeDef) => void;
	disabled?: boolean;
}

export function NodePalette({ schema, channel, onAddNode, disabled }: Props) {
	const grouped = useMemo(() => {
		const byCategory = new Map<string, SchemaNodeDef[]>();
		for (const n of schema.nodes) {
			if (
				n.category === "platform_send" &&
				channel !== "multi" &&
				!n.type.includes(channel)
			) {
				continue;
			}
			const list = byCategory.get(n.category) ?? [];
			list.push(n);
			byCategory.set(n.category, list);
		}
		for (const list of byCategory.values()) {
			list.sort((a, b) => a.type.localeCompare(b.type));
		}
		return byCategory;
	}, [schema, channel]);

	return (
		<div className="w-56 border-r border-border bg-card/30 flex flex-col overflow-hidden">
			<div className="px-3 py-2 border-b border-border">
				<h3 className="text-xs font-medium">Add node</h3>
				<p className="text-[10px] text-muted-foreground mt-0.5">
					Click to add a node to the graph
				</p>
			</div>
			<div className="flex-1 overflow-y-auto">
				{CATEGORY_ORDER.filter((c) => grouped.has(c)).map((category) => {
					const list = grouped.get(category) ?? [];
					return (
						<div key={category} className="border-b border-border/60 last:border-b-0">
							<div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground bg-accent/10">
								{CATEGORY_LABEL[category] ?? category}
							</div>
							<ul>
								{list.map((def) => (
									<li key={def.type}>
										<button
											type="button"
											disabled={disabled}
											onClick={() => onAddNode(def)}
											className={cn(
												"w-full px-3 py-1.5 text-left text-xs hover:bg-accent/30 transition-colors flex items-center gap-1.5 group",
												disabled && "opacity-50 cursor-not-allowed",
											)}
										>
											<Plus className="size-3 text-muted-foreground group-hover:text-foreground transition-colors" />
											<span className="truncate">{def.type.replace(/_/g, " ")}</span>
										</button>
									</li>
								))}
							</ul>
						</div>
					);
				})}
			</div>
		</div>
	);
}
