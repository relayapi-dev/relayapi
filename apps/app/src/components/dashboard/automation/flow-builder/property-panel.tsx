// Property panel dispatcher (Plan 2 — Unit B3, Task M1).
//
// Thin wrapper that selects the right editor for the node kind:
//   - `message`       → MessageComposer (Unit B3, Phase N)
//   - `action_group`  → ActionEditor (stub — full impl in Unit B4)
//   - everything else → GenericFieldForm (schema-driven FieldRow, legacy)
//
// The panel is still driven from the pre-rewrite `AutomationDetail` shape
// used by `automation-detail-page.tsx` (Phase P will port that page to the
// graph store). The dispatcher therefore still accepts the legacy
// `AutomationNodeSpec` type on `node` — but when the node's `type` is
// `"message"` (the new unified kind) we present the composer, synthesizing
// the graph-style `{ kind, config }` shape the composer expects.

import { ChevronLeft, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { platformIcons } from "@/lib/platform-icons";
import { cn } from "@/lib/utils";
import { ActionEditor } from "./action-editor";
import { INPUT_CLS } from "./field-styles";
import { GenericFieldForm } from "./generic-field-form";
import { MessageComposer } from "./message-composer";
import type { MessageConfig } from "./message-composer/types";
import type {
	AutomationDetail,
	AutomationNodeSpec,
	SchemaNodeDef,
} from "./types";

// Re-export parseFieldsSchema / FieldRow so existing callers keep working
// while the builder migrates off them (they still live in the extracted
// generic-field-form module).
export { FieldRow, parseFieldsSchema } from "./generic-field-form";
export type { FieldDef } from "./generic-field-form";

const PANEL_WIDTH_CLS = "w-[360px] xl:w-[392px]";

const PANEL_TITLE_OVERRIDES: Record<string, string> = {
	message: "Message",
	message_text: "Send Message",
	message_media: "Send Media",
	message_file: "Send File",
	action_group: "Actions",
	smart_delay: "Delay",
	condition: "Condition",
	randomizer: "Randomizer",
	http_request: "HTTP Request",
	goto: "Go To Step",
	end: "End Automation",
	tag_add: "Add Tag",
	tag_remove: "Remove Tag",
	field_set: "Set Field",
	field_clear: "Clear Field",
};

function titleize(value: string): string {
	return value
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function panelHeaderTone(nodeType: string) {
	if (nodeType === "message" || nodeType.startsWith("message_")) {
		return {
			bar: "bg-[#edd5f5]",
			badge: "text-[#8f5bb3]",
			iconBg: "bg-[#f7ecfb]",
		};
	}
	if (nodeType === "condition" || nodeType === "randomizer") {
		return {
			bar: "bg-[#e6f1ff]",
			badge: "text-[#4a7ae8]",
			iconBg: "bg-[#edf4ff]",
		};
	}
	return {
		bar: "bg-[#eef5ff]",
		badge: "text-[#61758a]",
		iconBg: "bg-[#f5f8fc]",
	};
}

function panelDisplayTitle(
	node: AutomationNodeSpec,
	nodeDef: SchemaNodeDef | null,
) {
	return (
		PANEL_TITLE_OVERRIDES[node.type] ?? titleize(nodeDef?.type ?? node.type)
	);
}

// ---------------------------------------------------------------------------
// Props (unchanged from pre-rewrite — automation-detail-page still drives us)
// ---------------------------------------------------------------------------

interface Props {
	automation: AutomationDetail;
	node: AutomationNodeSpec | null;
	nodeDef: SchemaNodeDef | null;
	automationChannel: string;
	onChange: (patch: Partial<AutomationNodeSpec>) => void;
	onDelete: () => void;
	onClose: () => void;
	existingKeys: string[];
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function PropertyPanel({
	automation,
	node,
	nodeDef,
	automationChannel,
	onChange,
	onDelete,
	onClose,
	existingKeys,
}: Props) {
	const [localKey, setLocalKey] = useState(node?.key ?? "");
	useEffect(() => {
		setLocalKey(node?.key ?? "");
	}, [node?.key]);

	if (!node) {
		return (
			<div
				className={cn(
					PANEL_WIDTH_CLS,
					"flex items-center justify-center border-l border-[#e6e9ef] bg-white p-8",
				)}
			>
				<p className="text-sm text-[#7e8695] text-center">
					Select a node to edit its properties
				</p>
			</div>
		);
	}

	const keyIsValid =
		/^[a-zA-Z][a-zA-Z0-9_]*$/.test(localKey) &&
		(localKey === node.key || !existingKeys.includes(localKey));
	const title = panelDisplayTitle(node, nodeDef);
	const headerTone = panelHeaderTone(node.type);
	const platformIcon = platformIcons[automationChannel];

	// Kind-specific editor dispatch.
	const editor = renderEditor({
		node,
		nodeDef,
		automation,
		automationChannel,
		onChange,
	});

	return (
		<div
			className={cn(
				PANEL_WIDTH_CLS,
				"flex flex-col overflow-hidden border-l border-[#e6e9ef] bg-white shadow-[-12px_0_32px_rgba(15,23,42,0.03)]",
			)}
		>
			<PanelHeader
				headerTone={headerTone}
				title={title}
				description={nodeDef?.description ?? "Configure this step"}
				onClose={onClose}
			/>

			<ScrollArea className="flex-1 bg-[#fbfcfe]">
				<div className="space-y-5 px-4 py-5">
					{node.type === "message" || node.type.startsWith("message_") ? (
						<ChannelWindowBanner
							iconBg={headerTone.iconBg}
							badge={headerTone.badge}
							platformIcon={platformIcon}
						/>
					) : null}

					{editor}

					<PanelFooter
						node={node}
						localKey={localKey}
						onLocalKeyChange={setLocalKey}
						keyIsValid={keyIsValid}
						existingKeys={existingKeys}
						onChange={onChange}
					/>
				</div>
			</ScrollArea>

			<div className="border-t border-[#e6e9ef] bg-white px-4 py-3">
				<Button
					variant="ghost"
					onClick={onDelete}
					className="h-10 w-full gap-2 rounded-xl text-[13px] font-medium text-destructive hover:bg-destructive/10 hover:text-destructive"
				>
					<Trash2 className="size-4" />
					Delete step
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PanelHeader({
	headerTone,
	title,
	description,
	onClose,
}: {
	headerTone: ReturnType<typeof panelHeaderTone>;
	title: string;
	description: string;
	onClose: () => void;
}) {
	return (
		<div className={cn("border-b border-[#e6e9ef] px-4 py-4", headerTone.bar)}>
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={onClose}
					className="rounded-full p-1 text-[#6f7786] transition hover:bg-white/70 hover:text-[#353a44]"
					aria-label="Close editor"
				>
					<ChevronLeft className="size-4" />
				</button>
				<div className="min-w-0 flex-1">
					<h3 className="truncate text-[18px] font-semibold text-[#353a44]">
						{title}
					</h3>
					<p className="mt-1 text-[12px] text-[#6f7786]">{description}</p>
				</div>
			</div>
		</div>
	);
}

function ChannelWindowBanner({
	iconBg,
	badge,
	platformIcon,
}: {
	iconBg: string;
	badge: string;
	platformIcon: React.ReactNode;
}) {
	return (
		<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
			<div className="flex items-center gap-3">
				<div
					className={cn(
						"flex size-10 items-center justify-center rounded-full",
						iconBg,
					)}
				>
					<div className={cn("scale-[0.9]", badge)}>{platformIcon}</div>
				</div>
				<div>
					<div className="text-[11px] font-medium uppercase tracking-[0.12em] text-[#8b92a0]">
						Message Window
					</div>
					<div className="mt-1 text-[14px] font-medium text-[#4680ff]">
						Send within 24 hour window
					</div>
				</div>
			</div>
		</div>
	);
}

function PanelFooter({
	node,
	localKey,
	onLocalKeyChange,
	keyIsValid,
	existingKeys,
	onChange,
}: {
	node: AutomationNodeSpec;
	localKey: string;
	onLocalKeyChange: (next: string) => void;
	keyIsValid: boolean;
	existingKeys: string[];
	onChange: (patch: Partial<AutomationNodeSpec>) => void;
}) {
	return (
		<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
			<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
				Technical
			</div>
			<div className="mt-4 space-y-4">
				<div>
					<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
						Key <span className="text-destructive">*</span>
					</label>
					<input
						type="text"
						value={localKey}
						onChange={(e) => onLocalKeyChange(e.target.value)}
						onBlur={() => {
							if (keyIsValid && localKey !== node.key) {
								onChange({ key: localKey });
							} else {
								onLocalKeyChange(node.key);
							}
						}}
						className={INPUT_CLS}
					/>
					{!keyIsValid && (
						<p className="mt-1 text-[11px] text-destructive">
							{existingKeys.includes(localKey) && localKey !== node.key
								? "Key already in use"
								: "Must start with a letter and only use letters, digits, or underscores"}
						</p>
					)}
				</div>

				<div>
					<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
						Notes
					</label>
					<input
						type="text"
						value={(node.notes as string) ?? ""}
						onChange={(e) => onChange({ notes: e.target.value })}
						className={INPUT_CLS}
						placeholder="Optional internal note"
					/>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Editor dispatch
// ---------------------------------------------------------------------------

function renderEditor({
	node,
	nodeDef,
	automation,
	automationChannel,
	onChange,
}: {
	node: AutomationNodeSpec;
	nodeDef: SchemaNodeDef | null;
	automation: AutomationDetail;
	automationChannel: string;
	onChange: (patch: Partial<AutomationNodeSpec>) => void;
}) {
	if (node.type === "message") {
		// Graph-store style `message` node: its config lives flat on the
		// AutomationNodeSpec (since detail-page normalises config into spread
		// fields). Synthesize `{ kind, config }` for the composer and lift
		// changes back onto the flat fields the detail page persists.
		const composerNode = {
			key: node.key,
			kind: "message",
			config: extractFlatConfig(node),
		};
		const handleConfigChange = (next: MessageConfig) => {
			// Emit as a patch replacing the message-composer-managed keys while
			// preserving any other flat fields the detail page may own.
			const patch: Partial<AutomationNodeSpec> = {
				blocks: next.blocks,
				quick_replies: next.quick_replies,
				wait_for_reply: next.wait_for_reply,
				no_response_timeout_min: next.no_response_timeout_min,
				typing_indicator_seconds: next.typing_indicator_seconds,
			};
			onChange(patch);
		};
		return (
			<MessageComposer
				node={composerNode}
				channel={automationChannel}
				onChange={handleConfigChange}
			/>
		);
	}

	if (node.type === "action_group") {
		const config = extractFlatConfig(node);
		return (
			<ActionEditor
				node={{ key: node.key, kind: "action_group", config }}
				automationId={automation.id}
				onChange={(nextConfig) =>
					onChange({ actions: nextConfig.actions } as Partial<AutomationNodeSpec>)
				}
			/>
		);
	}

	return (
		<GenericFieldForm
			automation={automation}
			node={node}
			nodeDef={nodeDef}
			automationChannel={automationChannel}
			onChange={onChange}
		/>
	);
}

// The detail page spreads node `config` into the flat spec; reverse that here
// for editors that expect a real `config` object.
function extractFlatConfig(node: AutomationNodeSpec): Record<string, unknown> {
	const skip = new Set([
		"type",
		"key",
		"notes",
		"canvas_x",
		"canvas_y",
		"id",
	]);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(node)) {
		if (skip.has(k)) continue;
		out[k] = v;
	}
	return out;
}
