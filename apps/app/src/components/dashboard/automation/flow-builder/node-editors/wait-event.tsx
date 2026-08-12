import {
	CheckboxRow,
	Field,
	FormShell,
	INPUT_CLS,
	numberOrUndefined,
} from "./shared";

const EVENT_OPTIONS = [
	[
		"dm_received",
		"Direct message",
		["instagram", "facebook", "whatsapp", "telegram"],
	],
	["comment_created", "Comment", ["instagram", "facebook"]],
	["story_reply", "Story reply", ["instagram", "facebook"]],
	["story_mention", "Story mention", ["instagram", "facebook"]],
	["live_comment", "Live comment", ["instagram", "facebook"]],
	["share_to_dm", "Share to DM", ["instagram"]],
	["ad_click", "Ad click", ["instagram", "facebook"]],
] as const;

interface WaitEventConfig {
	event_kinds?: string[];
	timeout_min?: number;
}

export function WaitEventEditor({
	config,
	onChange,
	channel,
}: {
	config: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
	channel: string;
}) {
	const cfg = config as WaitEventConfig;
	const selected = new Set(cfg.event_kinds ?? []);
	return (
		<FormShell>
			<Field label="Resume when">
				<div className="space-y-2 rounded-xl border border-[#e6e9ef] p-3">
					{EVENT_OPTIONS.filter(([, , channels]) =>
						channels.includes(channel as never),
					).map(([kind, label]) => (
						<CheckboxRow
							key={kind}
							label={label}
							checked={selected.has(kind)}
							onChange={(checked) => {
								const next = new Set(selected);
								if (checked) next.add(kind);
								else next.delete(kind);
								onChange({ ...config, event_kinds: Array.from(next) });
							}}
						/>
					))}
				</div>
			</Field>
			<Field
				label="Timeout (minutes)"
				description="Optional; routes through Timeout"
			>
				<input
					type="number"
					min={1}
					value={cfg.timeout_min ?? ""}
					onChange={(event) =>
						onChange({
							...config,
							timeout_min: numberOrUndefined(event.target.value),
						})
					}
					className={INPUT_CLS}
					placeholder="No timeout"
				/>
			</Field>
		</FormShell>
	);
}
