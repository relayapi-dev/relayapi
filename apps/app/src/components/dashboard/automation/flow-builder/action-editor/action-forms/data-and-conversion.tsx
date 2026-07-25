import type { ContactFieldSetAction, LogConversionEventAction } from "../types";
import { Field, FormShell, INPUT_CLS } from "./shared";

export function ContactFieldSetForm({
	action,
	onChange,
	errors,
}: {
	action: ContactFieldSetAction;
	onChange(next: ContactFieldSetAction): void;
	errors: Record<string, string>;
}) {
	return (
		<FormShell>
			<Field
				label="Contact field"
				htmlFor={`${action.id}-contact-field`}
				required
			>
				<select
					id={`${action.id}-contact-field`}
					className={INPUT_CLS}
					value={action.field}
					onChange={(event) =>
						onChange({
							...action,
							field: event.target.value as ContactFieldSetAction["field"],
						})
					}
				>
					<option value="name">Name</option>
					<option value="email">Email</option>
					<option value="phone">Phone</option>
				</select>
			</Field>
			<Field
				label="Value"
				htmlFor={`${action.id}-contact-value`}
				required
				error={errors.value}
				description="Merge tags such as {{contact.name}} are supported."
			>
				<input
					id={`${action.id}-contact-value`}
					className={INPUT_CLS}
					value={action.value}
					onChange={(event) =>
						onChange({ ...action, value: event.target.value })
					}
				/>
			</Field>
		</FormShell>
	);
}

export function ConversionEventForm({
	action,
	onChange,
	errors,
}: {
	action: LogConversionEventAction;
	onChange(next: LogConversionEventAction): void;
	errors: Record<string, string>;
}) {
	return (
		<FormShell>
			<Field
				label="Event name"
				htmlFor={`${action.id}-event-name`}
				required
				error={errors.event_name}
			>
				<input
					id={`${action.id}-event-name`}
					className={INPUT_CLS}
					value={action.event_name}
					placeholder="purchase"
					onChange={(event) =>
						onChange({ ...action, event_name: event.target.value })
					}
				/>
			</Field>
			<div className="grid grid-cols-[1fr_110px] gap-2">
				<Field
					label="Value (optional)"
					htmlFor={`${action.id}-event-value`}
					error={errors.value}
				>
					<input
						id={`${action.id}-event-value`}
						className={INPUT_CLS}
						value={action.value ?? ""}
						placeholder="49.00"
						onChange={(event) =>
							onChange({
								...action,
								value: event.target.value || undefined,
							})
						}
					/>
				</Field>
				<Field
					label="Currency"
					htmlFor={`${action.id}-event-currency`}
					error={errors.currency}
				>
					<input
						id={`${action.id}-event-currency`}
						className={INPUT_CLS}
						value={action.currency ?? ""}
						placeholder="GBP"
						maxLength={3}
						onChange={(event) =>
							onChange({
								...action,
								currency: event.target.value.toUpperCase() || undefined,
							})
						}
					/>
				</Field>
			</div>
		</FormShell>
	);
}
