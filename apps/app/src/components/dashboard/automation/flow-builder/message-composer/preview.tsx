// Client-side preview (Plan 2 — Unit B3, Task N5).
//
// Phone-frame mock. Renders blocks & quick replies with merge tags filled
// in using `PREVIEW_MERGE_CONTEXT`. No backend call — pure client render.

import { cn } from "@/lib/utils";
import { channelDisplayName, channelSupportsBlock } from "../channel-capabilities";
import type { ChannelCapabilities } from "../use-catalog";
import { resolveMergeTags, PREVIEW_MERGE_CONTEXT } from "./merge-tags";
import type { MessageBlock, MessageConfig, QuickReply } from "./types";

interface Props {
	config: MessageConfig;
	channel: string;
	channelCapabilities?: ChannelCapabilities;
}

function resolveText(text: string): string {
	return resolveMergeTags(text, PREVIEW_MERGE_CONTEXT);
}

export function Preview({ config, channel, channelCapabilities }: Props) {
	const blocks = config.blocks ?? [];
	const qrs = config.quick_replies ?? [];
	return (
		<div className="rounded-xl border border-[#e6e9ef] bg-[#fbfcfe] p-4">
			<div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#64748b]">
				Preview · {channelDisplayName(channel)}
			</div>
			<div className="mx-auto w-full max-w-[320px] rounded-3xl border-4 border-[#1f2937] bg-white p-3 shadow-sm">
				<div className="rounded-2xl bg-[#f5f5f5] p-3 space-y-2">
					{blocks.length === 0 && qrs.length === 0 ? (
						<p className="py-6 text-center text-[11px] text-[#94a3b8]">
							Empty message
						</p>
					) : null}
					{blocks.map((block) => (
						<PreviewBlock
							key={block.id}
							block={block}
							channel={channel}
							channelCapabilities={channelCapabilities}
						/>
					))}
					{qrs.length > 0 ? <PreviewQuickReplies replies={qrs} /> : null}
				</div>
			</div>
			<p className="mt-2 text-center text-[10px] text-[#94a3b8]">
				Merge tags use placeholder values (e.g. {"{{"}contact.first_name{"}} "}
				= John).
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

function PreviewBlock({
	block,
	channel,
	channelCapabilities,
}: {
	block: MessageBlock;
	channel: string;
	channelCapabilities?: ChannelCapabilities;
}) {
	if (
		block.type !== "text" &&
		block.type !== "delay" &&
		!channelSupportsBlock(channel, block.type, channelCapabilities)
	) {
		return (
			<div className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
				⚠ {cap(block.type)} skipped on {channelDisplayName(channel)}
			</div>
		);
	}

	switch (block.type) {
		case "text":
			return (
				<div className="rounded-2xl bg-white px-3 py-2 shadow-sm">
					<p className="whitespace-pre-wrap text-[12px] leading-5 text-[#1f2937]">
						{resolveText(block.text) || (
							<span className="text-[#94a3b8]">(empty text)</span>
						)}
					</p>
					{block.buttons && block.buttons.length > 0 ? (
						<div className="mt-2 grid gap-1">
							{block.buttons.map((b) => (
								<div
									key={b.id}
									className={cn(
										"rounded-full border px-3 py-1 text-center text-[11px] font-medium",
										b.type === "branch"
											? "border-[#c5b3f2] bg-[#ede4ff] text-[#6b46c1]"
											: "border-[#bfdbfe] bg-[#eff6ff] text-[#1d4ed8]",
									)}
								>
									{resolveText(b.label) || "(button)"}
								</div>
							))}
						</div>
					) : null}
				</div>
			);
		case "image":
		case "video":
			return (
				<div className="rounded-2xl bg-white p-2 shadow-sm">
					<div className="flex h-24 items-center justify-center rounded-lg bg-[#e2e8f0] text-[10px] text-[#64748b]">
						{block.type === "image" ? "image" : "video"}
					</div>
					{block.caption ? (
						<p className="mt-1 text-[11px] text-[#334155]">
							{resolveText(block.caption)}
						</p>
					) : null}
				</div>
			);
		case "audio":
			return (
				<div className="rounded-2xl bg-white px-3 py-2 text-[11px] text-[#475569] shadow-sm">
					🎵 Audio clip
				</div>
			);
		case "file":
			return (
				<div className="rounded-2xl bg-white px-3 py-2 text-[11px] text-[#475569] shadow-sm">
					📎 File attachment
				</div>
			);
		case "card":
			return (
				<div className="overflow-hidden rounded-2xl bg-white shadow-sm">
					<div className="flex h-24 items-center justify-center bg-[#e2e8f0] text-[10px] text-[#64748b]">
						image
					</div>
					<div className="px-3 py-2">
						<div className="text-[12px] font-semibold text-[#1f2937]">
							{resolveText(block.title) || "(title)"}
						</div>
						{block.subtitle ? (
							<div className="mt-0.5 text-[11px] text-[#64748b]">
								{resolveText(block.subtitle)}
							</div>
						) : null}
						{block.buttons && block.buttons.length > 0 ? (
							<div className="mt-2 grid gap-1">
								{block.buttons.map((b) => (
									<div
										key={b.id}
										className="rounded-full border border-[#c5b3f2] bg-[#ede4ff] px-3 py-1 text-center text-[11px] font-medium text-[#6b46c1]"
									>
										{resolveText(b.label) || "(button)"}
									</div>
								))}
							</div>
						) : null}
					</div>
				</div>
			);
		case "gallery":
			return (
				<div className="space-y-1">
					<div className="text-[10px] text-[#64748b]">
						Gallery ({block.cards.length} card
						{block.cards.length === 1 ? "" : "s"})
					</div>
					{block.cards.slice(0, 2).map((card) => (
						<PreviewBlock
							key={card.id}
							block={card}
							channel={channel}
							channelCapabilities={channelCapabilities}
						/>
					))}
					{block.cards.length > 2 ? (
						<div className="text-center text-[10px] text-[#94a3b8]">
							… {block.cards.length - 2} more
						</div>
					) : null}
				</div>
			);
		case "delay":
			return (
				<div className="flex items-center gap-1 py-1 text-[10px] text-[#94a3b8]">
					<span className="size-1.5 animate-pulse rounded-full bg-[#94a3b8]" />
					<span className="size-1.5 animate-pulse rounded-full bg-[#94a3b8]" />
					<span className="size-1.5 animate-pulse rounded-full bg-[#94a3b8]" />
					<span className="ml-1">typing {block.seconds}s</span>
				</div>
			);
	}
}

function PreviewQuickReplies({ replies }: { replies: QuickReply[] }) {
	return (
		<div className="flex flex-wrap gap-1 pt-1">
			{replies.map((qr) => (
				<div
					key={qr.id}
					className="inline-flex items-center gap-1 rounded-full border border-[#d9dde6] bg-white px-2 py-0.5 text-[11px] text-[#475569] shadow-sm"
				>
					{qr.icon ? <span>{qr.icon}</span> : null}
					<span>
						{resolveText(qr.label) || (
							<span className="text-[#94a3b8]">(reply)</span>
						)}
					</span>
				</div>
			))}
		</div>
	);
}

function cap(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
