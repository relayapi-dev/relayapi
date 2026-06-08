// Delay node editor.
//
// Mirrors `apps/api/src/services/automations/nodes/delay.ts`:
//   seconds · minutes · hours · days  (summed; min 1s server-side)

import { Field, FormShell, INPUT_CLS, numberOrUndefined } from "./shared";

interface DelayConfig {
	seconds?: number;
	minutes?: number;
	hours?: number;
	days?: number;
}

const UNITS: { key: keyof DelayConfig; label: string; ms: number }[] = [
	{ key: "days", label: "Days", ms: 86_400_000 },
	{ key: "hours", label: "Hours", ms: 3_600_000 },
	{ key: "minutes", label: "Minutes", ms: 60_000 },
	{ key: "seconds", label: "Seconds", ms: 1_000 },
];

function formatTotal(ms: number): string {
	if (ms <= 0) return "No delay set";
	const parts: string[] = [];
	let rem = ms;
	for (const { label, ms: unitMs } of UNITS) {
		const n = Math.floor(rem / unitMs);
		if (n > 0) {
			parts.push(`${n} ${label.toLowerCase()}`);
			rem -= n * unitMs;
		}
	}
	return `Waits ${parts.join(", ")}`;
}

export function DelayEditor({
	config,
	onChange,
}: {
	config: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}) {
	const cfg = config as DelayConfig;

	const totalMs = UNITS.reduce(
		(sum, { key, ms }) => sum + (Number(cfg[key]) || 0) * ms,
		0,
	);

	return (
		<FormShell>
			<div className="grid grid-cols-2 gap-2">
				{UNITS.map(({ key, label }) => (
					<Field key={key} label={label}>
						<input
							type="number"
							min={0}
							value={cfg[key] ?? ""}
							onChange={(e) =>
								onChange({
									...config,
									[key]: numberOrUndefined(e.target.value),
								})
							}
							placeholder="0"
							className={INPUT_CLS}
						/>
					</Field>
				))}
			</div>
			<p className="text-[12px] font-medium text-[#4680ff]">
				{formatTotal(totalMs)}
			</p>
		</FormShell>
	);
}
