// Go To node editor.
//
// Mirrors `apps/api/src/services/automations/nodes/goto.ts`: jumps to another
// node in the same graph by `config.target_node_key`.

import { Field, FormShell, INPUT_CLS } from "./shared";

interface GotoConfig {
	target_node_key?: string;
}

export interface NodeSummary {
	key: string;
	title?: string;
	kind: string;
}

export function GotoEditor({
	config,
	onChange,
	nodeSummaries,
	currentNodeKey,
}: {
	config: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
	nodeSummaries: NodeSummary[];
	currentNodeKey: string;
}) {
	const cfg = config as GotoConfig;
	const targets = nodeSummaries.filter(
		(n) => n.key !== currentNodeKey && n.kind !== "goto",
	);

	return (
		<FormShell>
			<Field
				label="Jump to node"
				required
				description="The run resumes at this node. Pick an earlier step to loop."
			>
				<select
					value={cfg.target_node_key ?? ""}
					onChange={(e) =>
						onChange({ ...config, target_node_key: e.target.value || undefined })
					}
					className={INPUT_CLS}
				>
					<option value="">Select a node…</option>
					{targets.map((n) => (
						<option key={n.key} value={n.key}>
							{n.title ? `${n.title} (${n.key})` : n.key}
						</option>
					))}
				</select>
			</Field>
		</FormShell>
	);
}
