// log_conversion_event form.

import {
	MergeTagPicker,
	useMergeTagInput,
} from "../../message-composer/merge-tag-picker";
import type { LogConversionEventAction } from "../types";
import { Field, FormShell, INPUT_CLS } from "./shared";

type Props = {
	action: LogConversionEventAction;
	onChange(next: LogConversionEventAction): void;
	errors?: Record<string, string>;
};

export function LogConversionForm({ action, onChange, errors }: Props) {
	const valueMerge = useMergeTagInput<HTMLInputElement>(
		action.value ?? "",
		(next) => onChange({ ...action, value: next || undefined }),
	);
	return (
		<FormShell>
			<Field
				label="Event name"
				required
				description="Identifier forwarded to analytics/conversion pipelines."
				error={errors?.event_name}
			>
				<input
					type="text"
					value={action.event_name}
					onChange={(e) =>
						onChange({ ...action, event_name: e.target.value })
					}
					placeholder="e.g. booked_call"
					className={INPUT_CLS}
				/>
			</Field>

			<Field
				label="Value"
				description="Optional — merge tags supported (e.g. `{{context.amount}}`)."
				right={<MergeTagPicker onPick={valueMerge.insertAtCursor} />}
			>
				<input
					ref={valueMerge.inputRef}
					type="text"
					value={action.value ?? ""}
					onChange={(e) =>
						onChange({ ...action, value: e.target.value || undefined })
					}
					placeholder="e.g. 49.99"
					className={INPUT_CLS}
				/>
			</Field>

			<Field label="Currency" description="Optional ISO 4217 code.">
				<input
					type="text"
					maxLength={3}
					value={action.currency ?? ""}
					onChange={(e) =>
						onChange({
							...action,
							currency: e.target.value.toUpperCase() || undefined,
						})
					}
					placeholder="USD"
					className={INPUT_CLS}
				/>
			</Field>
		</FormShell>
	);
}
