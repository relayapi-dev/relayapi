// Per-block editors (Plan 2 — Unit B3, Task N2).
//
// Each block type has a small editor. The parent (BlockList) owns the array
// of blocks; these editors emit a `next` block via `onChange`.

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INPUT_CLS } from "../field-styles";
import {
	channelSupportsBlock,
	capabilitiesFor,
	channelDisplayName,
	type BlockType,
} from "../channel-capabilities";
import type { ChannelCapabilities } from "../use-catalog";
import { ButtonEditor } from "./button-editor";
import { MergeTagPicker, useMergeTagInput } from "./merge-tag-picker";
import {
	newBlock,
	newButton,
	type BlockButton,
	type CardBlock,
	type MessageBlock,
} from "./types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function UnsupportedBanner({
	channel,
	blockType,
}: {
	channel: string;
	blockType: BlockType;
}) {
	return (
		<div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
			{blockType.charAt(0).toUpperCase() + blockType.slice(1)} blocks are not
			supported on {channelDisplayName(channel)} — this block will be skipped at
			send time.
		</div>
	);
}

// ---------------------------------------------------------------------------
// Text block
// ---------------------------------------------------------------------------

function TextBlockEditor({
	block,
	channel,
	channelCapabilities,
	onChange,
}: {
	block: Extract<MessageBlock, { type: "text" }>;
	channel: string;
	channelCapabilities?: ChannelCapabilities;
	onChange(next: MessageBlock): void;
}) {
	const buttonsSupported = capabilitiesFor(channel, channelCapabilities).buttons;
	const maxButtons =
		capabilitiesFor(channel, channelCapabilities).buttons_max ?? 3;
	const buttons = block.buttons ?? [];

	const merge = useMergeTagInput<HTMLTextAreaElement>(block.text, (next) =>
		onChange({ ...block, text: next }),
	);

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<label className="text-[11px] font-medium text-[#475569]">Text</label>
				<MergeTagPicker onPick={merge.insertAtCursor} />
			</div>
			<textarea
				ref={merge.inputRef}
				value={block.text}
				onChange={(e) => onChange({ ...block, text: e.target.value })}
				rows={4}
				className="w-full resize-y rounded-lg border border-[#d9dde6] bg-white px-3 py-2 text-[13px] outline-none focus:border-[#8ab4ff]"
				placeholder="Write your message. Type {{ or use the tag picker to insert merge tags."
			/>

			<div className="mt-3">
				<div className="flex items-center justify-between">
					<div className="text-[11px] font-medium text-[#475569]">
						Buttons
					</div>
					<span className="text-[10px] text-[#94a3b8]">
						{buttons.length}/{maxButtons}
					</span>
				</div>
				<div className="mt-2 space-y-2">
					{buttons.map((btn, idx) => (
						<ButtonEditor
							key={btn.id}
							button={btn}
							channelSupportsButtons={buttonsSupported}
							onChange={(next) => {
								const copy = buttons.slice();
								copy[idx] = next;
								onChange({ ...block, buttons: copy });
							}}
							onRemove={() => {
								const copy = buttons.filter((_, i) => i !== idx);
								onChange({
									...block,
									buttons: copy.length === 0 ? undefined : copy,
								});
							}}
						/>
					))}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={buttons.length >= maxButtons}
					onClick={() =>
						onChange({ ...block, buttons: [...buttons, newButton("branch")] })
					}
					className="mt-2 h-7 w-full gap-1 rounded-md border border-dashed border-[#d9dde6] text-[11px]"
				>
					<Plus className="size-3" />
					Add button
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Media blocks — image/video/audio/file — URL input + optional caption
// ---------------------------------------------------------------------------

function MediaBlockEditor({
	block,
	channel,
	channelCapabilities,
	onChange,
}: {
	block: Extract<
		MessageBlock,
		{ type: "image" | "video" | "audio" | "file" }
	>;
	channel: string;
	channelCapabilities?: ChannelCapabilities;
	onChange(next: MessageBlock): void;
}) {
	const supported = channelSupportsBlock(
		channel,
		block.type,
		channelCapabilities,
	);
	const captionSupported = block.type === "image" || block.type === "video";

	return (
		<div className="space-y-2">
			<div>
				<label className="mb-1 block text-[11px] font-medium text-[#475569]">
					Media URL
				</label>
				<input
					type="url"
					value={block.media_ref}
					onChange={(e) => onChange({ ...block, media_ref: e.target.value })}
					className={INPUT_CLS}
					placeholder="https://... or media ref"
				/>
				<p className="mt-0.5 text-[10px] text-[#94a3b8]">
					{/* TODO(v1.1): integrate media-library picker + upload (deferred from automation rebuild). */}
					For now paste a publicly reachable URL.
				</p>
			</div>
			{captionSupported ? (
				<div>
					<label className="mb-1 block text-[11px] font-medium text-[#475569]">
						Caption
					</label>
					<input
						type="text"
						value={
							"caption" in block && block.caption !== undefined
								? block.caption
								: ""
						}
						onChange={(e) =>
							onChange({
								...block,
								caption: e.target.value || undefined,
							} as MessageBlock)
						}
						className={INPUT_CLS}
						placeholder="Optional caption — merge tags supported"
					/>
				</div>
			) : null}
			{!supported ? <UnsupportedBanner channel={channel} blockType={block.type} /> : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Card block
// ---------------------------------------------------------------------------

function CardBlockEditor({
	block,
	channel,
	channelCapabilities,
	onChange,
}: {
	block: CardBlock;
	channel: string;
	channelCapabilities?: ChannelCapabilities;
	onChange(next: CardBlock): void;
}) {
	const supported = channelSupportsBlock(channel, "card", channelCapabilities);
	const buttonsSupported = capabilitiesFor(channel, channelCapabilities).buttons;
	const maxButtons =
		capabilitiesFor(channel, channelCapabilities).buttons_max ?? 3;
	const buttons = block.buttons ?? [];

	const updateButton = (idx: number, next: BlockButton) => {
		const copy = buttons.slice();
		copy[idx] = next;
		onChange({ ...block, buttons: copy });
	};

	const removeButton = (idx: number) => {
		const copy = buttons.filter((_, i) => i !== idx);
		onChange({ ...block, buttons: copy.length === 0 ? undefined : copy });
	};

	return (
		<div className="space-y-2">
			<div>
				<label className="mb-1 block text-[11px] font-medium text-[#475569]">
					Image URL
				</label>
				<input
					type="url"
					value={block.media_ref ?? ""}
					onChange={(e) =>
						onChange({ ...block, media_ref: e.target.value || undefined })
					}
					className={INPUT_CLS}
					placeholder="https://... (optional)"
				/>
			</div>

			<div>
				<label className="mb-1 block text-[11px] font-medium text-[#475569]">
					Title
				</label>
				<input
					type="text"
					value={block.title}
					maxLength={80}
					onChange={(e) =>
						onChange({ ...block, title: e.target.value.slice(0, 80) })
					}
					className={INPUT_CLS}
					placeholder="Card title"
				/>
			</div>

			<div>
				<label className="mb-1 block text-[11px] font-medium text-[#475569]">
					Subtitle
				</label>
				<input
					type="text"
					value={block.subtitle ?? ""}
					maxLength={80}
					onChange={(e) =>
						onChange({
							...block,
							subtitle: e.target.value.slice(0, 80) || undefined,
						})
					}
					className={INPUT_CLS}
					placeholder="Optional subtitle"
				/>
			</div>

			<div>
				<div className="flex items-center justify-between">
					<div className="text-[11px] font-medium text-[#475569]">Buttons</div>
					<span className="text-[10px] text-[#94a3b8]">
						{buttons.length}/{maxButtons}
					</span>
				</div>
				<div className="mt-2 space-y-2">
					{buttons.map((btn, idx) => (
						<ButtonEditor
							key={btn.id}
							button={btn}
							channelSupportsButtons={buttonsSupported}
							onChange={(next) => updateButton(idx, next)}
							onRemove={() => removeButton(idx)}
						/>
					))}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					disabled={buttons.length >= maxButtons}
					onClick={() =>
						onChange({ ...block, buttons: [...buttons, newButton("branch")] })
					}
					className="mt-2 h-7 w-full gap-1 rounded-md border border-dashed border-[#d9dde6] text-[11px]"
				>
					<Plus className="size-3" />
					Add button
				</Button>
			</div>

			{!supported ? <UnsupportedBanner channel={channel} blockType="card" /> : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Gallery — repeater of cards (max 10)
// ---------------------------------------------------------------------------

function GalleryBlockEditor({
	block,
	channel,
	channelCapabilities,
	onChange,
}: {
	block: Extract<MessageBlock, { type: "gallery" }>;
	channel: string;
	channelCapabilities?: ChannelCapabilities;
	onChange(next: MessageBlock): void;
}) {
	const supported = channelSupportsBlock(
		channel,
		"gallery",
		channelCapabilities,
	);
	const maxCards =
		capabilitiesFor(channel, channelCapabilities).gallery_max ?? 10;
	const cards = block.cards ?? [];

	const updateCard = (idx: number, next: CardBlock) => {
		const copy = cards.slice();
		copy[idx] = next;
		onChange({ ...block, cards: copy });
	};
	const removeCard = (idx: number) => {
		const copy = cards.filter((_, i) => i !== idx);
		if (copy.length === 0) return; // gallery needs at least one card
		onChange({ ...block, cards: copy });
	};
	const addCard = () => {
		if (cards.length >= maxCards) return;
		const blank = newBlock("card");
		if (blank.type !== "card") return;
		onChange({ ...block, cards: [...cards, blank] });
	};

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<div className="text-[11px] font-medium text-[#475569]">
					Gallery cards
				</div>
				<span className="text-[10px] text-[#94a3b8]">
					{cards.length}/{maxCards}
				</span>
			</div>
			<div className="space-y-3">
				{cards.map((card, idx) => (
					<div
						key={card.id}
						className="rounded-lg border border-[#e6e9ef] bg-[#fbfcfe] p-3"
					>
						<div className="mb-2 flex items-center justify-between">
							<div className="text-[11px] font-medium text-[#475569]">
								Card {idx + 1}
							</div>
							{cards.length > 1 ? (
								<button
									type="button"
									onClick={() => removeCard(idx)}
									className="text-[#94a3b8] hover:text-destructive"
									aria-label="Remove card"
								>
									<Trash2 className="size-3.5" />
								</button>
							) : null}
						</div>
						<CardBlockEditor
							block={card}
							channel={channel}
							channelCapabilities={channelCapabilities}
							onChange={(next) => updateCard(idx, next as CardBlock)}
						/>
					</div>
				))}
			</div>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={cards.length >= maxCards}
				onClick={addCard}
				className="h-7 w-full gap-1 rounded-md border border-dashed border-[#d9dde6] text-[11px]"
			>
				<Plus className="size-3" />
				Add card
			</Button>
			{!supported ? <UnsupportedBanner channel={channel} blockType="gallery" /> : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Delay block
// ---------------------------------------------------------------------------

function DelayBlockEditor({
	block,
	onChange,
}: {
	block: Extract<MessageBlock, { type: "delay" }>;
	onChange(next: MessageBlock): void;
}) {
	return (
		<div>
			<label className="mb-1 block text-[11px] font-medium text-[#475569]">
				Typing pause (seconds)
			</label>
			<input
				type="number"
				min={0.5}
				max={10}
				step={0.5}
				value={block.seconds}
				onChange={(e) => {
					const v = Number(e.target.value);
					if (Number.isNaN(v)) return;
					onChange({ ...block, seconds: Math.max(0.5, Math.min(10, v)) });
				}}
				className={INPUT_CLS}
			/>
			<p className="mt-0.5 text-[10px] text-[#94a3b8]">
				Simulates typing between 0.5 and 10 seconds.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

interface BlockEditorProps {
	block: MessageBlock;
	channel: string;
	channelCapabilities?: ChannelCapabilities;
	onChange(next: MessageBlock): void;
}

export function BlockEditor({
	block,
	channel,
	channelCapabilities,
	onChange,
}: BlockEditorProps) {
	switch (block.type) {
		case "text":
			return (
				<TextBlockEditor
					block={block}
					channel={channel}
					channelCapabilities={channelCapabilities}
					onChange={onChange}
				/>
			);
		case "image":
		case "video":
		case "audio":
		case "file":
			return (
				<MediaBlockEditor
					block={block}
					channel={channel}
					channelCapabilities={channelCapabilities}
					onChange={onChange}
				/>
			);
		case "card":
			return (
				<CardBlockEditor
					block={block}
					channel={channel}
					channelCapabilities={channelCapabilities}
					onChange={onChange}
				/>
			);
		case "gallery":
			return (
				<GalleryBlockEditor
					block={block}
					channel={channel}
					channelCapabilities={channelCapabilities}
					onChange={onChange}
				/>
			);
		case "delay":
			return <DelayBlockEditor block={block} onChange={onChange} />;
	}
}

export function blockLabel(type: MessageBlock["type"]): string {
	switch (type) {
		case "text":
			return "Text";
		case "image":
			return "Image";
		case "video":
			return "Video";
		case "audio":
			return "Audio";
		case "file":
			return "File";
		case "card":
			return "Card";
		case "gallery":
			return "Gallery";
		case "delay":
			return "Delay";
	}
}
