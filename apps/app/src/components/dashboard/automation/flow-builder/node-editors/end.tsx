import { Field, FormShell, INPUT_CLS } from "./shared";

export function EndEditor({
	config,
	onChange,
}: {
	config: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}) {
	return (
		<FormShell>
			<Field label="Exit reason" description="Stored on the completed run">
				<input
					type="text"
					value={typeof config.reason === "string" ? config.reason : ""}
					onChange={(event) =>
						onChange({ ...config, reason: event.target.value || undefined })
					}
					className={INPUT_CLS}
					placeholder="completed"
				/>
			</Field>
		</FormShell>
	);
}
