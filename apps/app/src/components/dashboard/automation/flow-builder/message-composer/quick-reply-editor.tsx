// Quick-reply editor (Plan 2 — Unit B3, Task N3).
//
// Message-level list of quick replies. Each reply creates a
// `quick_reply.<id>` port on the message node at save time.

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INPUT_CLS } from "../field-styles";
import { channelDisplayName, channelSupportsQuickReplies } from "../channel-capabilities";
import type { ChannelCapabilities } from "../use-catalog";
import { newQuickReply, type QuickReply } from "./types";

interface Props {
	quickReplies: QuickReply[];
	channel: string;
	channelCapabilities?: ChannelCapabilities;
	onChange(next: QuickReply[]): void;
}

const MAX_LABEL = 20;

export function QuickReplyEditor({
	quickReplies,
	channel,
	channelCapabilities,
	onChange,
}: Props) {
	const supported = channelSupportsQuickReplies(channel, channelCapabilities);

	if (!supported) {
		return (
			<div className="rounded-xl border border-[#e6e9ef] bg-white p-4">
				<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
					Quick replies
				</div>
				<p className="mt-2 text-[11px] text-[#94a3b8]">
					Quick replies are not supported on {channelDisplayName(channel)}. Add
					branch buttons on a text or card block instead.
				</p>
			</div>
		);
	}

	const update = (next: QuickReply[]) => onChange(next);

	return (
		<div className="rounded-xl border border-[#e6e9ef] bg-white p-4">
			<div className="flex items-center justify-between">
				<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
					Quick replies
				</div>
				<span className="text-[10px] text-[#94a3b8]">
					{quickReplies.length}
				</span>
			</div>
			<p className="mt-1 text-[10px] text-[#94a3b8]">
				Message-level list. Each reply creates a{" "}
				<span className="font-mono">quick_reply.&lt;id&gt;</span> port.
			</p>

			<div className="mt-3 space-y-2">
				{quickReplies.map((qr, idx) => (
					<div
						key={qr.id}
						className="flex items-start gap-2 rounded-lg border border-[#e6e9ef] bg-[#fbfcfe] p-2"
					>
						<div className="w-7">
							<label className="mb-1 block text-[10px] font-medium text-[#64748b]">
								Icon
							</label>
							<input
								type="text"
								value={qr.icon ?? ""}
								maxLength={2}
								onChange={(e) => {
									const copy = quickReplies.slice();
									copy[idx] = {
										...qr,
										icon: e.target.value || undefined,
									};
									update(copy);
								}}
								className="h-9 w-full rounded border border-[#d9dde6] bg-white text-center text-[14px]"
								placeholder=""
								aria-label="Emoji"
							/>
						</div>
						<div className="flex-1">
							<label className="mb-1 block text-[10px] font-medium text-[#64748b]">
								Label
							</label>
							<input
								type="text"
								value={qr.label}
								maxLength={MAX_LABEL}
								onChange={(e) => {
									const copy = quickReplies.slice();
									copy[idx] = {
										...qr,
										label: e.target.value.slice(0, MAX_LABEL),
									};
									update(copy);
								}}
								className={INPUT_CLS}
								placeholder="Reply label"
							/>
							<p className="mt-0.5 text-[10px] text-[#94a3b8]">
								{qr.label.length}/{MAX_LABEL}
							</p>
						</div>
						<button
							type="button"
							onClick={() => update(quickReplies.filter((_, i) => i !== idx))}
							className="mt-5 text-[#94a3b8] hover:text-destructive"
							aria-label="Remove quick reply"
						>
							<Trash2 className="size-3.5" />
						</button>
					</div>
				))}
			</div>

			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={() => update([...quickReplies, newQuickReply()])}
				className="mt-2 h-8 w-full gap-1 rounded-lg border border-dashed border-[#d9dde6] text-[11px] hover:bg-accent/30"
			>
				<Plus className="size-3" />
				Add quick reply
			</Button>
		</div>
	);
}
