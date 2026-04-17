import { useEffect, useMemo, useState } from "react";
import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AutomationNodeSpec, SchemaNodeDef } from "./types";

const INPUT_CLS =
	"h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground";

interface FieldDef {
	name: string;
	type: "string" | "number" | "boolean" | "textarea" | "enum" | "object";
	required: boolean;
	description?: string;
	enumValues?: string[];
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
		};
		let type: FieldDef["type"] = "string";
		const t = Array.isArray(prop.type) ? prop.type[0] : prop.type;
		if (t === "number" || t === "integer") type = "number";
		else if (t === "boolean") type = "boolean";
		else if (t === "object") type = "object";
		else if (prop.enum && Array.isArray(prop.enum)) type = "enum";
		else if (prop.format === "textarea" || name === "text" || name === "prompt" || name === "body")
			type = "textarea";

		out.push({
			name,
			type,
			required: required.has(name),
			description: prop.description,
			enumValues: Array.isArray(prop.enum)
				? prop.enum.filter((v): v is string => typeof v === "string")
				: undefined,
		});
	}
	return out;
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
		let text = "";
		if (value !== undefined && value !== null) {
			try {
				text = JSON.stringify(value, null, 2);
			} catch {
				text = String(value);
			}
		}
		return (
			<div>
				{label}
				<textarea
					value={text}
					onChange={(e) => {
						const v = e.target.value;
						if (v.trim() === "") {
							onChange(undefined);
							return;
						}
						try {
							onChange(JSON.parse(v));
						} catch {
							// leave current value intact — user is still typing
						}
					}}
					rows={5}
					className="w-full text-xs font-mono rounded-md border border-input bg-background px-2 py-1.5 resize-y"
				/>
				<p className="text-[10px] text-muted-foreground/70 mt-0.5">JSON object</p>
			</div>
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
