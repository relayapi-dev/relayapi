import { useMemo } from "react";
import { Tag, X, Zap } from "lucide-react";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type {
	AutomationDetail,
	AutomationSchema,
	SchemaTriggerDef,
} from "./types";
import {
	FilterGroupEditor,
	type FilterGroup,
} from "./filter-group-editor";
import { INPUT_CLS } from "./field-styles";
import { FieldRow, parseFieldsSchema } from "./property-panel";

interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	onChange: (
		patch: Partial<
			Pick<
				AutomationDetail,
				"trigger_type" | "trigger_config" | "trigger_filters" | "social_account_id"
			>
		>,
	) => void;
	onClose: () => void;
	readOnly?: boolean;
}

interface TriggerFiltersShape {
	tags_any?: string[];
	tags_all?: string[];
	tags_none?: string[];
	segment_id?: string;
	predicates?: FilterGroup;
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

	const selected = triggersForChannel.find(
		(t) => t.type === automation.trigger_type,
	);

	const configFields = useMemo(
		() => (selected ? parseFieldsSchema(selected.config_schema) : []),
		[selected],
	);

	const config = useMemo<Record<string, unknown>>(
		() =>
			automation.trigger_config && typeof automation.trigger_config === "object"
				? (automation.trigger_config as Record<string, unknown>)
				: {},
		[automation.trigger_config],
	);

	const filters = useMemo<TriggerFiltersShape>(
		() =>
			automation.trigger_filters &&
			typeof automation.trigger_filters === "object"
				? (automation.trigger_filters as TriggerFiltersShape)
				: {},
		[automation.trigger_filters],
	);

	const setConfigField = (name: string, v: unknown) => {
		const next = { ...config };
		if (v === undefined || v === null || v === "") delete next[name];
		else next[name] = v;
		onChange({
			trigger_config: Object.keys(next).length ? next : undefined,
		});
	};

	const setFilters = (patch: Partial<TriggerFiltersShape>) => {
		const next: TriggerFiltersShape = { ...filters, ...patch };
		for (const k of Object.keys(next) as (keyof TriggerFiltersShape)[]) {
			const v = next[k];
			if (v === undefined || v === null) {
				delete next[k];
			} else if (Array.isArray(v) && v.length === 0) {
				delete next[k];
			} else if (
				typeof v === "object" &&
				!Array.isArray(v) &&
				Object.keys(v).length === 0
			) {
				delete next[k];
			}
		}
		onChange({
			trigger_filters: Object.keys(next).length ? next : undefined,
		});
	};

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

			<ScrollArea className="flex-1">
				<div className="px-3 py-3 space-y-3">
				<div className="rounded-lg border border-border/80 bg-muted/30 px-3 py-2">
					<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
						Trigger binding
					</div>
					<p className="mt-1 text-[10px] text-muted-foreground/80">
						Bind the trigger to the connected social account that should receive the
						event. Comment, DM, and message triggers need a bound account to enroll
						contacts reliably.
					</p>
				</div>

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
						onChange={(e) =>
							onChange({
								trigger_type: e.target.value,
								trigger_config: undefined,
							})
						}
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

				<div>
					<label className="text-[10px] font-medium text-muted-foreground block mb-1">
						Account
					</label>
					<div className={cn(readOnly && "pointer-events-none opacity-60")}>
						<AccountSearchCombobox
							value={automation.social_account_id ?? null}
							onSelect={(accountId) =>
								onChange({ social_account_id: accountId })
							}
							platforms={
								automation.channel === "multi" ? undefined : [automation.channel]
							}
							showAllOption={false}
							placeholder="Select a connected account"
							variant="input"
						/>
					</div>
					<p className="text-[10px] text-muted-foreground/70 mt-1">
						The trigger and downstream messaging steps use this account unless a
						node defines a different platform-specific account strategy.
					</p>
				</div>

				<div className="border-t border-border pt-3">
					<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
						Config
					</div>
					{configFields.length === 0 ? (
						<p className="text-[10px] text-muted-foreground">
							This trigger has no additional configuration.
						</p>
					) : (
						<div className="space-y-3">
							{configFields.map((f) => (
								<FieldRow
									key={f.name}
									field={f}
									value={config[f.name]}
									onChange={(v) => setConfigField(f.name, v)}
								/>
							))}
						</div>
					)}
				</div>

				<div className="border-t border-border pt-3 space-y-3">
					<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
						Filters
					</div>
					<p className="text-[10px] text-muted-foreground/70 -mt-1">
						Only enroll events that match these filters.
					</p>

					<TagListField
						label="Match any of these tags"
						value={filters.tags_any ?? []}
						onChange={(tags) => setFilters({ tags_any: tags })}
						readOnly={readOnly}
					/>
					<TagListField
						label="Must have all these tags"
						value={filters.tags_all ?? []}
						onChange={(tags) => setFilters({ tags_all: tags })}
						readOnly={readOnly}
					/>
					<TagListField
						label="Exclude these tags"
						value={filters.tags_none ?? []}
						onChange={(tags) => setFilters({ tags_none: tags })}
						readOnly={readOnly}
					/>

					<div>
						<label className="text-[10px] font-medium text-muted-foreground block mb-1">
							Segment ID
						</label>
						<input
							type="text"
							value={filters.segment_id ?? ""}
							disabled={readOnly}
							onChange={(e) =>
								setFilters({ segment_id: e.target.value || undefined })
							}
							placeholder="seg_..."
							className={INPUT_CLS + " disabled:opacity-60"}
						/>
					</div>

					<FilterGroupEditor
						value={filters.predicates}
						onChange={(predicates) => setFilters({ predicates })}
						readOnly={readOnly}
					/>
				</div>
				</div>
			</ScrollArea>
		</div>
	);
}

function TagListField({
	label,
	value,
	onChange,
	readOnly,
}: {
	label: string;
	value: string[];
	onChange: (tags: string[]) => void;
	readOnly?: boolean;
}) {
	const commit = (el: HTMLInputElement) => {
		const raw = el.value.trim();
		if (!raw) return;
		const parts = raw
			.split(/[,\n]/)
			.map((s) => s.trim())
			.filter(Boolean);
		const next = Array.from(new Set([...value, ...parts]));
		onChange(next);
		el.value = "";
	};
	return (
		<div>
			<label className="text-[10px] font-medium text-muted-foreground block mb-1">
				{label}
			</label>
			<div className="flex flex-wrap gap-1 mb-1">
				{value.map((tag) => (
					<span
						key={tag}
						className="inline-flex items-center gap-1 rounded-md bg-muted/50 border border-border px-1.5 py-0.5 text-[11px]"
					>
						<Tag className="size-2.5 text-muted-foreground" />
						{tag}
						{!readOnly && (
							<button
								type="button"
								onClick={() => onChange(value.filter((t) => t !== tag))}
								className="text-muted-foreground hover:text-destructive"
								aria-label={`Remove ${tag}`}
							>
								<X className="size-2.5" />
							</button>
						)}
					</span>
				))}
			</div>
			<input
				type="text"
				disabled={readOnly}
				placeholder="Type a tag and press Enter"
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === ",") {
						e.preventDefault();
						commit(e.currentTarget);
					}
				}}
				onBlur={(e) => commit(e.currentTarget)}
				className={INPUT_CLS + " disabled:opacity-60"}
			/>
		</div>
	);
}
