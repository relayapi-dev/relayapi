import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/use-api";
import {
	buildDataReferenceGroups,
	type DataReferenceGroup,
} from "./data-references";
import { FilterGroupEditor, type FilterGroup } from "./filter-group-editor";
import { INPUT_CLS } from "./field-styles";
import { resolveNodeOutputLabels } from "./output-labels";
import type { AutomationDetail, AutomationNodeSpec, SchemaNodeDef } from "./types";

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

export interface FieldDef {
	name: string;
	type: "string" | "number" | "boolean" | "textarea" | "enum" | "object" | "array";
	required: boolean;
	description?: string;
	enumValues?: string[];
	array?: ArraySpec;
}

export function parseFieldsSchema(fieldsSchema: unknown): FieldDef[] {
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
	automation: AutomationDetail;
	node: AutomationNodeSpec | null;
	nodeDef: SchemaNodeDef | null;
	automationChannel: string;
	onChange: (patch: Partial<AutomationNodeSpec>) => void;
	onDelete: () => void;
	onClose: () => void;
	existingKeys: string[];
}

export function PropertyPanel({
	automation,
	node,
	nodeDef,
	automationChannel,
	onChange,
	onDelete,
	onClose,
	existingKeys,
}: Props) {
	const fields = useMemo(
		() => (nodeDef ? parseFieldsSchema(nodeDef.fields_schema) : []),
		[nodeDef],
	);
	const dataReferences = useMemo(
		() => buildDataReferenceGroups(automation),
		[automation],
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
					<NodeGuidance
						node={node}
						nodeDef={nodeDef}
						automationChannel={automationChannel}
					/>
					{fields.length === 0 && (
						<p className="text-[10px] text-muted-foreground">
							This node type has no additional configuration.
						</p>
					)}
					{fields.map((f) => (
						<FieldRow
							key={f.name}
							node={node}
							field={f}
							value={node[f.name]}
							automationChannel={automationChannel}
							dataReferences={dataReferences}
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

export function FieldRow({
	node,
	field,
	value,
	automationChannel,
	dataReferences,
	onChange,
}: {
	node?: AutomationNodeSpec | null;
	field: FieldDef;
	value: unknown;
	automationChannel?: string;
	dataReferences?: DataReferenceGroup[];
	onChange: (v: unknown) => void;
}) {
	const refs = dataReferences ?? [];
	const label = (
		<label className="text-[10px] font-medium text-muted-foreground block mb-1">
			{field.name.replace(/_/g, " ")}
			{field.required && <span className="text-destructive ml-0.5">*</span>}
		</label>
	);
	const hint = field.description ? (
		<p className="text-[10px] text-muted-foreground/70 mt-0.5">{field.description}</p>
	) : null;

	if (node?.type === "condition" && field.name === "if" && field.type === "object") {
		return (
			<div className="space-y-2">
				<div>
					{label}
					<p className="text-[10px] text-muted-foreground/70">
						Build a structured rule group. This is not JavaScript. Matching contacts
						follow the <span className="font-medium text-foreground">yes</span> path;
						others follow <span className="font-medium text-foreground">no</span>.
					</p>
				</div>
				<FilterGroupEditor
					value={value as FilterGroup | undefined}
					onChange={(next) => onChange(next)}
					labels={{
						all: {
							label: "All rules must match",
							helper: "The yes path is taken only if every rule matches.",
						},
						any: {
							label: "Any rule can match",
							helper: "At least one of these rules can make the condition pass.",
						},
						none: {
							label: "None of these may match",
							helper: "If any of these rules match, the condition goes to no.",
						},
					}}
				/>
				{hint}
			</div>
		);
	}

	if (node?.type === "webhook_out" && field.name === "endpoint_id") {
		return (
			<WebhookEndpointField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
			/>
		);
	}

	if (
		node &&
		((node.type === "field_set" && field.name === "value") ||
			(node.type === "http_request" && field.name === "body") ||
			(node.type === "webhook_out" && field.name === "payload"))
	) {
		return (
			<DynamicValueField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
				dataReferences={refs}
			/>
		);
	}

	if (node?.type === "message_text" && field.name === "recipient_identifier") {
		const recipientMode =
			(node.recipient_mode as string | undefined) ?? "enrolled_contact";
		if (recipientMode !== "custom_identifier") {
			return (
				<InheritedValueNotice
					label={label}
					title={`Using enrolled contact${automationChannel ? ` on ${automationChannel}` : ""}`}
					description={`The runtime looks up the enrolled contact's${automationChannel ? ` ${automationChannel}` : ""} identifier automatically. Switch recipient mode to custom identifier to override it.`}
					hint={hint}
				/>
			);
		}
		return (
			<TemplatedTextField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
				dataReferences={refs}
			/>
		);
	}

	if (node?.type === "instagram_reply_to_comment" && field.name === "comment_id") {
		return (
			<OptionalOverrideField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
				dataReferences={refs}
				defaultTitle="Using trigger comment_id"
				defaultDescription="This step replies to the comment that enrolled the contact. The runtime reads state.comment_id from the trigger payload unless you override it here."
				defaultToken="{{state.comment_id}}"
				overrideLabel="Set explicit comment id"
				resetLabel="Use trigger comment_id instead"
			/>
		);
	}

	if (field.type === "textarea") {
		return (
			<TemplatedTextField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
				rows={4}
				multiline
				dataReferences={refs}
			/>
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
		return (
			<TemplatedJsonField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
				dataReferences={refs}
			/>
		);
	}

	if (field.type === "array" && field.array) {
		return (
			<ArrayField
				label={label}
				hint={hint}
				spec={field.array}
				value={value}
				onChange={onChange}
				dataReferences={refs}
			/>
		);
	}

	return (
		<TemplatedTextField
			label={label}
			hint={hint}
			value={value}
			onChange={onChange}
			dataReferences={refs}
		/>
	);
}

function InheritedValueNotice({
	label,
	title,
	description,
	hint,
}: {
	label: React.ReactNode;
	title: string;
	description: string;
	hint: React.ReactNode;
}) {
	return (
		<div className="space-y-2">
			{label}
			<div className="rounded-lg border border-border/80 bg-muted/25 px-3 py-2">
				<div className="text-[11px] font-medium text-foreground">{title}</div>
				<p className="mt-1 text-[10px] text-muted-foreground/80">{description}</p>
			</div>
			{hint}
		</div>
	);
}

function OptionalOverrideField({
	label,
	hint,
	value,
	onChange,
	dataReferences,
	defaultTitle,
	defaultDescription,
	defaultToken,
	overrideLabel,
	resetLabel,
}: {
	label: React.ReactNode;
	hint: React.ReactNode;
	value: unknown;
	onChange: (v: unknown) => void;
	dataReferences: DataReferenceGroup[];
	defaultTitle: string;
	defaultDescription: string;
	defaultToken: string;
	overrideLabel: string;
	resetLabel: string;
}) {
	const hasValue = typeof value === "string" && value.trim().length > 0;
	const [editingOverride, setEditingOverride] = useState(hasValue);

	useEffect(() => {
		if (hasValue) {
			setEditingOverride(true);
		}
	}, [hasValue]);

	if (!editingOverride && !hasValue) {
		return (
			<div className="space-y-2">
				{label}
				<div className="rounded-lg border border-border/80 bg-muted/25 px-3 py-2">
					<div className="text-[11px] font-medium text-foreground">{defaultTitle}</div>
					<p className="mt-1 text-[10px] text-muted-foreground/80">
						{defaultDescription}
					</p>
					<div className="mt-2 inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
						{defaultToken}
					</div>
					<div className="mt-2">
						<button
							type="button"
							onClick={() => setEditingOverride(true)}
							className="text-[10px] font-medium text-foreground underline-offset-2 hover:underline"
						>
							{overrideLabel}
						</button>
					</div>
				</div>
				{hint}
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<TemplatedTextField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
				dataReferences={dataReferences}
			/>
			<button
				type="button"
				onClick={() => {
					setEditingOverride(false);
					onChange(undefined);
				}}
				className="text-[10px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
			>
				{resetLabel}
			</button>
		</div>
	);
}

interface WebhookListResponse {
	data: Array<{
		id: string;
		url: string;
		enabled: boolean;
	}>;
}

function WebhookEndpointField({
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
	const { data, loading } = useApi<WebhookListResponse>("webhooks", {
		query: { limit: 100 },
	});

	return (
		<div>
			{label}
			<select
				value={(value as string) ?? ""}
				onChange={(e) => onChange(e.target.value || undefined)}
				className="w-full h-7 text-xs rounded-md border border-input bg-background px-2"
			>
				<option value="">
					{loading ? "Loading webhook endpoints…" : "Select a webhook endpoint"}
				</option>
				{(data?.data ?? []).map((endpoint) => (
					<option key={endpoint.id} value={endpoint.id}>
						{endpoint.url}
						{endpoint.enabled ? "" : " (disabled)"}
					</option>
				))}
			</select>
			<p className="text-[10px] text-muted-foreground/70 mt-0.5">
				Send this step’s event to one of your existing RelayAPI webhook endpoints.
			</p>
			{hint}
		</div>
	);
}

function DynamicValueField({
	label,
	hint,
	value,
	onChange,
	dataReferences,
}: {
	label: React.ReactNode;
	hint: React.ReactNode;
	value: unknown;
	onChange: (v: unknown) => void;
	dataReferences: DataReferenceGroup[];
}) {
	const inferredMode =
		value !== null && value !== undefined && typeof value === "object" ? "json" : "text";
	const [mode, setMode] = useState<"text" | "json">(inferredMode);

	useEffect(() => {
		setMode(inferredMode);
	}, [inferredMode]);

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0">{label}</div>
				<div className="inline-flex rounded-md border border-border bg-background p-0.5">
					<button
						type="button"
						onClick={() => setMode("text")}
						className={`rounded px-2 py-1 text-[10px] font-medium ${
							mode === "text" ? "bg-accent text-foreground" : "text-muted-foreground"
						}`}
					>
						Text
					</button>
					<button
						type="button"
						onClick={() => setMode("json")}
						className={`rounded px-2 py-1 text-[10px] font-medium ${
							mode === "json" ? "bg-accent text-foreground" : "text-muted-foreground"
						}`}
					>
						JSON
					</button>
				</div>
			</div>
			{mode === "text" ? (
				<TemplatedTextField
					label={null}
					hint={hint}
					value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
					onChange={(next) => onChange(next === "" ? undefined : next)}
					rows={4}
					multiline
					dataReferences={dataReferences}
					hideLabel
				/>
			) : (
				<TemplatedJsonField
					label={null}
					hint={hint}
					value={value}
					onChange={onChange}
					dataReferences={dataReferences}
					hideLabel
				/>
			)}
		</div>
	);
}

function TemplatedTextField({
	label,
	hint,
	value,
	onChange,
	dataReferences,
	multiline,
	rows = 1,
	hideLabel = false,
}: {
	label: React.ReactNode;
	hint: React.ReactNode;
	value: unknown;
	onChange: (v: unknown) => void;
	dataReferences: DataReferenceGroup[];
	multiline?: boolean;
	rows?: number;
	hideLabel?: boolean;
}) {
	const textValue = (value as string | undefined) ?? "";
	const [mode, setMode] = useState<"static" | "dynamic">(
		textValue.includes("{{") ? "dynamic" : "static",
	);
	const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

	useEffect(() => {
		setMode(textValue.includes("{{") ? "dynamic" : "static");
	}, [textValue]);

	const insertToken = (tokenValue: string) => {
		const el = inputRef.current;
		const start = el?.selectionStart ?? textValue.length;
		const end = el?.selectionEnd ?? textValue.length;
		const prefix = textValue.slice(0, start);
		const suffix = textValue.slice(end);
		const needsLeadingSpace = prefix.length > 0 && !/\s$/.test(prefix);
		const insertion = `${needsLeadingSpace ? " " : ""}${tokenValue}`;
		const next = `${prefix}${insertion}${suffix}`;
		onChange(next);
		requestAnimationFrame(() => {
			const target = inputRef.current;
			if (!target) return;
			const caret = prefix.length + insertion.length;
			target.focus();
			target.setSelectionRange(caret, caret);
		});
	};

	return (
		<div className="space-y-2">
			{!hideLabel && label}
			<div className="flex items-center justify-between gap-2">
				<p className="text-[10px] text-muted-foreground/80">
					{mode === "dynamic"
						? "Insert contact and state values with merge-tag tokens."
						: "Use plain text or switch to dynamic mode to insert data."}
				</p>
				<div className="inline-flex rounded-md border border-border bg-background p-0.5">
					<button
						type="button"
						onClick={() => setMode("static")}
						className={`rounded px-2 py-1 text-[10px] font-medium ${
							mode === "static" ? "bg-accent text-foreground" : "text-muted-foreground"
						}`}
					>
						Static
					</button>
					<button
						type="button"
						onClick={() => setMode("dynamic")}
						className={`rounded px-2 py-1 text-[10px] font-medium ${
							mode === "dynamic" ? "bg-accent text-foreground" : "text-muted-foreground"
						}`}
					>
						Dynamic
					</button>
				</div>
			</div>
			{mode === "dynamic" && (
				<DataReferencePicker
					groups={dataReferences}
					onPick={insertToken}
				/>
			)}
			{multiline ? (
				<textarea
					ref={inputRef as React.RefObject<HTMLTextAreaElement>}
					value={textValue}
					onChange={(e) => onChange(e.target.value || undefined)}
					rows={rows}
					className="w-full text-xs rounded-md border border-input bg-background px-2 py-1.5 resize-y"
				/>
			) : (
				<input
					ref={inputRef as React.RefObject<HTMLInputElement>}
					type="text"
					value={textValue}
					onChange={(e) => onChange(e.target.value || undefined)}
					className={INPUT_CLS}
				/>
			)}
			{hint}
		</div>
	);
}

function TemplatedJsonField({
	label,
	hint,
	value,
	onChange,
	dataReferences,
	hideLabel = false,
}: {
	label: React.ReactNode;
	hint: React.ReactNode;
	value: unknown;
	onChange: (v: unknown) => void;
	dataReferences: DataReferenceGroup[];
	hideLabel?: boolean;
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
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		setText(stringify(value));
		setParseError(null);
	}, [value]);

	const insertToken = (tokenValue: string) => {
		const el = textareaRef.current;
		const start = el?.selectionStart ?? text.length;
		const end = el?.selectionEnd ?? text.length;
		const next = `${text.slice(0, start)}${tokenValue}${text.slice(end)}`;
		setText(next);
		try {
			const parsed = JSON.parse(next);
			setParseError(null);
			onChange(parsed);
		} catch (err) {
			setParseError(err instanceof Error ? err.message : "Invalid JSON");
		}
		requestAnimationFrame(() => {
			const target = textareaRef.current;
			if (!target) return;
			const caret = start + tokenValue.length;
			target.focus();
			target.setSelectionRange(caret, caret);
		});
	};

	return (
		<div className="space-y-2">
			{!hideLabel && label}
			<p className="text-[10px] text-muted-foreground/80">
				Strings inside JSON can use merge tags like <span className="font-mono">{`{{state.text}}`}</span>.
			</p>
			<DataReferencePicker groups={dataReferences} onPick={insertToken} />
			<textarea
				ref={textareaRef}
				value={text}
				onChange={(e) => {
					const next = e.target.value;
					setText(next);
					if (next.trim() === "") {
						setParseError(null);
						onChange(undefined);
						return;
					}
					try {
						const parsed = JSON.parse(next);
						setParseError(null);
						onChange(parsed);
					} catch (err) {
						setParseError(err instanceof Error ? err.message : "Invalid JSON");
					}
				}}
				rows={6}
				className={`w-full text-xs font-mono rounded-md border bg-background px-2 py-1.5 resize-y ${
					parseError ? "border-destructive" : "border-input"
				}`}
			/>
			{parseError ? (
				<p className="text-[10px] text-destructive">{parseError}</p>
			) : (
				<p className="text-[10px] text-muted-foreground/70">JSON payload</p>
			)}
			{hint}
		</div>
	);
}

function DataReferencePicker({
	groups,
	onPick,
}: {
	groups: DataReferenceGroup[];
	onPick: (tokenValue: string) => void;
}) {
	return (
		<div className="rounded-lg border border-border/70 bg-muted/20 px-2.5 py-2 space-y-2">
			<div>
				<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
					Data
				</div>
				<p className="mt-0.5 text-[10px] text-muted-foreground/70">
					Click to insert a merge tag at the cursor.
				</p>
			</div>
			<div className="space-y-2">
				{groups.map((group) => (
					<div key={group.key} className="space-y-1">
						<div>
							<div className="text-[10px] font-medium text-foreground">
								{group.label}
							</div>
							{group.description && (
								<p className="text-[10px] text-muted-foreground/70">
									{group.description}
								</p>
							)}
						</div>
						<div className="flex flex-wrap gap-1.5">
							{group.refs.map((ref) => (
								<button
									key={ref.key}
									type="button"
									onClick={() => onPick(ref.token)}
									className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-accent"
									title={ref.description ?? ref.token}
								>
									{ref.label}
								</button>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function NodeGuidance({
	node,
	nodeDef,
	automationChannel,
}: {
	node: AutomationNodeSpec;
	nodeDef: SchemaNodeDef | null;
	automationChannel: string;
}) {
	const outputs = resolveNodeOutputLabels(node, nodeDef);
	const recipientHint =
		node.type === "message_text" ||
		node.type === "message_media" ||
		node.type === "message_file";

	if (!recipientHint && node.type !== "condition" && outputs.length <= 1) {
		return null;
	}

	const commentReplyHint = node.type === "instagram_reply_to_comment";

	return (
		<div className="space-y-2">
			{recipientHint && (
				<div className="rounded-lg border border-border/80 bg-muted/30 px-3 py-2">
					<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
						Recipient
					</div>
					<p className="mt-1 text-[11px] text-foreground">
						This step sends to the contact who entered the automation on{" "}
						<span className="font-medium capitalize">{automationChannel}</span>.
					</p>
					<p className="mt-1 text-[10px] text-muted-foreground/70">
						By default the runtime resolves the contact’s channel identifier
						automatically. Set{" "}
						<span className="font-medium text-foreground">
							recipient mode
						</span>{" "}
						to custom and provide a{" "}
						<span className="font-medium text-foreground">
							recipient identifier
						</span>{" "}
						to override it.
					</p>
				</div>
			)}
			{commentReplyHint && (
				<div className="rounded-lg border border-border/80 bg-muted/30 px-3 py-2">
					<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
						Comment target
					</div>
					<p className="mt-1 text-[11px] text-foreground">
						By default this step replies to the comment that triggered the
						automation.
					</p>
					<p className="mt-1 text-[10px] text-muted-foreground/70">
						Leave <span className="font-medium text-foreground">comment id</span>{" "}
						empty to use <span className="font-mono text-foreground">{`{{state.comment_id}}`}</span>{" "}
						from the trigger payload. Only set it when you want to override the
						target comment explicitly.
					</p>
				</div>
			)}
			{outputs.length > 1 && (
				<div className="rounded-lg border border-border/80 bg-background px-3 py-2">
					<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
						Outputs
					</div>
					<div className="mt-1 flex flex-wrap gap-1.5">
						{outputs.map((output) => (
							<span
								key={output}
								className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
							>
								{output}
							</span>
						))}
					</div>
				</div>
			)}
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
	dataReferences,
}: {
	label: React.ReactNode;
	hint: React.ReactNode;
	spec: ArraySpec;
	value: unknown;
	onChange: (v: unknown) => void;
	dataReferences: DataReferenceGroup[];
}) {
	const arr = Array.isArray(value) ? (value as unknown[]) : [];
	const canAdd = spec.maxItems === undefined || arr.length < spec.maxItems;
	const canRemove = spec.minItems === undefined || arr.length > spec.minItems;
	const [activeTarget, setActiveTarget] = useState<string | null>(null);
	const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

	const update = (next: unknown[]) =>
		onChange(next.length === 0 ? undefined : next);
	const hasStringTargets =
		spec.itemKind === "string" ||
		(spec.itemKind === "object" &&
			(spec.itemFields ?? []).some((field) => field.type === "string" && !field.enumValues));

	const setTargetValue = (target: string, nextValue: string) => {
		const copy = [...arr];
		if (target.startsWith("item:")) {
			const index = Number(target.slice(5));
			if (!Number.isNaN(index)) {
				copy[index] = nextValue;
			}
		} else if (target.startsWith("field:")) {
			const [, rawIndex, ...fieldParts] = target.split(":");
			const index = Number(rawIndex);
			const fieldName = fieldParts.join(":");
			if (!Number.isNaN(index) && fieldName) {
				const row = (copy[index] ?? {}) as Record<string, unknown>;
				copy[index] = { ...row, [fieldName]: nextValue };
			}
		}
		update(copy);
	};

	const currentTargetValue = (target: string): string => {
		if (target.startsWith("item:")) {
			const index = Number(target.slice(5));
			return ((arr[index] as string | undefined) ?? "").toString();
		}
		if (target.startsWith("field:")) {
			const [, rawIndex, ...fieldParts] = target.split(":");
			const index = Number(rawIndex);
			const fieldName = fieldParts.join(":");
			const row = (arr[index] ?? {}) as Record<string, unknown>;
			return ((row[fieldName] as string | undefined) ?? "").toString();
		}
		return "";
	};

	const insertToken = (tokenValue: string) => {
		if (!activeTarget) return;
		const input = inputRefs.current[activeTarget];
		const currentValue = currentTargetValue(activeTarget);
		const start = input?.selectionStart ?? currentValue.length;
		const end = input?.selectionEnd ?? currentValue.length;
		const nextValue = `${currentValue.slice(0, start)}${tokenValue}${currentValue.slice(end)}`;
		setTargetValue(activeTarget, nextValue);
		requestAnimationFrame(() => {
			const target = inputRefs.current[activeTarget];
			if (!target) return;
			const caret = start + tokenValue.length;
			target.focus();
			target.setSelectionRange(caret, caret);
		});
	};

	if (spec.itemKind === "unknown") {
		// Unknown leaf shape — fall back to JSON editor.
		return <ObjectJsonField label={label} hint={hint} value={value} onChange={onChange} />;
	}

	return (
		<div>
			{label}
			{hasStringTargets && dataReferences.length > 0 && (
				<div className="my-2">
					<p className="mb-1 text-[10px] text-muted-foreground/70">
						Focus a string field, then click a token to insert dynamic data.
					</p>
					<DataReferencePicker groups={dataReferences} onPick={insertToken} />
				</div>
			)}
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
														ref={(el) => {
															inputRefs.current[`field:${i}:${f.name}`] = el;
														}}
														value={(row[f.name] as string) ?? ""}
														onFocus={() => setActiveTarget(`field:${i}:${f.name}`)}
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
									ref={(el) => {
										inputRefs.current[`item:${i}`] = el;
									}}
									value={(item as string) ?? ""}
									onFocus={() => setActiveTarget(`item:${i}`)}
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
