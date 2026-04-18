import { useMemo } from "react";
import { Plus, Tag, Trash2, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
	AutomationDetail,
	AutomationSchema,
	SchemaTriggerDef,
} from "./types";
import { FieldRow, INPUT_CLS, parseFieldsSchema } from "./property-panel";

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

// Mirrors the TriggerFilters zod schema in apps/api/src/schemas/automations.ts.
// Keeping the shape here as a plain type so the panel can render a structured
// editor without pulling in the API package.
interface Predicate {
	field: string;
	op: PredicateOp;
	value?: unknown;
}
type PredicateOp =
	| "eq"
	| "neq"
	| "contains"
	| "not_contains"
	| "starts_with"
	| "ends_with"
	| "gt"
	| "gte"
	| "lt"
	| "lte"
	| "in"
	| "not_in"
	| "exists"
	| "not_exists";

interface FilterGroup {
	all?: Predicate[];
	any?: Predicate[];
	none?: Predicate[];
}

interface TriggerFiltersShape {
	tags_any?: string[];
	tags_all?: string[];
	tags_none?: string[];
	segment_id?: string;
	predicates?: FilterGroup;
}

const PREDICATE_OPS: { value: PredicateOp; label: string }[] = [
	{ value: "eq", label: "equals" },
	{ value: "neq", label: "not equals" },
	{ value: "contains", label: "contains" },
	{ value: "not_contains", label: "not contains" },
	{ value: "starts_with", label: "starts with" },
	{ value: "ends_with", label: "ends with" },
	{ value: "gt", label: ">" },
	{ value: "gte", label: "≥" },
	{ value: "lt", label: "<" },
	{ value: "lte", label: "≤" },
	{ value: "in", label: "in list" },
	{ value: "not_in", label: "not in list" },
	{ value: "exists", label: "exists" },
	{ value: "not_exists", label: "not exists" },
];

const VALUELESS_OPS: PredicateOp[] = ["exists", "not_exists"];
const LIST_OPS: PredicateOp[] = ["in", "not_in"];

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

					<PredicateGroupField
						label="Match all"
						helper="Event passes only if every predicate matches."
						value={filters.predicates?.all ?? []}
						onChange={(preds) =>
							setFilters({
								predicates: mergeGroup(filters.predicates, { all: preds }),
							})
						}
						readOnly={readOnly}
					/>
					<PredicateGroupField
						label="Match any"
						helper="Event passes if at least one predicate matches."
						value={filters.predicates?.any ?? []}
						onChange={(preds) =>
							setFilters({
								predicates: mergeGroup(filters.predicates, { any: preds }),
							})
						}
						readOnly={readOnly}
					/>
					<PredicateGroupField
						label="Match none"
						helper="Event fails if any predicate matches."
						value={filters.predicates?.none ?? []}
						onChange={(preds) =>
							setFilters({
								predicates: mergeGroup(filters.predicates, { none: preds }),
							})
						}
						readOnly={readOnly}
					/>
				</div>
			</div>
		</div>
	);
}

function mergeGroup(
	prev: FilterGroup | undefined,
	patch: Partial<FilterGroup>,
): FilterGroup | undefined {
	const next: FilterGroup = { ...(prev ?? {}), ...patch };
	for (const k of Object.keys(next) as (keyof FilterGroup)[]) {
		const v = next[k];
		if (!v || v.length === 0) delete next[k];
	}
	return Object.keys(next).length ? next : undefined;
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

function PredicateGroupField({
	label,
	helper,
	value,
	onChange,
	readOnly,
}: {
	label: string;
	helper: string;
	value: Predicate[];
	onChange: (preds: Predicate[]) => void;
	readOnly?: boolean;
}) {
	return (
		<div>
			<div className="flex items-center justify-between mb-1">
				<label className="text-[10px] font-medium text-muted-foreground">
					{label}
				</label>
				{value.length > 0 && (
					<span className="text-[10px] text-muted-foreground/70">
						{value.length}
					</span>
				)}
			</div>
			{value.length === 0 ? (
				<p className="text-[10px] text-muted-foreground/70 mb-1">{helper}</p>
			) : (
				<div className="space-y-1.5">
					{value.map((p, i) => (
						<PredicateRow
							key={i}
							value={p}
							onChange={(next) => {
								const copy = [...value];
								copy[i] = next;
								onChange(copy);
							}}
							onRemove={() => onChange(value.filter((_, idx) => idx !== i))}
							readOnly={readOnly}
						/>
					))}
				</div>
			)}
			{!readOnly && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() =>
						onChange([...value, { field: "", op: "eq", value: "" }])
					}
					className="mt-1.5 h-6 text-[10px] gap-1 w-full border border-dashed border-border hover:bg-accent/30"
				>
					<Plus className="size-3" />
					Add predicate
				</Button>
			)}
		</div>
	);
}

function PredicateRow({
	value,
	onChange,
	onRemove,
	readOnly,
}: {
	value: Predicate;
	onChange: (v: Predicate) => void;
	onRemove: () => void;
	readOnly?: boolean;
}) {
	const needsValue = !VALUELESS_OPS.includes(value.op);
	const isList = LIST_OPS.includes(value.op);

	const displayedValue = (() => {
		if (!needsValue) return "";
		if (isList && Array.isArray(value.value)) return value.value.join(", ");
		if (value.value == null) return "";
		if (typeof value.value === "object") {
			try {
				return JSON.stringify(value.value);
			} catch {
				return "";
			}
		}
		return String(value.value);
	})();

	const commitValue = (raw: string) => {
		if (!needsValue) {
			onChange({ ...value, value: undefined });
			return;
		}
		if (raw === "") {
			onChange({ ...value, value: undefined });
			return;
		}
		if (isList) {
			const list = raw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			onChange({ ...value, value: list });
			return;
		}
		// Try to coerce number / boolean; otherwise keep as string.
		if (raw === "true") return onChange({ ...value, value: true });
		if (raw === "false") return onChange({ ...value, value: false });
		const n = Number(raw);
		if (raw.trim() !== "" && !Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(raw)) {
			return onChange({ ...value, value: n });
		}
		onChange({ ...value, value: raw });
	};

	return (
		<div className="rounded-md border border-border/60 bg-card/50 p-1.5 space-y-1">
			<div className="flex items-center gap-1">
				<input
					type="text"
					value={value.field}
					disabled={readOnly}
					onChange={(e) => onChange({ ...value, field: e.target.value })}
					placeholder="field (e.g. tags)"
					className={INPUT_CLS + " h-6 flex-1 disabled:opacity-60"}
				/>
				<select
					value={value.op}
					disabled={readOnly}
					onChange={(e) =>
						onChange({ ...value, op: e.target.value as PredicateOp })
					}
					className="h-6 rounded-md border border-border bg-background px-1 text-[11px] disabled:opacity-60"
				>
					{PREDICATE_OPS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
				<button
					type="button"
					onClick={onRemove}
					disabled={readOnly}
					className="text-muted-foreground hover:text-destructive disabled:opacity-30 p-1"
					aria-label="Remove predicate"
				>
					<Trash2 className="size-3" />
				</button>
			</div>
			{needsValue && (
				<input
					type="text"
					defaultValue={displayedValue}
					disabled={readOnly}
					key={value.op + "-" + displayedValue}
					onBlur={(e) => commitValue(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commitValue(e.currentTarget.value);
						}
					}}
					placeholder={isList ? "value1, value2, ..." : "value"}
					className={INPUT_CLS + " h-6 disabled:opacity-60"}
				/>
			)}
		</div>
	);
}
