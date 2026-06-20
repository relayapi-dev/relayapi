// Start Automation node editor.
//
// Mirrors `apps/api/src/services/automations/nodes/start-automation.ts`:
//   target_automation_id (req) · pass_context · entrypoint_id
// The target must be an *active* automation at runtime. We fetch the list via
// the SDK-backed `/api/automations` proxy and exclude the current automation.

import { useEffect, useState } from "react";
import {
	AdvancedDisclosure,
	CheckboxRow,
	Field,
	FormShell,
	INPUT_CLS,
} from "./shared";

interface StartAutomationConfig {
	target_automation_id?: string;
	pass_context?: boolean;
	entrypoint_id?: string;
}

interface AutomationRow {
	id: string;
	name: string;
	status: string;
}

interface ListResponse {
	data: AutomationRow[];
}

export function StartAutomationEditor({
	config,
	onChange,
	automationId,
}: {
	config: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
	automationId: string;
}) {
	const cfg = config as StartAutomationConfig;
	const patch = (p: Partial<StartAutomationConfig>) =>
		onChange({ ...config, ...p });

	const [rows, setRows] = useState<AutomationRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [manual, setManual] = useState(false);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch("/api/automations?limit=100");
				if (!res.ok) {
					if (!cancelled) setManual(true);
					return;
				}
				const body = (await res.json()) as ListResponse;
				if (!cancelled && Array.isArray(body.data)) setRows(body.data);
			} catch {
				if (!cancelled) setManual(true);
			} finally {
				if (!cancelled) setLoaded(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const options = rows.filter((r) => r.id !== automationId);
	const selectedMissing =
		!!cfg.target_automation_id &&
		!options.some((r) => r.id === cfg.target_automation_id);

	return (
		<FormShell>
			<Field
				label="Target automation"
				required
				description="The enrolled contact is added to this automation. It must be active to run."
			>
				{manual ? (
					<input
						type="text"
						value={cfg.target_automation_id ?? ""}
						onChange={(e) =>
							patch({ target_automation_id: e.target.value || undefined })
						}
						placeholder="auto_..."
						className={INPUT_CLS}
					/>
				) : !loaded ? (
					<select disabled className={INPUT_CLS}>
						<option>Loading automations…</option>
					</select>
				) : options.length === 0 ? (
					<input
						type="text"
						value={cfg.target_automation_id ?? ""}
						onChange={(e) =>
							patch({ target_automation_id: e.target.value || undefined })
						}
						placeholder="auto_..."
						className={INPUT_CLS}
					/>
				) : (
					<select
						value={cfg.target_automation_id ?? ""}
						onChange={(e) =>
							patch({ target_automation_id: e.target.value || undefined })
						}
						className={INPUT_CLS}
					>
						<option value="">Select an automation…</option>
						{selectedMissing ? (
							<option value={cfg.target_automation_id}>
								{cfg.target_automation_id} (unavailable)
							</option>
						) : null}
						{options.map((r) => (
							<option key={r.id} value={r.id}>
								{r.name}
								{r.status !== "active" ? ` (${r.status})` : ""}
							</option>
						))}
					</select>
				)}
			</Field>

			{!manual && loaded && options.length > 0 ? (
				<button
					type="button"
					onClick={() => setManual(true)}
					className="text-[11px] text-[#353a44] hover:underline"
				>
					Enter an ID manually
				</button>
			) : null}

			<CheckboxRow
				label="Pass context"
				description="Carry the current run's captured context into the new enrollment."
				checked={cfg.pass_context ?? false}
				onChange={(pass_context) => patch({ pass_context })}
			/>

			<AdvancedDisclosure>
				<Field
					label="Entrypoint ID"
					description="Optional — start at a specific entrypoint of the target automation."
				>
					<input
						type="text"
						value={cfg.entrypoint_id ?? ""}
						onChange={(e) =>
							patch({ entrypoint_id: e.target.value || undefined })
						}
						placeholder="ent_..."
						className={INPUT_CLS}
					/>
				</Field>
			</AdvancedDisclosure>
		</FormShell>
	);
}
