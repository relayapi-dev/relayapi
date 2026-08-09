// subscribe_list / unsubscribe_list / opt_in_channel / opt_out_channel forms.

import { useMemo } from "react";
import { usePaginatedApi } from "@/hooks/use-api";
import type {
	OptInChannelAction,
	OptOutChannelAction,
	SubscribeListAction,
	SubscriptionChannel,
	UnsubscribeListAction,
} from "../types";
import { Field, FormShell, INPUT_CLS } from "./shared";

const CHANNELS: { key: SubscriptionChannel; label: string }[] = [
	{ key: "instagram", label: "Instagram" },
	{ key: "facebook", label: "Facebook Messenger" },
	{ key: "whatsapp", label: "WhatsApp" },
	{ key: "telegram", label: "Telegram" },
];

type ListActionProps = {
	action: SubscribeListAction | UnsubscribeListAction;
	automationWorkspaceId: string | null;
	onChange(next: SubscribeListAction | UnsubscribeListAction): void;
	error?: string | null;
};

export interface SubscriptionListPickerRow {
	id: string;
	name: string;
	channel: string;
	workspace_id: string | null;
}

export function subscriptionListsForWorkspace(
	lists: SubscriptionListPickerRow[],
	workspaceId: string | null,
): SubscriptionListPickerRow[] {
	return lists.filter((list) => (list.workspace_id ?? null) === workspaceId);
}

const CHANNEL_LABELS: Record<string, string> = {
	instagram: "Instagram",
	facebook: "Facebook Messenger",
	whatsapp: "WhatsApp",
	telegram: "Telegram",
	tiktok: "TikTok",
};

export function ListSubscriptionForm({
	action,
	automationWorkspaceId,
	onChange,
	error,
}: ListActionProps) {
	const library = usePaginatedApi<SubscriptionListPickerRow>(
		"subscription-lists",
		{
			limit: 100,
			query: { workspace_id: automationWorkspaceId ?? undefined },
		},
	);
	const lists = useMemo(
		() => subscriptionListsForWorkspace(library.data, automationWorkspaceId),
		[library.data, automationWorkspaceId],
	);
	const currentIsMissing =
		action.list_id.length > 0 &&
		!lists.some((list) => list.id === action.list_id);
	const canPick = library.loading || lists.length > 0 || library.hasMore;
	const description = library.error
		? "List library unavailable — paste a list ID manually."
		: lists.length === 0 && library.hasMore
			? "Load more to find a list in this automation's scope."
			: lists.length === 0 && !library.loading
				? "No subscription lists exist in this automation's scope yet."
				: "Pick a subscription list in this automation's scope.";

	return (
		<FormShell>
			<Field
				label="Subscription list"
				required
				description={description}
				error={error}
			>
				{canPick ? (
					<div className="space-y-1">
						<select
							value={action.list_id}
							onChange={(event) =>
								onChange({ ...action, list_id: event.target.value })
							}
							disabled={library.loading}
							className={INPUT_CLS}
						>
							<option value="">
								{library.loading
									? "Loading subscription lists…"
									: "Select a list…"}
							</option>
							{currentIsMissing ? (
								<option value={action.list_id}>
									Current selection · {action.list_id}
								</option>
							) : null}
							{lists.map((list) => (
								<option key={list.id} value={list.id}>
									{list.name} · {CHANNEL_LABELS[list.channel] ?? list.channel}
								</option>
							))}
						</select>
						{library.hasMore ? (
							<button
								type="button"
								onClick={() => void library.loadMore()}
								disabled={library.loadingMore}
								className="text-[10px] font-medium text-[#5a6373] hover:text-[#1f2937] disabled:opacity-50"
							>
								{library.loadingMore ? "Loading more…" : "Load more lists"}
							</button>
						) : null}
					</div>
				) : (
					<input
						type="text"
						value={action.list_id}
						onChange={(event) =>
							onChange({ ...action, list_id: event.target.value })
						}
						placeholder="lst_..."
						className={INPUT_CLS}
					/>
				)}
			</Field>
		</FormShell>
	);
}

type ChannelActionProps = {
	action: OptInChannelAction | OptOutChannelAction;
	onChange(next: OptInChannelAction | OptOutChannelAction): void;
};

export function ChannelOptForm({ action, onChange }: ChannelActionProps) {
	return (
		<FormShell>
			<Field label="Channel" required>
				<select
					value={action.channel}
					onChange={(e) =>
						onChange({
							...action,
							channel: e.target.value as SubscriptionChannel,
						})
					}
					className={INPUT_CLS}
				>
					{CHANNELS.map((c) => (
						<option key={c.key} value={c.key}>
							{c.label}
						</option>
					))}
				</select>
			</Field>
		</FormShell>
	);
}
