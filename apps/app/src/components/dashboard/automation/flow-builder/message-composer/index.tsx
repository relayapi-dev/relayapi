// Message composer shell (Plan 2 — Unit B3, Tasks N1 + N6).
//
// Entry point for editing a `message` node. Wraps the block list,
// add-block dropdown, quick-reply editor, message-level settings, and the
// preview toggle.
//
// Props follow the contract in Plan 2:
//   { node, channel, onChange(config) }
//
// The node's `config` is the shape in `./types` (MessageConfig). Every edit
// returns a *new* config object. The parent (PropertyPanel / graph store) is
// responsible for persisting it.

import { useMemo, useState } from "react";
import { Eye, EyeOff, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	channelDisplayName,
	channelSupportsBlock,
	channelSupportsButtons,
	channelSupportsQuickReplies,
	type BlockType,
} from "../channel-capabilities";
import type { AutomationNode } from "../graph-types";
import { useAutomationCatalog, type ChannelCapabilities } from "../use-catalog";
import { BlockList } from "./block-list";
import { blockLabel } from "./block-editors";
import { Preview } from "./preview";
import { QuickReplyEditor } from "./quick-reply-editor";
import {
	hasInteractiveElements,
	newBlock,
	type MessageBlock,
	type MessageBlockType,
	type MessageConfig,
	type QuickReply,
} from "./types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
	/** The message node being edited (kind === "message"). */
	node: Pick<AutomationNode, "key" | "kind" | "config">;
	/** Channel of the automation (e.g. "instagram"). */
	channel: string;
	/** Called with the new `config` whenever the user edits. */
	onChange(config: MessageConfig): void;
	/**
	 * Optional live capability matrix — takes priority over the static
	 * fallback. The composer prefers the catalog when available so a server
	 * change to capabilities flows through without a dashboard redeploy.
	 */
	channelCapabilities?: ChannelCapabilities;
}

const ALL_BLOCK_TYPES: BlockType[] = [
	"text",
	"image",
	"video",
	"audio",
	"file",
	"card",
	"gallery",
	"delay",
];

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export function MessageComposer({
	node,
	channel,
	onChange,
	channelCapabilities,
}: Props) {
	const catalog = useAutomationCatalog();
	const caps =
		channelCapabilities ??
		(catalog.data?.channel_capabilities as ChannelCapabilities | undefined);

	const cfg = (node.config ?? {}) as MessageConfig;
	const blocks = cfg.blocks ?? [];
	const quickReplies = cfg.quick_replies ?? [];
	const [showPreview, setShowPreview] = useState(false);

	const interactive = useMemo(() => hasInteractiveElements(cfg), [cfg]);

	const setBlocks = (next: MessageBlock[]) =>
		onChange({ ...cfg, blocks: next });
	const setQuickReplies = (next: QuickReply[]) =>
		onChange({
			...cfg,
			quick_replies: next.length === 0 ? undefined : next,
		});

	const addBlock = (type: MessageBlockType) =>
		onChange({ ...cfg, blocks: [...blocks, newBlock(type)] });

	return (
		<div className="flex flex-col gap-4 p-4">
			<ChannelBanner channel={channel} />

			<BlockList
				blocks={blocks}
				channel={channel}
				channelCapabilities={caps}
				onChange={setBlocks}
			/>

			<AddBlockButton
				channel={channel}
				channelCapabilities={caps}
				onAdd={addBlock}
			/>

			<QuickReplyEditor
				quickReplies={quickReplies}
				channel={channel}
				channelCapabilities={caps}
				onChange={setQuickReplies}
			/>

			<MessageSettings
				config={cfg}
				interactive={interactive}
				onChange={(patch) => onChange({ ...cfg, ...patch })}
			/>

			<div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => setShowPreview((v) => !v)}
					className="h-8 w-full gap-1 rounded-lg border border-[#d9dde6] bg-white text-[11px]"
				>
					{showPreview ? (
						<EyeOff className="size-3" />
					) : (
						<Eye className="size-3" />
					)}
					{showPreview ? "Hide preview" : "Show preview"}
				</Button>
			</div>

			{showPreview ? (
				<Preview config={cfg} channel={channel} channelCapabilities={caps} />
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Channel banner
// ---------------------------------------------------------------------------

function ChannelBanner({ channel }: { channel: string }) {
	return (
		<div className="rounded-xl border border-[#e6e9ef] bg-white px-3 py-2">
			<div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
				Channel
			</div>
			<div className="mt-0.5 text-[13px] font-medium text-[#353a44]">
				{channelDisplayName(channel)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Add block button
// ---------------------------------------------------------------------------

function AddBlockButton({
	channel,
	channelCapabilities,
	onAdd,
}: {
	channel: string;
	channelCapabilities?: ChannelCapabilities;
	onAdd(type: MessageBlockType): void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative">
			<Button
				type="button"
				variant="outline"
				onClick={() => setOpen((v) => !v)}
				className="h-9 w-full gap-1 rounded-lg border border-dashed border-[#c4d2ff] bg-[#f5f8ff] text-[12px] font-medium text-[#4f46e5] hover:bg-[#eef2ff]"
			>
				<Plus className="size-3.5" />
				Add block
			</Button>
			{open ? (
				<div
					className="absolute z-10 mt-1 w-full rounded-lg border border-[#e6e9ef] bg-white p-1 shadow-lg"
					onMouseLeave={() => setOpen(false)}
				>
					{ALL_BLOCK_TYPES.map((type) => {
						const supported = channelSupportsBlock(
							channel,
							type,
							channelCapabilities,
						);
						return (
							<button
								key={type}
								type="button"
								onClick={() => {
									onAdd(type);
									setOpen(false);
								}}
								className={cn(
									"flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-[#f5f8fc]",
									!supported && "opacity-60",
								)}
								title={
									supported
										? undefined
										: `Not supported on ${channelDisplayName(channel)} — block will be skipped at send time`
								}
							>
								<span className="font-medium text-[#1f2937]">
									{blockLabel(type)}
								</span>
								{!supported ? (
									<span className="text-[10px] text-amber-600">⚠ skipped</span>
								) : null}
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Message-level settings (Task N6)
// ---------------------------------------------------------------------------

function MessageSettings({
	config,
	interactive,
	onChange,
}: {
	config: MessageConfig;
	interactive: boolean;
	onChange(patch: Partial<MessageConfig>): void;
}) {
	const waitForReply = interactive ? true : config.wait_for_reply ?? false;
	const timeout = config.no_response_timeout_min;
	const typingDelay = config.typing_indicator_seconds ?? 0;

	return (
		<div className="rounded-xl border border-[#e6e9ef] bg-white p-4 space-y-4">
			<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
				Message settings
			</div>

			<label className="flex items-start gap-3 text-[12px] text-[#1f2937]">
				<input
					type="checkbox"
					checked={waitForReply}
					disabled={interactive}
					onChange={(e) =>
						onChange({ wait_for_reply: e.target.checked || undefined })
					}
					className="mt-0.5 h-4 w-4 rounded border-[#cdd5e1]"
				/>
				<span className="flex-1">
					<span className="font-medium">Wait for user reply</span>
					<span className="mt-0.5 block text-[11px] text-[#64748b]">
						{interactive
							? "Required — this message has interactive elements (branch buttons or quick replies)."
							: "Pauses the flow on an input port until the user responds or times out."}
					</span>
				</span>
			</label>

			{waitForReply ? (
				<div>
					<label className="mb-1 block text-[11px] font-medium text-[#475569]">
						No-response timeout (minutes)
					</label>
					<input
						type="number"
						min={0}
						value={timeout ?? ""}
						onChange={(e) => {
							const v = e.target.value;
							onChange({
								no_response_timeout_min:
									v === "" ? undefined : Math.max(0, Number(v)),
							});
						}}
						className="h-9 w-full rounded-lg border border-[#d9dde6] bg-white px-3 text-[12px]"
						placeholder="e.g. 60"
					/>
					<p className="mt-0.5 text-[10px] text-[#94a3b8]">
						Creates a <span className="font-mono">no_response</span> port when
						set.
					</p>
				</div>
			) : null}

			<div>
				<label className="mb-1 block text-[11px] font-medium text-[#475569]">
					Typing indicator ({typingDelay.toFixed(1)}s)
				</label>
				<input
					type="range"
					min={0}
					max={5}
					step={0.5}
					value={typingDelay}
					onChange={(e) =>
						onChange({
							typing_indicator_seconds:
								Number(e.target.value) === 0
									? undefined
									: Number(e.target.value),
						})
					}
					className="w-full"
				/>
				<p className="mt-0.5 text-[10px] text-[#94a3b8]">
					Shows a typing bubble before the first block is sent (0–5s).
				</p>
			</div>
		</div>
	);
}

// Re-export helpers that external consumers (property-panel.tsx, tests) use.
export {
	channelSupportsBlock,
	channelSupportsButtons,
	channelSupportsQuickReplies,
};
