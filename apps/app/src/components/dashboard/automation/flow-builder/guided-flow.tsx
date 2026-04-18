import { useMemo, useState } from "react";
import {
	AlertCircle,
	Bot,
	Box,
	ChevronDown,
	Clock,
	CornerDownRight,
	GitBranch,
	Globe,
	Keyboard,
	MessageSquare,
	Plus,
	Send,
	Shuffle,
	StopCircle,
	Tag,
	Trash2,
	Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import type {
	AutomationDetail,
	AutomationNodeSpec,
	AutomationSchema,
	SchemaNodeDef,
} from "./types";

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

const CATEGORY_ICON: Record<string, typeof Box> = {
	content: MessageSquare,
	input: Keyboard,
	logic: GitBranch,
	ops: Clock,
	ai: Bot,
	action: Tag,
	platform_send: Send,
	flow: CornerDownRight,
};

const CATEGORY_ACCENT: Record<string, { border: string; icon: string }> = {
	content: { border: "border-sky-500", icon: "text-sky-600" },
	input: { border: "border-violet-500", icon: "text-violet-600" },
	logic: { border: "border-amber-500", icon: "text-amber-600" },
	ops: { border: "border-neutral-400", icon: "text-neutral-600" },
	ai: { border: "border-fuchsia-500", icon: "text-fuchsia-600" },
	action: { border: "border-teal-500", icon: "text-teal-600" },
	platform_send: { border: "border-indigo-500", icon: "text-indigo-600" },
	flow: { border: "border-neutral-400", icon: "text-neutral-600" },
};

function resolveIcon(nodeType: string, category: string) {
	if (nodeType === "goto") return CornerDownRight;
	if (nodeType === "end") return StopCircle;
	if (nodeType === "http_request") return Globe;
	if (nodeType === "randomizer" || nodeType === "split") return Shuffle;
	return CATEGORY_ICON[category] ?? Box;
}

function nodeSummary(spec: AutomationNodeSpec): string | undefined {
	if (typeof spec.text === "string") return spec.text as string;
	if (typeof spec.prompt === "string") return spec.prompt as string;
	if (typeof spec.when === "string") return spec.when as string;
	if (typeof spec.url === "string") return spec.url as string;
	if (typeof spec.tag === "string") return spec.tag as string;
	if (typeof spec.field === "string") return spec.field as string;
	if (typeof spec.target_node_key === "string")
		return `→ ${spec.target_node_key}`;
	if (typeof spec.duration_minutes === "number")
		return `${spec.duration_minutes} min`;
	return undefined;
}

interface ChildLink {
	label: string;
	target: string;
}

interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	errorKeys: Set<string>;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
	onInsertAfter: (parentKey: string, label: string, nodeType: string) => void;
	onDeleteNode: (key: string) => void;
	readOnly?: boolean;
}

export function GuidedFlow({
	automation,
	schema,
	errorKeys,
	selectedKey,
	onSelect,
	onInsertAfter,
	onDeleteNode,
	readOnly,
}: Props) {
	const nodesByKey = useMemo(
		() => new Map(automation.nodes.map((n) => [n.key, n])),
		[automation.nodes],
	);
	const schemaByType = useMemo(
		() => new Map(schema.nodes.map((n) => [n.type, n])),
		[schema.nodes],
	);
	const childrenByKey = useMemo(() => {
		const map = new Map<string, ChildLink[]>();
		for (const e of automation.edges) {
			const list = map.get(e.from) ?? [];
			list.push({ label: e.label ?? "next", target: e.to });
			map.set(e.from, list);
		}
		for (const list of map.values()) list.sort((a, b) => a.label.localeCompare(b.label));
		return map;
	}, [automation.edges]);

	// Detect orphaned nodes (no incoming edge and key !== 'trigger'). Rendered
	// at the bottom so the user can re-attach them.
	const orphans = useMemo(() => {
		const seen = new Set<string>(["trigger"]);
		const walk = (key: string) => {
			if (seen.has(key) && key !== "trigger") return;
			seen.add(key);
			for (const c of childrenByKey.get(key) ?? []) walk(c.target);
		};
		walk("trigger");
		return automation.nodes.filter((n) => !seen.has(n.key));
	}, [automation.nodes, childrenByKey]);

	return (
		<div className="h-full overflow-y-auto bg-muted/40">
			<div className="mx-auto max-w-md px-6 py-10 space-y-0">
				<TriggerCard
					automation={automation}
					selected={selectedKey === "trigger"}
					onClick={() => onSelect("trigger")}
				/>
				<ChainRenderer
					parentKey="trigger"
					childrenByKey={childrenByKey}
					nodesByKey={nodesByKey}
					schemaByType={schemaByType}
					errorKeys={errorKeys}
					selectedKey={selectedKey}
					onSelect={onSelect}
					onInsertAfter={onInsertAfter}
					onDeleteNode={onDeleteNode}
					schema={schema}
					automationChannel={automation.channel}
					readOnly={readOnly}
					visited={new Set(["trigger"])}
					depth={0}
				/>

				{orphans.length > 0 && (
					<div className="mt-10 pt-6 border-t border-border">
						<p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
							Unreachable nodes
						</p>
						<div className="space-y-2">
							{orphans.map((n) => (
								<StepCard
									key={n.key}
									node={n}
									def={schemaByType.get(n.type) ?? null}
									selected={selectedKey === n.key}
									hasError={errorKeys.has(n.key)}
									onClick={() => onSelect(n.key)}
									onDelete={
										readOnly ? undefined : () => onDeleteNode(n.key)
									}
								/>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

function ChainRenderer({
	parentKey,
	parentEdgeLabel,
	childrenByKey,
	nodesByKey,
	schemaByType,
	errorKeys,
	selectedKey,
	onSelect,
	onInsertAfter,
	onDeleteNode,
	schema,
	automationChannel,
	readOnly,
	visited,
	depth,
}: {
	parentKey: string;
	parentEdgeLabel?: string;
	childrenByKey: Map<string, ChildLink[]>;
	nodesByKey: Map<string, AutomationNodeSpec>;
	schemaByType: Map<string, SchemaNodeDef>;
	errorKeys: Set<string>;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
	onInsertAfter: (parentKey: string, label: string, nodeType: string) => void;
	onDeleteNode: (key: string) => void;
	schema: AutomationSchema;
	automationChannel: string;
	readOnly?: boolean;
	visited: Set<string>;
	depth: number;
}) {
	const children = childrenByKey.get(parentKey) ?? [];

	// Single linear edge → render the next node inline
	if (children.length === 1 && !visited.has(children[0]!.target)) {
		const child = children[0]!;
		const node = nodesByKey.get(child.target);
		if (!node) return null;
		const nextVisited = new Set(visited);
		nextVisited.add(child.target);
		return (
			<>
				<Connector label={child.label === "next" ? undefined : child.label} />
				{!readOnly && (
					<AddStepButton
						parentKey={parentKey}
						label={child.label}
						schema={schema}
						automationChannel={automationChannel}
						onInsert={onInsertAfter}
						tone="inline"
					/>
				)}
				<StepCard
					node={node}
					def={schemaByType.get(node.type) ?? null}
					selected={selectedKey === node.key}
					hasError={errorKeys.has(node.key)}
					onClick={() => onSelect(node.key)}
					onDelete={readOnly ? undefined : () => onDeleteNode(node.key)}
				/>
				<ChainRenderer
					parentKey={node.key}
					childrenByKey={childrenByKey}
					nodesByKey={nodesByKey}
					schemaByType={schemaByType}
					errorKeys={errorKeys}
					selectedKey={selectedKey}
					onSelect={onSelect}
					onInsertAfter={onInsertAfter}
					onDeleteNode={onDeleteNode}
					schema={schema}
					automationChannel={automationChannel}
					readOnly={readOnly}
					visited={nextVisited}
					depth={depth}
				/>
			</>
		);
	}

	// Multiple branches → render a split section. Each branch is its own chain.
	if (children.length > 1) {
		return (
			<>
				<Connector label="branches" />
				<div className="grid gap-3 md:grid-cols-2">
					{children.map((c) => (
						<BranchColumn
							key={`${c.label}->${c.target}`}
							branchLabel={c.label}
							parentKey={parentKey}
							firstChildKey={c.target}
							childrenByKey={childrenByKey}
							nodesByKey={nodesByKey}
							schemaByType={schemaByType}
							errorKeys={errorKeys}
							selectedKey={selectedKey}
							onSelect={onSelect}
							onInsertAfter={onInsertAfter}
							onDeleteNode={onDeleteNode}
							schema={schema}
							automationChannel={automationChannel}
							readOnly={readOnly}
							visited={visited}
							depth={depth + 1}
						/>
					))}
				</div>
			</>
		);
	}

	// No children (or only cycle targets) → show add-step button
	if (!readOnly) {
		const addLabel = parentEdgeLabel ?? "next";
		return (
			<>
				<Connector />
				<AddStepButton
					parentKey={parentKey}
					label={addLabel}
					schema={schema}
					automationChannel={automationChannel}
					onInsert={onInsertAfter}
					tone="end"
				/>
			</>
		);
	}
	return null;
}

function BranchColumn({
	branchLabel,
	parentKey,
	firstChildKey,
	childrenByKey,
	nodesByKey,
	schemaByType,
	errorKeys,
	selectedKey,
	onSelect,
	onInsertAfter,
	onDeleteNode,
	schema,
	automationChannel,
	readOnly,
	visited,
	depth,
}: {
	branchLabel: string;
	parentKey: string;
	firstChildKey: string;
	childrenByKey: Map<string, ChildLink[]>;
	nodesByKey: Map<string, AutomationNodeSpec>;
	schemaByType: Map<string, SchemaNodeDef>;
	errorKeys: Set<string>;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
	onInsertAfter: (parentKey: string, label: string, nodeType: string) => void;
	onDeleteNode: (key: string) => void;
	schema: AutomationSchema;
	automationChannel: string;
	readOnly?: boolean;
	visited: Set<string>;
	depth: number;
}) {
	const node = nodesByKey.get(firstChildKey);
	const branchVisited = new Set(visited);
	if (node) branchVisited.add(firstChildKey);
	return (
		<div className="rounded-md border border-dashed border-border bg-background/60 px-3 py-3">
			<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
				{branchLabel}
			</div>
			{!node && !readOnly && (
				<AddStepButton
					parentKey={parentKey}
					label={branchLabel}
					schema={schema}
					automationChannel={automationChannel}
					onInsert={onInsertAfter}
					tone="end"
				/>
			)}
			{node && (
				<>
					<StepCard
						node={node}
						def={schemaByType.get(node.type) ?? null}
						selected={selectedKey === node.key}
						hasError={errorKeys.has(node.key)}
						onClick={() => onSelect(node.key)}
						onDelete={readOnly ? undefined : () => onDeleteNode(node.key)}
					/>
					<ChainRenderer
						parentKey={node.key}
						childrenByKey={childrenByKey}
						nodesByKey={nodesByKey}
						schemaByType={schemaByType}
						errorKeys={errorKeys}
						selectedKey={selectedKey}
						onSelect={onSelect}
						onInsertAfter={onInsertAfter}
						onDeleteNode={onDeleteNode}
						schema={schema}
						automationChannel={automationChannel}
						readOnly={readOnly}
						visited={branchVisited}
						depth={depth}
					/>
				</>
			)}
		</div>
	);
}

function Connector({ label }: { label?: string }) {
	return (
		<div className="flex items-center justify-center py-1">
			<div className="w-px h-4 bg-border" />
			{label && (
				<span className="ml-2 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
					{label}
				</span>
			)}
		</div>
	);
}

function TriggerCard({
	automation,
	selected,
	onClick,
}: {
	automation: AutomationDetail;
	selected: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full rounded-md border-2 bg-card px-3 py-2.5 text-left shadow-sm transition-all",
				"border-emerald-500 hover:shadow-md",
				selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
			)}
		>
			<div className="flex items-center gap-1.5 text-emerald-600">
				<Zap className="size-3.5" />
				<span className="text-[10px] font-semibold uppercase tracking-wide">
					Trigger
				</span>
			</div>
			<div className="mt-1 text-sm font-medium">
				{automation.trigger_type.replace(/_/g, " ")}
			</div>
			<div className="text-[11px] text-muted-foreground mt-0.5">
				{automation.channel}
			</div>
		</button>
	);
}

function StepCard({
	node,
	def,
	selected,
	hasError,
	onClick,
	onDelete,
}: {
	node: AutomationNodeSpec;
	def: SchemaNodeDef | null;
	selected: boolean;
	hasError: boolean;
	onClick: () => void;
	onDelete?: () => void;
}) {
	const category = def?.category ?? "ops";
	const Icon = resolveIcon(node.type, category);
	const accent = CATEGORY_ACCENT[category] ?? CATEGORY_ACCENT.ops!;
	const summary = nodeSummary(node);
	return (
		<div className="group relative">
			<button
				type="button"
				onClick={onClick}
				className={cn(
					"w-full rounded-md border-2 bg-card px-3 py-2.5 text-left shadow-sm transition-all",
					accent.border,
					"hover:shadow-md",
					selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
					hasError && "border-destructive ring-1 ring-destructive/40",
				)}
			>
				<div className={cn("flex items-center gap-1.5", accent.icon)}>
					<Icon className="size-3.5" />
					<span className="text-[10px] font-semibold uppercase tracking-wide">
						{node.type.replace(/_/g, " ")}
					</span>
					{hasError && (
						<AlertCircle className="size-3 text-destructive ml-auto" />
					)}
				</div>
				<div className="mt-1 text-sm font-medium truncate">{node.key}</div>
				{summary && (
					<div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
						{summary}
					</div>
				)}
			</button>
			{onDelete && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onDelete();
					}}
					className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity p-1"
					aria-label="Delete step"
					title="Delete step"
				>
					<Trash2 className="size-3" />
				</button>
			)}
		</div>
	);
}

function AddStepButton({
	parentKey,
	label,
	schema,
	automationChannel,
	onInsert,
	tone,
}: {
	parentKey: string;
	label: string;
	schema: AutomationSchema;
	automationChannel: string;
	onInsert: (parentKey: string, label: string, nodeType: string) => void;
	tone: "inline" | "end";
}) {
	const [open, setOpen] = useState(false);
	const grouped = useMemo(() => {
		const byCategory = new Map<string, SchemaNodeDef[]>();
		for (const n of schema.nodes) {
			if (n.type === "trigger") continue;
			if (
				n.category === "platform_send" &&
				automationChannel !== "multi" &&
				!n.type.includes(automationChannel)
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
	}, [schema, automationChannel]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"mx-auto flex items-center gap-1.5 rounded-full border border-dashed border-border bg-background px-3 py-1 text-[11px] text-muted-foreground hover:border-foreground hover:text-foreground transition-colors",
						tone === "inline" && "my-1",
						tone === "end" && "mt-2",
					)}
				>
					<Plus className="size-3" />
					Add step
					<ChevronDown className="size-3" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="center"
				sideOffset={6}
				className="w-72 p-0 max-h-96 overflow-y-auto"
			>
				<div className="px-3 py-2 border-b border-border">
					<div className="text-xs font-medium">Add step</div>
					<div className="text-[10px] text-muted-foreground mt-0.5">
						After{" "}
						<span className="font-mono">{parentKey}</span>
						{label !== "next" && (
							<>
								{" "}on <span className="font-mono">{label}</span>
							</>
						)}
					</div>
				</div>
				<div className="py-1">
					{CATEGORY_ORDER.filter((c) => grouped.has(c)).map((category) => {
						const list = grouped.get(category) ?? [];
						const Icon = CATEGORY_ICON[category] ?? Box;
						const accent = CATEGORY_ACCENT[category] ?? CATEGORY_ACCENT.ops!;
						return (
							<div key={category}>
								<div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
									{CATEGORY_LABEL[category] ?? category}
								</div>
								<ul>
									{list.map((def) => (
										<li key={def.type}>
											<button
												type="button"
												onClick={() => {
													onInsert(parentKey, label, def.type);
													setOpen(false);
												}}
												className="w-full px-3 py-1.5 text-left text-xs hover:bg-accent/40 flex items-center gap-2"
											>
												<Icon className={cn("size-3.5", accent.icon)} />
												<span className="truncate">
													{def.type.replace(/_/g, " ")}
												</span>
											</button>
										</li>
									))}
								</ul>
							</div>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
