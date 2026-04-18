import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INPUT_CLS } from "./field-styles";

export interface Predicate {
	field: string;
	op: PredicateOp;
	value?: unknown;
}

export type PredicateOp =
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

export interface FilterGroup {
	all?: Predicate[];
	any?: Predicate[];
	none?: Predicate[];
}

interface PredicateGroupLabels {
	all: { label: string; helper: string };
	any: { label: string; helper: string };
	none: { label: string; helper: string };
}

const DEFAULT_LABELS: PredicateGroupLabels = {
	all: {
		label: "Match all",
		helper: "Passes only if every predicate matches.",
	},
	any: {
		label: "Match any",
		helper: "Passes if at least one predicate matches.",
	},
	none: {
		label: "Match none",
		helper: "Fails if any predicate matches.",
	},
};

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

export function mergeFilterGroup(
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

export function FilterGroupEditor({
	value,
	onChange,
	readOnly,
	labels = DEFAULT_LABELS,
}: {
	value: FilterGroup | undefined;
	onChange: (value: FilterGroup | undefined) => void;
	readOnly?: boolean;
	labels?: PredicateGroupLabels;
}) {
	return (
		<div className="space-y-3">
			<PredicateGroupField
				label={labels.all.label}
				helper={labels.all.helper}
				value={value?.all ?? []}
				onChange={(preds) =>
					onChange(mergeFilterGroup(value, { all: preds }))
				}
				readOnly={readOnly}
			/>
			<PredicateGroupField
				label={labels.any.label}
				helper={labels.any.helper}
				value={value?.any ?? []}
				onChange={(preds) =>
					onChange(mergeFilterGroup(value, { any: preds }))
				}
				readOnly={readOnly}
			/>
			<PredicateGroupField
				label={labels.none.label}
				helper={labels.none.helper}
				value={value?.none ?? []}
				onChange={(preds) =>
					onChange(mergeFilterGroup(value, { none: preds }))
				}
				readOnly={readOnly}
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
					{value.map((predicate, index) => (
						<PredicateRow
							key={`${predicate.field}-${predicate.op}-${index}`}
							value={predicate}
							onChange={(next) => {
								const copy = [...value];
								copy[index] = next;
								onChange(copy);
							}}
							onRemove={() => onChange(value.filter((_, idx) => idx !== index))}
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
	onChange: (value: Predicate) => void;
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
			onChange({
				...value,
				value: raw
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean),
			});
			return;
		}
		if (raw === "true") {
			onChange({ ...value, value: true });
			return;
		}
		if (raw === "false") {
			onChange({ ...value, value: false });
			return;
		}
		const parsed = Number(raw);
		if (raw.trim() !== "" && !Number.isNaN(parsed) && /^-?\d+(\.\d+)?$/.test(raw)) {
			onChange({ ...value, value: parsed });
			return;
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
					placeholder="field (e.g. tags, state.reply_text)"
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
					{PREDICATE_OPS.map((op) => (
						<option key={op.value} value={op.value}>
							{op.label}
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
