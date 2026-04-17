import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AutomationNodeSpec, SchemaNodeDef } from "./types";

const INPUT_CLS =
	"h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground";

type PrimitiveArrayKind = "string" | "number" | "boolean";

interface ObjectArrayField {
	name: string;
	type: "string" | "number" | "boolean";
	required: boolean;
	enumValues?: string[];
}

interface ArraySpec {
	/** Leaf item shape. `object` = fixed-shape rows. */
	itemKind: PrimitiveArrayKind | "object" | "unknown";
	itemFields?: ObjectArrayField[];
	minItems?: number;
	maxItems?: number;
}

interface FieldDef {
	name: string;
	type: "string" | "number" | "boolean" | "textarea" | "enum" | "object" | "array";
	required: boolean;
	description?: string;
	enumValues?: string[];
	array?: ArraySpec;
}

function parseFieldsSchema(fieldsSchema: unknown): FieldDef[] {
	if (!fieldsSchema || typeof fieldsSchema !== "object") return [];
	const schema = fieldsSchema as {
		properties?: Record<string, unknown>;
		required?: unknown;
	};
	if (!schema.properties) return [];
	const required = new Set(
		Array.isArray(schema.required)
			? schema.required.filter((v): v is string => typeof v === "string")
			: [],
	);

	const out: FieldDef[] = [];
	for (const [name, raw] of Object.entries(schema.properties)) {
		const prop = (raw ?? {}) as {
			type?: string | string[];
			enum?: unknown[];
			description?: string;
			format?: string;
			items?: unknown;
			minItems?: number;
			maxItems?: number;
		};
		let type: FieldDef["type"] = "string";
		const t = Array.isArray(prop.type) ? prop.type[0] : prop.type;
		if (t === "number" || t === "integer") type = "number";
		else if (t === "boolean") type = "boolean";
		else if (t === "array") type = "array";
		else if (t === "object") type = "object";
		else if (prop.enum && Array.isArray(prop.enum)) type = "enum";
		else if (prop.format === "textarea" || name === "text" || name === "prompt" || name === "body")
			type = "textarea";

		const field: FieldDef = {
			name,
			type,
			required: required.has(name),
			description: prop.description,
			enumValues: Array.isArray(prop.enum)
				? prop.enum.filter((v): v is string => typeof v === "string")
				: undefined,
		};

		if (type === "array") field.array = parseArraySpec(prop.items, prop);
		out.push(field);
	}
	return out;
}

function parseArraySpec(
	items: unknown,
	parent: { minItems?: number; maxItems?: number },
): ArraySpec {
	const spec: ArraySpec = {
		itemKind: "unknown",
		minItems: parent.minItems,
		maxItems: parent.maxItems,
	};
	if (!items || typeof items !== "object") return spec;
	const it = items as {
		type?: string | string[];
		properties?: Record<string, unknown>;
		required?: unknown;
	};
	const t = Array.isArray(it.type) ? it.type[0] : it.type;
	if (t === "string") spec.itemKind = "string";
	else if (t === "number" || t === "integer") spec.itemKind = "number";
	else if (t === "boolean") spec.itemKind = "boolean";
	else if (t === "object") {
		spec.itemKind = "object";
		const req = new Set(
			Array.isArray(it.required)
				? it.required.filter((v): v is string => typeof v === "string")
				: [],
		);
		spec.itemFields = [];
		for (const [fname, fraw] of Object.entries(it.properties ?? {})) {
			const fp = (fraw ?? {}) as { type?: string | string[]; enum?: unknown[] };
			const ft = Array.isArray(fp.type) ? fp.type[0] : fp.type;
			let kind: ObjectArrayField["type"] = "string";
			if (ft === "number" || ft === "integer") kind = "number";
			else if (ft === "boolean") kind = "boolean";
			spec.itemFields.push({
				name: fname,
				type: kind,
				required: req.has(fname),
				enumValues: Array.isArray(fp.enum)
					? fp.enum.filter((v): v is string => typeof v === "string")
					: undefined,
			});
		}
	}
	return spec;
}

function defaultArrayItem(spec: ArraySpec): unknown {
	switch (spec.itemKind) {
		case "string":
			return "";
		case "number":
			return 0;
		case "boolean":
			return false;
		case "object": {
			const o: Record<string, unknown> = {};
			for (const f of spec.itemFields ?? []) {
				o[f.name] = f.type === "number" ? 0 : f.type === "boolean" ? false : "";
			}
			return o;
		}
		default:
			return null;
	}
}

interface Props {
	node: AutomationNodeSpec | null;
	nodeDef: SchemaNodeDef | null;
	onChange: (patch: Partial<AutomationNodeSpec>) => void;
	onDelete: () => void;
	onClose: () => void;
	existingKeys: string[];
}

export function PropertyPanel({
	node,
	nodeDef,
	onChange,
	onDelete,
	onClose,
	existingKeys,
}: Props) {
	const fields = useMemo(
		() => (nodeDef ? parseFieldsSchema(nodeDef.fields_schema) : []),
		[nodeDef],
	);

	const [localKey, setLocalKey] = useState(node?.key ?? "");
	useEffect(() => {
		setLocalKey(node?.key ?? "");
	}, [node?.key]);

	if (!node) {
		return (
			<div className="w-80 border-l border-border bg-card/30 flex items-center justify-center p-6">
				<p className="text-xs text-muted-foreground text-center">
					Select a node to edit its properties
				</p>
			</div>
		);
	}

	const keyIsValid =
		/^[a-zA-Z][a-zA-Z0-9_]*$/.test(localKey) &&
		(localKey === node.key || !existingKeys.includes(localKey));

	return (
		<div className="w-80 border-l border-border bg-card/30 flex flex-col overflow-hidden">
			<div className="px-3 py-2 border-b border-border flex items-center justify-between">
				<div>
					<h3 className="text-xs font-medium">{node.type.replace(/_/g, " ")}</h3>
					<p className="text-[10px] text-muted-foreground mt-0.5">
						{nodeDef?.description ?? "Node properties"}
					</p>
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
						Key <span className="text-destructive">*</span>
					</label>
					<input
						type="text"
						value={localKey}
						onChange={(e) => setLocalKey(e.target.value)}
						onBlur={() => {
							if (keyIsValid && localKey !== node.key) {
								onChange({ key: localKey });
							} else {
								setLocalKey(node.key);
							}
						}}
						className={INPUT_CLS}
					/>
					{!keyIsValid && (
						<p className="text-[10px] text-destructive mt-0.5">
							{existingKeys.includes(localKey) && localKey !== node.key
								? "Key already in use"
								: "Must start with a letter; only letters, digits, underscores"}
						</p>
					)}
				</div>

				<div>
					<label className="text-[10px] font-medium text-muted-foreground block mb-1">
						Notes
					</label>
					<input
						type="text"
						value={(node.notes as string) ?? ""}
						onChange={(e) => onChange({ notes: e.target.value })}
						className={INPUT_CLS}
						placeholder="Optional annotation"
					/>
				</div>

				<div className="border-t border-border pt-3 space-y-3">
					{fields.length === 0 && (
						<p className="text-[10px] text-muted-foreground">
							This node type has no additional configuration.
						</p>
					)}
					{fields.map((f) => (
						<FieldRow
							key={f.name}
							field={f}
							value={node[f.name]}
							onChange={(v) => onChange({ [f.name]: v })}
						/>
					))}
				</div>
			</div>

			<div className="px-3 py-2 border-t border-border">
				<Button
					variant="ghost"
					size="sm"
					onClick={onDelete}
					className="w-full gap-1.5 text-xs h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
				>
					<Trash2 className="size-3.5" />
					Delete node
				</Button>
			</div>
		</div>
	);
}

function FieldRow({
	field,
	value,
	onChange,
}: {
	field: FieldDef;
	value: unknown;
	onChange: (v: unknown) => void;
}) {
	const label = (
		<label className="text-[10px] font-medium text-muted-foreground block mb-1">
			{field.name.replace(/_/g, " ")}
			{field.required && <span className="text-destructive ml-0.5">*</span>}
		</label>
	);
	const hint = field.description ? (
		<p className="text-[10px] text-muted-foreground/70 mt-0.5">{field.description}</p>
	) : null;

	if (field.type === "textarea") {
		return (
			<div>
				{label}
				<textarea
					value={(value as string) ?? ""}
					onChange={(e) => onChange(e.target.value)}
					rows={4}
					className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5 resize-y"
				/>
				{hint}
			</div>
		);
	}

	if (field.type === "enum") {
		return (
			<div>
				{label}
				<select
					value={(value as string) ?? ""}
					onChange={(e) => onChange(e.target.value || undefined)}
					className="w-full h-7 text-xs rounded-md border border-input bg-background px-2"
				>
					<option value="">—</option>
					{field.enumValues?.map((v) => (
						<option key={v} value={v}>
							{v}
						</option>
					))}
				</select>
				{hint}
			</div>
		);
	}

	if (field.type === "boolean") {
		return (
			<label className="flex items-center gap-2 text-xs">
				<input
					type="checkbox"
					checked={value === true}
					onChange={(e) => onChange(e.target.checked)}
					className="h-3.5 w-3.5 rounded border-input"
				/>
				<span>
					{field.name.replace(/_/g, " ")}
					{field.required && <span className="text-destructive ml-0.5">*</span>}
				</span>
			</label>
		);
	}

	if (field.type === "number") {
		return (
			<div>
				{label}
				<input
					type="number"
					value={(value as number | string | undefined) ?? ""}
					onChange={(e) =>
						onChange(e.target.value === "" ? undefined : Number(e.target.value))
					}
					className={INPUT_CLS}
				/>
				{hint}
			</div>
		);
	}

	if (field.type === "object") {
		return <ObjectJsonField label={label} hint={hint} value={value} onChange={onChange} />;
	}

	if (field.type === "array" && field.array) {
		return (
			<ArrayField
				label={label}
				hint={hint}
				spec={field.array}
				value={value}
				onChange={onChange}
			/>
		);
	}

	return (
		<div>
			{label}
			<input
				type="text"
				value={(value as string) ?? ""}
				onChange={(e) => onChange(e.target.value || undefined)}
				className={INPUT_CLS}
			/>
			{hint}
		</div>
	);
}

/**
 * JSON-editor for object-typed fields. Tracks the raw text separately from
 * the parsed value so users can see invalid-JSON state instead of silently
 * losing edits.
 */
function ObjectJsonField({
	label,
	hint,
	value,
	onChange,
}: {
	label: React.ReactNode;
	hint: React.ReactNode;
	value: unknown;
	onChange: (v: unknown) => void;
}) {
	const stringify = (v: unknown) => {
		if (v === undefined || v === null) return "";
		try {
			return JSON.stringify(v, null, 2);
		} catch {
			return String(v);
		}
	};
	const [text, setText] = useState(() => stringify(value));
	const [parseError, setParseError] = useState<string | null>(null);

	useEffect(() => {
		// Re-sync from props when the value changes upstream (e.g. node swap).
		setText(stringify(value));
		setParseError(null);
	}, [value]);

	return (
		<div>
			{label}
			<textarea
				value={text}
				onChange={(e) => {
					const v = e.target.value;
					setText(v);
					if (v.trim() === "") {
						setParseError(null);
						onChange(undefined);
						return;
					}
					try {
						const parsed = JSON.parse(v);
						setParseError(null);
						onChange(parsed);
					} catch (err) {
						setParseError(err instanceof Error ? err.message : "Invalid JSON");
					}
				}}
				rows={5}
				className={`w-full text-xs font-mono rounded-md border bg-background px-2 py-1.5 resize-y ${parseError ? "border-destructive" : "border-input"}`}
			/>
			{parseError ? (
				<p className="text-[10px] text-destructive mt-0.5">{parseError}</p>
			) : (
				<p className="text-[10px] text-muted-foreground/70 mt-0.5">JSON object</p>
			)}
			{hint}
		</div>
	);
}

/**
 * Array-field editor. Renders structured rows for `array<string|number|boolean>`
 * and `array<object>`; falls back to JSON for anything more complex.
 */
function ArrayField({
	label,
	hint,
	spec,
	value,
	onChange,
}: {
	label: React.ReactNode;
	hint: React.ReactNode;
	spec: ArraySpec;
	value: unknown;
	onChange: (v: unknown) => void;
}) {
	const arr = Array.isArray(value) ? (value as unknown[]) : [];
	const canAdd = spec.maxItems === undefined || arr.length < spec.maxItems;
	const canRemove = spec.minItems === undefined || arr.length > spec.minItems;

	const update = (next: unknown[]) =>
		onChange(next.length === 0 ? undefined : next);

	if (spec.itemKind === "unknown") {
		// Unknown leaf shape — fall back to JSON editor.
		return <ObjectJsonField label={label} hint={hint} value={value} onChange={onChange} />;
	}

	return (
		<div>
			{label}
			<div className="space-y-1.5">
				{arr.map((item, i) => (
					<div key={i} className="flex items-start gap-1.5">
						<div className="text-[10px] text-muted-foreground pt-1.5 w-4 text-right">
							{i + 1}.
						</div>
						<div className="flex-1 min-w-0">
							{spec.itemKind === "object" && spec.itemFields ? (
								<div className="rounded-md border border-border/60 bg-card/50 px-2 py-1.5 space-y-1">
									{spec.itemFields.map((f) => {
										const row = (item ?? {}) as Record<string, unknown>;
										return (
											<div key={f.name} className="flex items-center gap-1.5">
												<span className="text-[10px] font-medium text-muted-foreground w-16 truncate">
													{f.name}
												</span>
												{f.enumValues ? (
													<select
														value={(row[f.name] as string) ?? ""}
														onChange={(e) => {
															const copy = [...arr];
															copy[i] = { ...row, [f.name]: e.target.value };
															update(copy);
														}}
														className="flex-1 h-6 text-[11px] rounded border border-input bg-background px-1"
													>
														<option value="">—</option>
														{f.enumValues.map((v) => (
															<option key={v} value={v}>
																{v}
															</option>
														))}
													</select>
												) : f.type === "number" ? (
													<input
														type="number"
														value={(row[f.name] as number | string | undefined) ?? ""}
														onChange={(e) => {
															const copy = [...arr];
															copy[i] = {
																...row,
																[f.name]:
																	e.target.value === "" ? "" : Number(e.target.value),
															};
															update(copy);
														}}
														className={INPUT_CLS + " h-6"}
													/>
												) : f.type === "boolean" ? (
													<input
														type="checkbox"
														checked={row[f.name] === true}
														onChange={(e) => {
															const copy = [...arr];
															copy[i] = { ...row, [f.name]: e.target.checked };
															update(copy);
														}}
														className="h-3.5 w-3.5"
													/>
												) : (
													<input
														type="text"
														value={(row[f.name] as string) ?? ""}
														onChange={(e) => {
															const copy = [...arr];
															copy[i] = { ...row, [f.name]: e.target.value };
															update(copy);
														}}
														className={INPUT_CLS + " h-6"}
													/>
												)}
											</div>
										);
									})}
								</div>
							) : spec.itemKind === "number" ? (
								<input
									type="number"
									value={(item as number | string | undefined) ?? ""}
									onChange={(e) => {
										const copy = [...arr];
										copy[i] = e.target.value === "" ? 0 : Number(e.target.value);
										update(copy);
									}}
									className={INPUT_CLS}
								/>
							) : spec.itemKind === "boolean" ? (
								<input
									type="checkbox"
									checked={item === true}
									onChange={(e) => {
										const copy = [...arr];
										copy[i] = e.target.checked;
										update(copy);
									}}
									className="h-4 w-4"
								/>
							) : (
								<input
									type="text"
									value={(item as string) ?? ""}
									onChange={(e) => {
										const copy = [...arr];
										copy[i] = e.target.value;
										update(copy);
									}}
									className={INPUT_CLS}
								/>
							)}
						</div>
						<button
							type="button"
							onClick={() => {
								if (!canRemove) return;
								const copy = arr.filter((_, idx) => idx !== i);
								update(copy);
							}}
							disabled={!canRemove}
							className="text-muted-foreground hover:text-destructive disabled:opacity-30 mt-1"
							aria-label="Remove item"
						>
							<Trash2 className="size-3" />
						</button>
					</div>
				))}
			</div>
			<Button
				variant="ghost"
				size="sm"
				type="button"
				onClick={() => update([...arr, defaultArrayItem(spec)])}
				disabled={!canAdd}
				className="mt-1.5 h-6 text-[10px] gap-1 w-full border border-dashed border-border hover:bg-accent/30"
			>
				<Plus className="size-3" />
				Add item
			</Button>
			{hint}
			{(spec.minItems !== undefined || spec.maxItems !== undefined) && (
				<p className="text-[10px] text-muted-foreground/70 mt-0.5">
					{spec.minItems !== undefined && `min ${spec.minItems}`}
					{spec.minItems !== undefined && spec.maxItems !== undefined && ", "}
					{spec.maxItems !== undefined && `max ${spec.maxItems}`}
				</p>
			)}
		</div>
	);
}
