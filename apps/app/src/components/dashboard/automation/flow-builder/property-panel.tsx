// Property panel dispatcher.
//
// Thin wrapper that selects the right editor for the selected node kind:
//   - `message`       → MessageComposer
//   - `action_group`  → ActionEditor
//   - everything else → a small "no config" placeholder (delay, condition,
//                       randomizer, input, http_request, start_automation,
//                       goto, end all have trivial config surfaces that are
//                       edited via the canvas node overlays today).
//
// Props were slimmed down to only the fields the panel actually uses — the
// detail page no longer needs to synthesize a legacy `AutomationDetail`.

import { ChevronLeft, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { platformIcons } from "@/lib/platform-icons";
import { cn } from "@/lib/utils";
import { ActionEditor } from "./action-editor";
import { INPUT_CLS } from "./field-styles";
import { MessageComposer } from "./message-composer";
import type { MessageConfig } from "./message-composer/types";

const PANEL_WIDTH_CLS = "w-[360px] xl:w-[392px]";

const PANEL_TITLE_OVERRIDES: Record<string, string> = {
	message: "Message",
	action_group: "Actions",
	delay: "Delay",
	condition: "Condition",
	randomizer: "Randomizer",
	input: "Input",
	http_request: "HTTP Request",
	start_automation: "Start Automation",
	goto: "Go To Step",
	end: "End Automation",
};

const PANEL_DESCRIPTIONS: Record<string, string> = {
	message: "Compose the message and interactive elements",
	action_group: "Run a sequence of side-effect actions",
	delay: "Pause the flow for a duration",
	condition: "Branch on a filter-group expression",
	randomizer: "Split traffic across weighted variants",
	input: "Wait for a user reply and capture it",
	http_request: "Call an external endpoint and capture the response",
	start_automation: "Enroll the contact into another automation",
	goto: "Jump back to an earlier node",
	end: "Terminate the run explicitly",
};

function titleize(value: string): string {
	return value
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function panelHeaderTone(nodeKind: string) {
	if (nodeKind === "message") {
		return {
			bar: "bg-[#edd5f5]",
			badge: "text-[#8f5bb3]",
			iconBg: "bg-[#f7ecfb]",
		};
	}
	if (nodeKind === "condition" || nodeKind === "randomizer") {
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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PropertyPanelNode {
	key: string;
	kind: string;
	notes?: string;
	config: Record<string, unknown>;
}

interface Props {
	automationId: string;
	node: PropertyPanelNode | null;
	automationChannel: string;
	onChange: (patch: {
		key?: string;
		notes?: string;
		config?: Record<string, unknown>;
	}) => void;
	onDelete: () => void;
	onClose: () => void;
	existingKeys: string[];
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function PropertyPanel({
	automationId,
	node,
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
	const title = PANEL_TITLE_OVERRIDES[node.kind] ?? titleize(node.kind);
	const description =
		PANEL_DESCRIPTIONS[node.kind] ?? "Configure this step";
	const headerTone = panelHeaderTone(node.kind);
	const platformIcon = platformIcons[automationChannel];

	const editor = renderEditor({
		node,
		automationId,
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
				description={description}
				onClose={onClose}
			/>

			<ScrollArea className="flex-1 bg-[#fbfcfe]">
				<div className="space-y-5 px-4 py-5">
					{node.kind === "message" ? (
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
	node: PropertyPanelNode;
	localKey: string;
	onLocalKeyChange: (next: string) => void;
	keyIsValid: boolean;
	existingKeys: string[];
	onChange: (patch: {
		key?: string;
		notes?: string;
		config?: Record<string, unknown>;
	}) => void;
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
						value={node.notes ?? ""}
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
	automationId,
	automationChannel,
	onChange,
}: {
	node: PropertyPanelNode;
	automationId: string;
	automationChannel: string;
	onChange: (patch: { config?: Record<string, unknown> }) => void;
}) {
	if (node.kind === "message") {
		const composerNode = {
			key: node.key,
			kind: "message",
			config: node.config,
		};
		const handleConfigChange = (next: MessageConfig) => {
			onChange({
				config: {
					...node.config,
					blocks: next.blocks,
					quick_replies: next.quick_replies,
					wait_for_reply: next.wait_for_reply,
					no_response_timeout_min: next.no_response_timeout_min,
					typing_indicator_seconds: next.typing_indicator_seconds,
				},
			});
		};
		return (
			<MessageComposer
				node={composerNode}
				channel={automationChannel}
				onChange={handleConfigChange}
			/>
		);
	}

	if (node.kind === "action_group") {
		return (
			<ActionEditor
				node={{ key: node.key, kind: "action_group", config: node.config }}
				automationId={automationId}
				onChange={(nextConfig) =>
					onChange({
						config: { ...node.config, actions: nextConfig.actions },
					})
				}
			/>
		);
	}

	return (
		<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
			<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
				Settings
			</div>
			<p className="mt-4 text-[13px] text-[#7e8695]">
				Edit this step directly on the canvas.
			</p>
		</div>
	);
}
