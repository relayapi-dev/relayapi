import { useMemo } from "react";
import { X, Zap } from "lucide-react";
import type {
	AutomationDetail,
	AutomationSchema,
	SchemaTriggerDef,
} from "./types";

const INPUT_CLS =
	"h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground";

interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	onChange: (
		patch: Partial<
			Pick<
				AutomationDetail,
				"trigger_type" | "trigger_config" | "trigger_filters"
			>
		>,
	) => void;
	onClose: () => void;
	readOnly?: boolean;
}

export function TriggerPanel({
	automation,
	schema,
	onChange,
	onClose,
	readOnly,
}: Props) {
	const triggersForChannel = useMemo<SchemaTriggerDef[]>(() => {
		return schema.triggers
			.filter((t) => t.channel === automation.channel)
			.sort((a, b) => a.type.localeCompare(b.type));
	}, [schema.triggers, automation.channel]);

	const selected = triggersForChannel.find((t) => t.type === automation.trigger_type);

	return (
		<div className="w-80 border-l border-border bg-card/30 flex flex-col overflow-hidden">
			<div className="px-3 py-2 border-b border-border flex items-center justify-between">
				<div className="flex items-center gap-1.5">
					<Zap className="size-3.5 text-emerald-600" />
					<div>
						<h3 className="text-xs font-medium">Trigger</h3>
						<p className="text-[10px] text-muted-foreground mt-0.5">
							What starts this automation
						</p>
					</div>
				</div>
				<button
					type="button"
					onClick={onClose}
					className="text-muted-foreground hover:text-foreground"
				>
					<X className="size-3.5" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
				<div>
					<label className="text-[10px] font-medium text-muted-foreground block mb-1">
						Channel
					</label>
					<div className="text-xs capitalize px-2 py-1.5 rounded-md bg-muted/40 border border-border">
						{automation.channel}
					</div>
					<p className="text-[10px] text-muted-foreground/70 mt-1">
						Channel is set at creation and can't be changed.
					</p>
				</div>

				<div>
					<label className="text-[10px] font-medium text-muted-foreground block mb-1">
						Trigger type <span className="text-destructive">*</span>
					</label>
					<select
						value={automation.trigger_type}
						disabled={readOnly}
						onChange={(e) => onChange({ trigger_type: e.target.value })}
						className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs disabled:opacity-60"
					>
						{triggersForChannel.map((t) => (
							<option key={t.type} value={t.type}>
								{t.type.replace(/_/g, " ")}
							</option>
						))}
					</select>
					{selected?.description && (
						<p className="text-[10px] text-muted-foreground mt-1">
							{selected.description}
						</p>
					)}
				</div>

				<div className="border-t border-border pt-3">
					<label className="text-[10px] font-medium text-muted-foreground block mb-1">
						Trigger config (JSON)
					</label>
					<JsonField
						value={automation.trigger_config}
						onChange={(v) => onChange({ trigger_config: v })}
						readOnly={readOnly}
					/>
					<p className="text-[10px] text-muted-foreground/70 mt-1">
						e.g. keywords, post IDs, or other trigger-specific filters.
					</p>
				</div>

				<div>
					<label className="text-[10px] font-medium text-muted-foreground block mb-1">
						Filters (JSON)
					</label>
					<JsonField
						value={automation.trigger_filters}
						onChange={(v) => onChange({ trigger_filters: v })}
						readOnly={readOnly}
					/>
					<p className="text-[10px] text-muted-foreground/70 mt-1">
						Optional filter group applied to incoming events.
					</p>
				</div>
			</div>
		</div>
	);
}

function JsonField({
	value,
	onChange,
	readOnly,
}: {
	value: unknown;
	onChange: (v: unknown) => void;
	readOnly?: boolean;
}) {
	const text =
		value == null
			? ""
			: (() => {
					try {
						return JSON.stringify(value, null, 2);
					} catch {
						return String(value);
					}
				})();
	return (
		<textarea
			defaultValue={text}
			disabled={readOnly}
			onBlur={(e) => {
				const v = e.target.value.trim();
				if (v === "") {
					onChange(undefined);
					return;
				}
				try {
					onChange(JSON.parse(v));
				} catch {
					// Keep last valid value if invalid JSON; do not propagate
				}
			}}
			rows={4}
			className={
				INPUT_CLS.replace("h-7", "h-auto") +
				" font-mono py-1.5 resize-y disabled:opacity-60"
			}
		/>
	);
}
