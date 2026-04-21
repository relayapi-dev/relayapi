// pause_automations_for_contact / resume_automations_for_contact forms.

import type {
	PauseAutomationsForContactAction,
	ResumeAutomationsForContactAction,
	Scope,
} from "../types";
import { Field, FormShell, INPUT_CLS } from "./shared";

const SCOPES: { key: Scope; label: string; description: string }[] = [
	{
		key: "current",
		label: "Current automation only",
		description: "Only pauses/resumes the automation that owns this action.",
	},
	{
		key: "global",
		label: "All automations",
		description: "Applies across every automation for this contact.",
	},
];

export function PauseContactForm({
	action,
	onChange,
	errors,
}: {
	action: PauseAutomationsForContactAction;
	onChange(next: PauseAutomationsForContactAction): void;
	errors?: Record<string, string>;
}) {
	return (
		<FormShell>
			<ScopeField
				scope={action.scope}
				onChange={(scope) => onChange({ ...action, scope })}
			/>
			<Field
				label="Duration (minutes)"
				description="Leave blank for an indefinite pause until resumed."
				error={errors?.duration_min}
			>
				<input
					type="number"
					min={0}
					value={action.duration_min ?? ""}
					onChange={(e) => {
						const v = e.target.value;
						onChange({
							...action,
							duration_min: v === "" ? undefined : Math.max(0, Number(v)),
						});
					}}
					placeholder="e.g. 1440"
					className={INPUT_CLS}
				/>
			</Field>
			<Field
				label="Reason"
				description="Optional note shown in contact pause history."
			>
				<input
					type="text"
					value={action.reason ?? ""}
					onChange={(e) =>
						onChange({ ...action, reason: e.target.value || undefined })
					}
					placeholder="e.g. opted out of nurture"
					className={INPUT_CLS}
				/>
			</Field>
		</FormShell>
	);
}

export function ResumeContactForm({
	action,
	onChange,
}: {
	action: ResumeAutomationsForContactAction;
	onChange(next: ResumeAutomationsForContactAction): void;
}) {
	return (
		<FormShell>
			<ScopeField
				scope={action.scope}
				onChange={(scope) => onChange({ ...action, scope })}
			/>
		</FormShell>
	);
}

function ScopeField({
	scope,
	onChange,
}: {
	scope: Scope;
	onChange(next: Scope): void;
}) {
	return (
		<Field
			label="Scope"
			required
			description={SCOPES.find((s) => s.key === scope)?.description}
		>
			<select
				value={scope}
				onChange={(e) => onChange(e.target.value as Scope)}
				className={INPUT_CLS}
			>
				{SCOPES.map((s) => (
					<option key={s.key} value={s.key}>
						{s.label}
					</option>
				))}
			</select>
		</Field>
	);
}
