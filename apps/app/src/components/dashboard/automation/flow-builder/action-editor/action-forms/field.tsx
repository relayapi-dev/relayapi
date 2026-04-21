// field_set / field_clear form.
//
// Fetches custom-field definitions from `/api/custom-fields` and renders
// them in a combobox. Falls back to free-text entry if the list is
// unavailable. For `field_set`, the value input supports the merge-tag
// picker (reused from the message composer).

import { useEffect, useMemo, useState } from "react";
import {
	MergeTagPicker,
	useMergeTagInput,
} from "../../message-composer/merge-tag-picker";
import type { FieldClearAction, FieldSetAction } from "../types";
import { Field, FormShell, INPUT_CLS } from "./shared";

interface CustomFieldRow {
	id: string;
	name: string;
	slug: string;
	type: string;
}

interface ListResponse {
	data: CustomFieldRow[];
}

type Props = {
	action: FieldSetAction | FieldClearAction;
	onChange(next: FieldSetAction | FieldClearAction): void;
	errors?: Record<string, string>;
};

export function FieldActionForm({ action, onChange, errors }: Props) {
	const [fields, setFields] = useState<CustomFieldRow[]>([]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch("/api/custom-fields?limit=200");
				if (!res.ok) return;
				const body = (await res.json()) as ListResponse;
				if (!cancelled && Array.isArray(body.data)) setFields(body.data);
			} catch {
				// fall back to free-text
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const fieldOptions = useMemo(() => fields.map((f) => f.slug).sort(), [fields]);

	return (
		<FormShell>
			<Field
				label="Custom field"
				required
				description="Custom field slug (key). Example: `shirt_size`."
				error={errors?.field}
			>
				<input
					list="action-custom-fields"
					type="text"
					value={action.field}
					onChange={(e) => onChange({ ...action, field: e.target.value })}
					placeholder="e.g. shirt_size"
					className={INPUT_CLS}
				/>
				<datalist id="action-custom-fields">
					{fieldOptions.map((slug) => (
						<option key={slug} value={slug} />
					))}
				</datalist>
			</Field>

			{action.type === "field_set" ? (
				<ValueField
					action={action}
					onChange={onChange}
					error={errors?.value}
				/>
			) : null}
		</FormShell>
	);
}

function ValueField({
	action,
	onChange,
	error,
}: {
	action: FieldSetAction;
	onChange(next: FieldSetAction): void;
	error?: string;
}) {
	const merge = useMergeTagInput<HTMLInputElement>(action.value, (next) =>
		onChange({ ...action, value: next }),
	);
	return (
		<Field
			label="Value"
			required
			description="Merge tags supported — e.g. `{{contact.first_name}}`."
			error={error}
			right={<MergeTagPicker onPick={merge.insertAtCursor} />}
		>
			<input
				ref={merge.inputRef}
				type="text"
				value={action.value}
				onChange={(e) => onChange({ ...action, value: e.target.value })}
				placeholder="Value (merge tags supported)"
				className={INPUT_CLS}
			/>
		</Field>
	);
}
