// Condition node editor.
//
// Mirrors `apps/api/src/services/automations/nodes/condition.ts`: evaluates a
// FilterGroup-shaped predicate tree stored at `config.predicates` and routes
// through the `true` / `false` port. Reuses the shared FilterGroupEditor.

import {
	type FilterGroup,
	FilterGroupEditor,
} from "../filter-group-editor";
import { Field, FormShell } from "./shared";

interface ConditionConfig {
	predicates?: FilterGroup;
}

export function ConditionEditor({
	config,
	onChange,
}: {
	config: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}) {
	const cfg = config as ConditionConfig;

	return (
		<FormShell>
			<Field
				label="Predicates"
				description="Routes through the True port when the expression matches, otherwise False. Reference fields like `tags`, `state.last_http_response.status`, or contact attributes."
			>
				<FilterGroupEditor
					value={cfg.predicates}
					onChange={(predicates) => onChange({ ...config, predicates })}
				/>
			</Field>
		</FormShell>
	);
}
