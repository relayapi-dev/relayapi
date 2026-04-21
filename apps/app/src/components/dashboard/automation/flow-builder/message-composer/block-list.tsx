// Block list (Plan 2 — Unit B3, Task N1).
//
// Renders each `MessageBlock` in sequence, with move-up / move-down / delete
// controls. The parent composer owns the array; this component just emits
// the full `next` array via `onChange` whenever the user edits a block or
// re-orders them.
//
// `@dnd-kit/sortable` is available in the workspace but we intentionally use
// plain move buttons here for v1 — they're keyboard-accessible and avoid the
// pointer-sensor test-setup cost. Drag-and-drop can be layered on later
// without changing the parent contract.

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChannelCapabilities } from "../use-catalog";
import { BlockEditor, blockLabel } from "./block-editors";
import { reorder, type MessageBlock } from "./types";

interface Props {
	blocks: MessageBlock[];
	channel: string;
	channelCapabilities?: ChannelCapabilities;
	onChange(next: MessageBlock[]): void;
}

export function BlockList({
	blocks,
	channel,
	channelCapabilities,
	onChange,
}: Props) {
	if (blocks.length === 0) {
		return (
			<div className="rounded-xl border border-dashed border-[#d9dde6] bg-[#fbfcfe] p-6 text-center">
				<p className="text-[12px] text-[#64748b]">
					No blocks yet. Use{" "}
					<span className="font-semibold">+ Add block</span> below to add the
					first one.
				</p>
			</div>
		);
	}

	const updateAt = (idx: number, next: MessageBlock) => {
		const copy = blocks.slice();
		copy[idx] = next;
		onChange(copy);
	};
	const removeAt = (idx: number) => {
		onChange(blocks.filter((_, i) => i !== idx));
	};
	const move = (from: number, to: number) => {
		onChange(reorder(blocks, from, to));
	};

	return (
		<div className="space-y-3">
			{blocks.map((block, idx) => (
				<div
					key={block.id}
					className="rounded-xl border border-[#e6e9ef] bg-white p-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
				>
					<div className="mb-2 flex items-center justify-between">
						<div className="flex items-center gap-2">
							<span className="rounded-md bg-[#f3eeff] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#6b46c1]">
								{idx + 1}. {blockLabel(block.type)}
							</span>
						</div>
						<div className="flex items-center gap-1">
							<button
								type="button"
								onClick={() => move(idx, idx - 1)}
								disabled={idx === 0}
								className={cn(
									"rounded p-1 text-[#94a3b8] hover:bg-[#f5f8fc] hover:text-[#334155]",
									idx === 0 && "opacity-30 hover:bg-transparent",
								)}
								aria-label="Move block up"
							>
								<ArrowUp className="size-3.5" />
							</button>
							<button
								type="button"
								onClick={() => move(idx, idx + 1)}
								disabled={idx === blocks.length - 1}
								className={cn(
									"rounded p-1 text-[#94a3b8] hover:bg-[#f5f8fc] hover:text-[#334155]",
									idx === blocks.length - 1 &&
										"opacity-30 hover:bg-transparent",
								)}
								aria-label="Move block down"
							>
								<ArrowDown className="size-3.5" />
							</button>
							<button
								type="button"
								onClick={() => removeAt(idx)}
								className="rounded p-1 text-[#94a3b8] hover:bg-[#fde8e8] hover:text-destructive"
								aria-label="Remove block"
							>
								<Trash2 className="size-3.5" />
							</button>
						</div>
					</div>
					<BlockEditor
						block={block}
						channel={channel}
						channelCapabilities={channelCapabilities}
						onChange={(next) => updateAt(idx, next)}
					/>
				</div>
			))}
		</div>
	);
}
