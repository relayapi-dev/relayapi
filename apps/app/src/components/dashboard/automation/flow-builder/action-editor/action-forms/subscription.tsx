// subscribe_list / unsubscribe_list / opt_in_channel / opt_out_channel forms.

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
	{ key: "tiktok", label: "TikTok" },
];

type ListActionProps = {
	action: SubscribeListAction | UnsubscribeListAction;
	onChange(next: SubscribeListAction | UnsubscribeListAction): void;
	error?: string | null;
};

export function ListSubscriptionForm({
	action,
	onChange,
	error,
}: ListActionProps) {
	return (
		<FormShell>
			<Field
				label="Subscription list"
				required
				description="Internal list ID. Dedicated list picker lands in v1.1."
				error={error}
			>
				<input
					type="text"
					value={action.list_id}
					onChange={(e) => onChange({ ...action, list_id: e.target.value })}
					placeholder="lst_..."
					className={INPUT_CLS}
				/>
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
