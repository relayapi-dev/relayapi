// Generic field form (Plan 2 — Unit B3, Task M1).
//
// Extracted from the pre-rewrite `property-panel.tsx`. Covers every kind the
// builder supports today via the schema-driven `FieldRow`: delay, condition,
// randomizer, input, http_request, start_automation, goto, end, plus the
// legacy `message_*` / `instagram_*` / `facebook_*` / `whatsapp_*` /
// `telegram_*` interactive node types until those are replaced by the
// unified `message` kind + MessageComposer.
//
// The new PropertyPanel (same file as `property-panel.tsx`) dispatches here
// for any node kind that isn't `message` or `action_group`. No behavioural
// changes vs. the pre-rewrite code — only a file split so the main panel
// becomes a thin dispatcher.

import { Plus, Trash2 } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/use-api";
import {
	buildDataReferenceGroups,
	type DataReferenceGroup,
} from "./data-references";
import { INPUT_CLS } from "./field-styles";
import { type FilterGroup, FilterGroupEditor } from "./filter-group-editor";
import { resolveLegacyNodeOutputLabels } from "./validation";
import type {
	AutomationDetail,
	AutomationNodeSpec,
	SchemaNodeDef,
} from "./types";

// ---------------------------------------------------------------------------
// Field schema parsing
// ---------------------------------------------------------------------------

type PrimitiveArrayKind = "string" | "number" | "boolean";

interface ObjectArrayField {
	name: string;
	type: "string" | "number" | "boolean";
	required: boolean;
	enumValues?: string[];
}

export interface ArraySpec {
	itemKind: PrimitiveArrayKind | "object" | "unknown";
	itemFields?: ObjectArrayField[];
	minItems?: number;
	maxItems?: number;
}

export interface FieldDef {
	name: string;
	type:
		| "string"
		| "number"
		| "boolean"
		| "textarea"
		| "enum"
		| "object"
		| "array";
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
		else if (
			prop.format === "textarea" ||
			name === "text" ||
			name === "prompt" ||
			name === "body"
		)
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
			const fp = (fraw ?? {}) as {
				type?: string | string[];
				enum?: unknown[];
			};
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

// ---------------------------------------------------------------------------
// Top-level form
// ---------------------------------------------------------------------------

interface GenericFieldFormProps {
	automation: AutomationDetail;
	node: AutomationNodeSpec;
	nodeDef: SchemaNodeDef | null;
	automationChannel: string;
	onChange: (patch: Partial<AutomationNodeSpec>) => void;
}

export function GenericFieldForm({
	automation,
	node,
	nodeDef,
	automationChannel,
	onChange,
}: GenericFieldFormProps) {
	const fields = nodeDef ? parseFieldsSchema(nodeDef.fields_schema) : [];
	const primaryComposerField =
		fields.find((field) => ["text", "prompt", "body"].includes(field.name)) ??
		null;
	const detailFields = fields.filter(
		(field) => field.name !== primaryComposerField?.name,
	);
	const dataReferences = buildDataReferenceGroups(automation);
	const outputs = resolveLegacyNodeOutputLabels(node, nodeDef);
	const isLegacyMessage =
		node.type === "message_text" ||
		node.type === "message_media" ||
		node.type === "message_file";
	const showGuidanceCard =
		isLegacyMessage ||
		node.type === "instagram_reply_to_comment" ||
		node.type === "condition" ||
		outputs.length > 1;

	if (isLegacyMessage) {
		return (
			<>
				{primaryComposerField ? (
					<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
						<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
							Message
						</div>
						<div className="mt-4 overflow-hidden rounded-[18px] bg-[#f5f5f5]">
							<textarea
								value={
									(node[primaryComposerField.name] as string | undefined) ?? ""
								}
								onChange={(event) =>
									onChange({
										[primaryComposerField.name]: event.target.value,
									})
								}
								rows={5}
								className="min-h-[108px] w-full resize-y border-0 bg-transparent px-4 py-4 text-[14px] leading-6 text-[#353a44] outline-none placeholder:text-[#9aa3b2]"
								placeholder="Enter your text..."
							/>
						</div>
					</div>
				) : null}

				<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
					<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
						Step Settings
					</div>
					<div className="mt-4 space-y-4">
						<NodeGuidance
							node={node}
							nodeDef={nodeDef}
							automationChannel={automationChannel}
						/>
						{detailFields.length === 0 ? (
							<p className="text-[13px] text-[#7e8695]">
								This step has no additional settings.
							</p>
						) : (
							detailFields.map((f) => (
								<FieldRow
									key={f.name}
									node={node}
									field={f}
									value={node[f.name]}
									automationChannel={automationChannel}
									dataReferences={dataReferences}
									onChange={(v) => onChange({ [f.name]: v })}
								/>
							))
						)}
					</div>
				</div>
			</>
		);
	}

	return (
		<>
			{showGuidanceCard ? (
				<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
					<NodeGuidance
						node={node}
						nodeDef={nodeDef}
						automationChannel={automationChannel}
					/>
				</div>
			) : null}
			<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
				<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
					Settings
				</div>
				<div className="mt-4 space-y-4">
					{fields.length === 0 ? (
						<p className="text-[13px] text-[#7e8695]">
							This node type has no additional configuration.
						</p>
					) : (
						fields.map((f) => (
							<FieldRow
								key={f.name}
								node={node}
								field={f}
								value={node[f.name]}
								automationChannel={automationChannel}
								dataReferences={dataReferences}
								onChange={(v) => onChange({ [f.name]: v })}
							/>
						))
					)}
				</div>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// FieldRow + sub-editors (verbatim from the previous property-panel.tsx)
// ---------------------------------------------------------------------------

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
		<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
			{field.name.replace(/_/g, " ")}
			{field.required && <span className="text-destructive ml-0.5">*</span>}
		</label>
	);
	const hint = field.description ? (
		<p className="mt-1 text-[11px] text-[#7e8695]">{field.description}</p>
	) : null;

	if (
		node?.type === "condition" &&
		field.name === "if" &&
		field.type === "object"
	) {
		return (
			<div className="space-y-2">
				<div>
					{label}
					<p className="text-[10px] text-muted-foreground/70">
						Build a structured rule group. This is not JavaScript. Matching
						contacts follow the{" "}
						<span className="font-medium text-foreground">yes</span> path;
						others follow{" "}
						<span className="font-medium text-foreground">no</span>.
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
							helper:
								"At least one of these rules can make the condition pass.",
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

	if (
		node?.type === "instagram_reply_to_comment" &&
		field.name === "comment_id"
	) {
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

	if (
		node &&
		(node.type === "instagram_send_quick_replies" ||
			node.type === "facebook_send_quick_replies") &&
		field.name === "quick_replies"
	) {
		return (
			<InteractiveQuickRepliesField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
				dataReferences={refs}
			/>
		);
	}

	if (
		node &&
		(node.type === "instagram_send_buttons" ||
			node.type === "facebook_send_button_template") &&
		field.name === "buttons"
	) {
		return (
			<InteractiveButtonsField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
				dataReferences={refs}
			/>
		);
	}

	if (
		node &&
		node.type === "whatsapp_send_interactive" &&
		field.name === "buttons"
	) {
		return (
			<WhatsAppButtonsField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
			/>
		);
	}

	if (
		node &&
		node.type === "whatsapp_send_interactive" &&
		field.name === "list"
	) {
		return (
			<WhatsAppListField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
			/>
		);
	}

	if (
		node &&
		node.type === "telegram_send_keyboard" &&
		field.name === "buttons"
	) {
		return (
			<TelegramKeyboardField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
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
					className="h-10 w-full rounded-xl border border-[#d9dde6] bg-white px-3 text-[13px] text-[#353a44] shadow-[0_1px_2px_rgba(16,24,40,0.04)] outline-none"
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
			<label className="flex items-center gap-3 text-[13px] text-[#353a44]">
				<input
					type="checkbox"
					checked={value === true}
					onChange={(e) => onChange(e.target.checked)}
					className="h-4 w-4 rounded border-[#cdd5e1]"
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
				<p className="mt-1 text-[10px] text-muted-foreground/80">
					{description}
				</p>
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
					<div className="text-[11px] font-medium text-foreground">
						{defaultTitle}
					</div>
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
				Send this step’s event to one of your existing RelayAPI webhook
				endpoints.
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
		value !== null && value !== undefined && typeof value === "object"
			? "json"
			: "text";
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
							mode === "text"
								? "bg-accent text-foreground"
								: "text-muted-foreground"
						}`}
					>
						Text
					</button>
					<button
						type="button"
						onClick={() => setMode("json")}
						className={`rounded px-2 py-1 text-[10px] font-medium ${
							mode === "json"
								? "bg-accent text-foreground"
								: "text-muted-foreground"
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
					value={
						typeof value === "string"
							? value
							: value === undefined
								? ""
								: String(value)
					}
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
							mode === "static"
								? "bg-accent text-foreground"
								: "text-muted-foreground"
						}`}
					>
						Static
					</button>
					<button
						type="button"
						onClick={() => setMode("dynamic")}
						className={`rounded px-2 py-1 text-[10px] font-medium ${
							mode === "dynamic"
								? "bg-accent text-foreground"
								: "text-muted-foreground"
						}`}
					>
						Dynamic
					</button>
				</div>
			</div>
			{mode === "dynamic" && (
				<DataReferencePicker groups={dataReferences} onPick={insertToken} />
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
				Strings inside JSON can use merge tags like{" "}
				<span className="font-mono">{`{{state.text}}`}</span>.
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
	const outputs = resolveLegacyNodeOutputLabels(node, nodeDef);
	const recipientHint =
		node.type === "message_text" ||
		node.type === "message_media" ||
		node.type === "message_file";
	const commentReplyHint = node.type === "instagram_reply_to_comment";

	if (
		!recipientHint &&
		!commentReplyHint &&
		node.type !== "condition" &&
		outputs.length <= 1
	) {
		return null;
	}

	return (
		<div className="space-y-2">
			{recipientHint && (
				<div className="rounded-[18px] border border-[#e6e9ef] bg-[#f8fafc] px-4 py-3">
					<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
						Recipient
					</div>
					<p className="mt-2 text-[13px] text-[#353a44]">
						This step sends to the contact who entered the automation on{" "}
						<span className="font-medium capitalize">{automationChannel}</span>.
					</p>
					<p className="mt-2 text-[11px] text-[#7e8695]">
						By default the runtime resolves the contact’s channel identifier
						automatically. Set{" "}
						<span className="font-medium text-foreground">recipient mode</span>{" "}
						to custom and provide a{" "}
						<span className="font-medium text-foreground">
							recipient identifier
						</span>{" "}
						to override it.
					</p>
				</div>
			)}
			{commentReplyHint && (
				<div className="rounded-[18px] border border-[#e6e9ef] bg-[#f8fafc] px-4 py-3">
					<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
						Comment target
					</div>
					<p className="mt-2 text-[13px] text-[#353a44]">
						By default this step replies to the comment that triggered the
						automation.
					</p>
					<p className="mt-2 text-[11px] text-[#7e8695]">
						Leave{" "}
						<span className="font-medium text-foreground">comment id</span>{" "}
						empty to use{" "}
						<span className="font-mono text-foreground">{`{{state.comment_id}}`}</span>{" "}
						from the trigger payload. Only set it when you want to override the
						target comment explicitly.
					</p>
				</div>
			)}
			{outputs.length > 1 && (
				<div className="rounded-[18px] border border-[#e6e9ef] bg-white px-4 py-3">
					<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
						Outputs
					</div>
					<div className="mt-2 flex flex-wrap gap-2">
						{outputs.map((output) => (
							<span
								key={output}
								className="rounded-full border border-[#d9dde6] bg-[#f8fafc] px-3 py-1 text-[11px] font-medium text-[#6f7786]"
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
				<p className="text-[10px] text-muted-foreground/70 mt-0.5">
					JSON object
				</p>
			)}
			{hint}
		</div>
	);
}

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
			(spec.itemFields ?? []).some(
				(field) => field.type === "string" && !field.enumValues,
			));

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
		return (
			<ObjectJsonField
				label={label}
				hint={hint}
				value={value}
				onChange={onChange}
			/>
		);
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
														value={
															(row[f.name] as number | string | undefined) ?? ""
														}
														onChange={(e) => {
															const copy = [...arr];
															copy[i] = {
																...row,
																[f.name]:
																	e.target.value === ""
																		? ""
																		: Number(e.target.value),
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
														onFocus={() =>
															setActiveTarget(`field:${i}:${f.name}`)
														}
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
										copy[i] =
											e.target.value === "" ? 0 : Number(e.target.value);
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

function InteractiveQuickRepliesField({
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
	const rows = Array.isArray(value)
		? value.filter(
				(row): row is { title?: string; payload?: string } =>
					!!row && typeof row === "object",
			)
		: [];
	const [activeTarget, setActiveTarget] = useState<string | null>(null);
	const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

	const update = (next: Array<{ title?: string; payload?: string }>) =>
		onChange(next.length > 0 ? next : undefined);

	const insertToken = (tokenValue: string) => {
		if (!activeTarget) return;
		const input = inputRefs.current[activeTarget];
		const [indexPart, field] = activeTarget.split(":");
		const index = Number(indexPart);
		if (Number.isNaN(index) || !field) return;
		const currentRow = rows[index] ?? {};
		const currentValue =
			field === "payload"
				? (currentRow.payload ?? "")
				: (currentRow.title ?? "");
		const start = input?.selectionStart ?? currentValue.length;
		const end = input?.selectionEnd ?? currentValue.length;
		const nextValue = `${currentValue.slice(0, start)}${tokenValue}${currentValue.slice(end)}`;
		const next = [...rows];
		next[index] = { ...currentRow, [field]: nextValue };
		update(next);
	};

	return (
		<div className="space-y-2">
			{label}
			<p className="text-[10px] text-muted-foreground/80">
				Branch labels use the payload when set, otherwise the title.
			</p>
			<DataReferencePicker groups={dataReferences} onPick={insertToken} />
			<div className="space-y-2">
				{rows.map((row, index) => {
					const branchLabel =
						row.payload?.trim() || row.title?.trim() || "choice";
					return (
						<div
							key={`${index}-${branchLabel}`}
							className="rounded-xl border border-[#e6e9ef] bg-white p-3 space-y-3"
						>
							<div className="flex items-center justify-between gap-2">
								<div className="text-[11px] font-medium text-[#353a44]">
									Reply {index + 1}
								</div>
								<button
									type="button"
									onClick={() =>
										update(rows.filter((_, rowIndex) => rowIndex !== index))
									}
									className="text-[#7e8695] hover:text-destructive"
									aria-label="Remove quick reply"
								>
									<Trash2 className="size-3.5" />
								</button>
							</div>
							<div className="space-y-2">
								<div>
									<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
										Title
									</label>
									<input
										ref={(el) => {
											inputRefs.current[`${index}:title`] = el;
										}}
										value={row.title ?? ""}
										onFocus={() => setActiveTarget(`${index}:title`)}
										onChange={(event) => {
											const next = [...rows];
											next[index] = { ...row, title: event.target.value };
											update(next);
										}}
										className={INPUT_CLS}
										placeholder="What the user sees"
									/>
								</div>
								<div>
									<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
										Payload
									</label>
									<input
										ref={(el) => {
											inputRefs.current[`${index}:payload`] = el;
										}}
										value={row.payload ?? ""}
										onFocus={() => setActiveTarget(`${index}:payload`)}
										onChange={(event) => {
											const next = [...rows];
											next[index] = { ...row, payload: event.target.value };
											update(next);
										}}
										className={INPUT_CLS}
										placeholder="Optional stable branch key"
									/>
								</div>
							</div>
							<div className="inline-flex items-center rounded-full border border-[#d9dde6] bg-[#f8fafc] px-3 py-1 text-[11px] font-medium text-[#6f7786]">
								Branch: {branchLabel}
							</div>
						</div>
					);
				})}
			</div>
			<Button
				variant="ghost"
				size="sm"
				type="button"
				onClick={() => update([...rows, { title: "", payload: "" }])}
				className="h-8 w-full gap-1 rounded-xl border border-dashed border-[#d9dde6] text-[11px] hover:bg-accent/30"
			>
				<Plus className="size-3" />
				Add quick reply
			</Button>
			{hint}
		</div>
	);
}

function InteractiveButtonsField({
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
	const rows = Array.isArray(value)
		? value.filter(
				(
					row,
				): row is {
					type?: string;
					title?: string;
					payload?: string;
					url?: string;
				} => !!row && typeof row === "object",
			)
		: [];
	const [activeTarget, setActiveTarget] = useState<string | null>(null);
	const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

	const update = (
		next: Array<{
			type?: string;
			title?: string;
			payload?: string;
			url?: string;
		}>,
	) => onChange(next.length > 0 ? next : undefined);

	const insertToken = (tokenValue: string) => {
		if (!activeTarget) return;
		const input = inputRefs.current[activeTarget];
		const [indexPart, field] = activeTarget.split(":");
		const index = Number(indexPart);
		if (Number.isNaN(index) || !field) return;
		const currentRow = rows[index] ?? {};
		const currentValue =
			field === "payload"
				? (currentRow.payload ?? "")
				: field === "url"
					? (currentRow.url ?? "")
					: (currentRow.title ?? "");
		const start = input?.selectionStart ?? currentValue.length;
		const end = input?.selectionEnd ?? currentValue.length;
		const nextValue = `${currentValue.slice(0, start)}${tokenValue}${currentValue.slice(end)}`;
		const next = [...rows];
		next[index] = { ...currentRow, [field]: nextValue };
		update(next);
	};

	return (
		<div className="space-y-2">
			{label}
			<p className="text-[10px] text-muted-foreground/80">
				Only postback buttons create flow branches. Web URL buttons just open a
				link.
			</p>
			<DataReferencePicker groups={dataReferences} onPick={insertToken} />
			<div className="space-y-2">
				{rows.map((row, index) => {
					const buttonType = row.type === "web_url" ? "web_url" : "postback";
					const branchLabel =
						row.payload?.trim() || row.title?.trim() || "choice";
					return (
						<div
							key={`${index}-${branchLabel}`}
							className="rounded-xl border border-[#e6e9ef] bg-white p-3 space-y-3"
						>
							<div className="flex items-center justify-between gap-2">
								<div className="text-[11px] font-medium text-[#353a44]">
									Button {index + 1}
								</div>
								<button
									type="button"
									onClick={() =>
										update(rows.filter((_, rowIndex) => rowIndex !== index))
									}
									className="text-[#7e8695] hover:text-destructive"
									aria-label="Remove button"
								>
									<Trash2 className="size-3.5" />
								</button>
							</div>
							<div>
								<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
									Type
								</label>
								<select
									value={buttonType}
									onChange={(event) => {
										const next = [...rows];
										next[index] =
											event.target.value === "web_url"
												? {
														type: "web_url",
														title: row.title ?? "",
														url: row.url ?? "",
													}
												: {
														type: "postback",
														title: row.title ?? "",
														payload: row.payload ?? "",
													};
										update(next);
									}}
									className="h-10 w-full rounded-xl border border-[#d9dde6] bg-white px-3 text-[13px] text-[#353a44] shadow-[0_1px_2px_rgba(16,24,40,0.04)] outline-none"
								>
									<option value="postback">Postback</option>
									<option value="web_url">Web URL</option>
								</select>
							</div>
							<div>
								<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
									Title
								</label>
								<input
									ref={(el) => {
										inputRefs.current[`${index}:title`] = el;
									}}
									value={row.title ?? ""}
									onFocus={() => setActiveTarget(`${index}:title`)}
									onChange={(event) => {
										const next = [...rows];
										next[index] = {
											...row,
											title: event.target.value,
											type: buttonType,
										};
										update(next);
									}}
									className={INPUT_CLS}
									placeholder="What the user sees"
								/>
							</div>
							{buttonType === "postback" ? (
								<>
									<div>
										<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
											Payload
										</label>
										<input
											ref={(el) => {
												inputRefs.current[`${index}:payload`] = el;
											}}
											value={row.payload ?? ""}
											onFocus={() => setActiveTarget(`${index}:payload`)}
											onChange={(event) => {
												const next = [...rows];
												next[index] = {
													type: "postback",
													title: row.title ?? "",
													payload: event.target.value,
												};
												update(next);
											}}
											className={INPUT_CLS}
											placeholder="Optional stable branch key"
										/>
									</div>
									<div className="inline-flex items-center rounded-full border border-[#d9dde6] bg-[#f8fafc] px-3 py-1 text-[11px] font-medium text-[#6f7786]">
										Branch: {branchLabel}
									</div>
								</>
							) : (
								<div>
									<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
										URL
									</label>
									<input
										ref={(el) => {
											inputRefs.current[`${index}:url`] = el;
										}}
										value={row.url ?? ""}
										onFocus={() => setActiveTarget(`${index}:url`)}
										onChange={(event) => {
											const next = [...rows];
											next[index] = {
												type: "web_url",
												title: row.title ?? "",
												url: event.target.value,
											};
											update(next);
										}}
										className={INPUT_CLS}
										placeholder="https://example.com"
									/>
								</div>
							)}
						</div>
					);
				})}
			</div>
			<Button
				variant="ghost"
				size="sm"
				type="button"
				onClick={() =>
					update([...rows, { type: "postback", title: "", payload: "" }])
				}
				className="h-8 w-full gap-1 rounded-xl border border-dashed border-[#d9dde6] text-[11px] hover:bg-accent/30"
			>
				<Plus className="size-3" />
				Add button
			</Button>
			{hint}
		</div>
	);
}

function WhatsAppButtonsField({
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
	const rows = Array.isArray(value)
		? value.filter(
				(row): row is { id?: string; title?: string } =>
					!!row && typeof row === "object",
			)
		: [];
	const update = (next: Array<{ id?: string; title?: string }>) =>
		onChange(next.length > 0 ? next : undefined);

	return (
		<div className="space-y-2">
			{label}
			<p className="text-[10px] text-muted-foreground/80">
				Reply button ids are the branch labels used on outgoing connections.
			</p>
			<div className="space-y-2">
				{rows.map((row, index) => {
					const branchLabel = row.id?.trim() || row.title?.trim() || "choice";
					return (
						<div
							key={`${index}-${branchLabel}`}
							className="rounded-xl border border-[#e6e9ef] bg-white p-3 space-y-3"
						>
							<div className="flex items-center justify-between gap-2">
								<div className="text-[11px] font-medium text-[#353a44]">
									Button {index + 1}
								</div>
								<button
									type="button"
									onClick={() =>
										update(rows.filter((_, rowIndex) => rowIndex !== index))
									}
									className="text-[#7e8695] hover:text-destructive"
									aria-label="Remove button"
								>
									<Trash2 className="size-3.5" />
								</button>
							</div>
							<div>
								<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
									Title
								</label>
								<input
									value={row.title ?? ""}
									onChange={(event) => {
										const next = [...rows];
										next[index] = { ...row, title: event.target.value };
										update(next);
									}}
									className={INPUT_CLS}
									placeholder="What the user sees"
								/>
							</div>
							<div>
								<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
									Button ID
								</label>
								<input
									value={row.id ?? ""}
									onChange={(event) => {
										const next = [...rows];
										next[index] = { ...row, id: event.target.value };
										update(next);
									}}
									className={INPUT_CLS}
									placeholder="Stable branch key"
								/>
							</div>
							<div className="inline-flex items-center rounded-full border border-[#d9dde6] bg-[#f8fafc] px-3 py-1 text-[11px] font-medium text-[#6f7786]">
								Branch: {branchLabel}
							</div>
						</div>
					);
				})}
			</div>
			<Button
				variant="ghost"
				size="sm"
				type="button"
				onClick={() => update([...rows, { id: "", title: "" }])}
				className="h-8 w-full gap-1 rounded-xl border border-dashed border-[#d9dde6] text-[11px] hover:bg-accent/30"
			>
				<Plus className="size-3" />
				Add WhatsApp button
			</Button>
			{hint}
		</div>
	);
}

function WhatsAppListField({
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
	const list =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as {
					button?: string;
					sections?: Array<{
						title?: string;
						rows?: Array<{
							id?: string;
							title?: string;
							description?: string;
						}>;
					}>;
				})
			: { button: "", sections: [] };
	const sections = Array.isArray(list.sections) ? list.sections : [];
	const update = (next: {
		button?: string;
		sections?: Array<{
			title?: string;
			rows?: Array<{
				id?: string;
				title?: string;
				description?: string;
			}>;
		}>;
	}) => onChange(next);

	return (
		<div className="space-y-2">
			{label}
			<p className="text-[10px] text-muted-foreground/80">
				Each row id becomes a branch label when the contact selects that list
				item.
			</p>
			<div className="rounded-xl border border-[#e6e9ef] bg-white p-3 space-y-3">
				<div>
					<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
						List button label
					</label>
					<input
						value={list.button ?? ""}
						onChange={(event) =>
							update({ ...list, button: event.target.value, sections })
						}
						className={INPUT_CLS}
						placeholder="Choose an option"
					/>
				</div>
				<div className="space-y-3">
					{sections.map((section, sectionIndex) => (
						<div
							key={`section-${sectionIndex}`}
							className="rounded-xl border border-[#e6e9ef] bg-[#fbfcfe] p-3 space-y-3"
						>
							<div className="flex items-center justify-between gap-2">
								<div className="text-[11px] font-medium text-[#353a44]">
									Section {sectionIndex + 1}
								</div>
								<button
									type="button"
									onClick={() =>
										update({
											...list,
											sections: sections.filter(
												(_, index) => index !== sectionIndex,
											),
										})
									}
									className="text-[#7e8695] hover:text-destructive"
									aria-label="Remove section"
								>
									<Trash2 className="size-3.5" />
								</button>
							</div>
							<div>
								<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
									Section title
								</label>
								<input
									value={section.title ?? ""}
									onChange={(event) => {
										const nextSections = [...sections];
										nextSections[sectionIndex] = {
											...section,
											title: event.target.value,
										};
										update({ ...list, sections: nextSections });
									}}
									className={INPUT_CLS}
									placeholder="Optional section heading"
								/>
							</div>
							<div className="space-y-2">
								{(section.rows ?? []).map((row, rowIndex) => {
									const branchLabel =
										row.id?.trim() || row.title?.trim() || "row";
									return (
										<div
											key={`row-${sectionIndex}-${rowIndex}-${branchLabel}`}
											className="rounded-xl border border-[#e6e9ef] bg-white p-3 space-y-2"
										>
											<div className="flex items-center justify-between gap-2">
												<div className="text-[11px] font-medium text-[#353a44]">
													Row {rowIndex + 1}
												</div>
												<button
													type="button"
													onClick={() => {
														const nextSections = [...sections];
														const nextRows = (section.rows ?? []).filter(
															(_, index) => index !== rowIndex,
														);
														nextSections[sectionIndex] = {
															...section,
															rows: nextRows,
														};
														update({ ...list, sections: nextSections });
													}}
													className="text-[#7e8695] hover:text-destructive"
													aria-label="Remove list row"
												>
													<Trash2 className="size-3.5" />
												</button>
											</div>
											<input
												value={row.title ?? ""}
												onChange={(event) => {
													const nextSections = [...sections];
													const nextRows = [...(section.rows ?? [])];
													nextRows[rowIndex] = {
														...row,
														title: event.target.value,
													};
													nextSections[sectionIndex] = {
														...section,
														rows: nextRows,
													};
													update({ ...list, sections: nextSections });
												}}
												className={INPUT_CLS}
												placeholder="Row title"
											/>
											<input
												value={row.id ?? ""}
												onChange={(event) => {
													const nextSections = [...sections];
													const nextRows = [...(section.rows ?? [])];
													nextRows[rowIndex] = {
														...row,
														id: event.target.value,
													};
													nextSections[sectionIndex] = {
														...section,
														rows: nextRows,
													};
													update({ ...list, sections: nextSections });
												}}
												className={INPUT_CLS}
												placeholder="Row ID / branch key"
											/>
											<input
												value={row.description ?? ""}
												onChange={(event) => {
													const nextSections = [...sections];
													const nextRows = [...(section.rows ?? [])];
													nextRows[rowIndex] = {
														...row,
														description: event.target.value,
													};
													nextSections[sectionIndex] = {
														...section,
														rows: nextRows,
													};
													update({ ...list, sections: nextSections });
												}}
												className={INPUT_CLS}
												placeholder="Optional description"
											/>
											<div className="inline-flex items-center rounded-full border border-[#d9dde6] bg-[#f8fafc] px-3 py-1 text-[11px] font-medium text-[#6f7786]">
												Branch: {branchLabel}
											</div>
										</div>
									);
								})}
								<Button
									variant="ghost"
									size="sm"
									type="button"
									onClick={() => {
										const nextSections = [...sections];
										nextSections[sectionIndex] = {
											...section,
											rows: [
												...(section.rows ?? []),
												{ id: "", title: "", description: "" },
											],
										};
										update({ ...list, sections: nextSections });
									}}
									className="h-8 w-full gap-1 rounded-xl border border-dashed border-[#d9dde6] text-[11px] hover:bg-accent/30"
								>
									<Plus className="size-3" />
									Add row
								</Button>
							</div>
						</div>
					))}
				</div>
				<Button
					variant="ghost"
					size="sm"
					type="button"
					onClick={() =>
						update({
							...list,
							sections: [
								...sections,
								{
									title: "",
									rows: [{ id: "", title: "", description: "" }],
								},
							],
						})
					}
					className="h-8 w-full gap-1 rounded-xl border border-dashed border-[#d9dde6] text-[11px] hover:bg-accent/30"
				>
					<Plus className="size-3" />
					Add list section
				</Button>
			</div>
			{hint}
		</div>
	);
}

function TelegramKeyboardField({
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
	const rows = Array.isArray(value)
		? value.filter((row): row is Array<Record<string, unknown>> =>
				Array.isArray(row),
			)
		: [];
	const update = (next: Array<Array<Record<string, unknown>>>) =>
		onChange(next.length > 0 ? next : undefined);

	return (
		<div className="space-y-2">
			{label}
			<p className="text-[10px] text-muted-foreground/80">
				Only buttons with callback data create automation branches. URL buttons
				just open links.
			</p>
			<div className="space-y-3">
				{rows.map((row, rowIndex) => (
					<div
						key={`keyboard-row-${rowIndex}`}
						className="rounded-xl border border-[#e6e9ef] bg-white p-3 space-y-3"
					>
						<div className="flex items-center justify-between gap-2">
							<div className="text-[11px] font-medium text-[#353a44]">
								Row {rowIndex + 1}
							</div>
							<button
								type="button"
								onClick={() =>
									update(rows.filter((_, index) => index !== rowIndex))
								}
								className="text-[#7e8695] hover:text-destructive"
								aria-label="Remove keyboard row"
							>
								<Trash2 className="size-3.5" />
							</button>
						</div>
						<div className="space-y-2">
							{row.map((button, buttonIndex) => {
								const buttonType =
									typeof button.url === "string" && button.url.trim()
										? "url"
										: "callback";
								const branchLabel =
									(typeof button.callback_data === "string" &&
										button.callback_data.trim()) ||
									(typeof button.text === "string" && button.text.trim()) ||
									"button";
								return (
									<div
										key={`button-${rowIndex}-${buttonIndex}-${branchLabel}`}
										className="rounded-xl border border-[#e6e9ef] bg-[#fbfcfe] p-3 space-y-2"
									>
										<div className="flex items-center justify-between gap-2">
											<div className="text-[11px] font-medium text-[#353a44]">
												Button {buttonIndex + 1}
											</div>
											<button
												type="button"
												onClick={() => {
													const nextRows = [...rows];
													nextRows[rowIndex] = row.filter(
														(_, index) => index !== buttonIndex,
													);
													update(nextRows.filter((entry) => entry.length > 0));
												}}
												className="text-[#7e8695] hover:text-destructive"
												aria-label="Remove keyboard button"
											>
												<Trash2 className="size-3.5" />
											</button>
										</div>
										<select
											value={buttonType}
											onChange={(event) => {
												const nextRows = [...rows];
												const nextRow = [...row];
												nextRow[buttonIndex] =
													event.target.value === "url"
														? {
																text: button.text ?? "",
																url: button.url ?? "",
															}
														: {
																text: button.text ?? "",
																callback_data: button.callback_data ?? "",
															};
												nextRows[rowIndex] = nextRow;
												update(nextRows);
											}}
											className="h-10 w-full rounded-xl border border-[#d9dde6] bg-white px-3 text-[13px] text-[#353a44] shadow-[0_1px_2px_rgba(16,24,40,0.04)] outline-none"
										>
											<option value="callback">Callback</option>
											<option value="url">URL</option>
										</select>
										<input
											value={typeof button.text === "string" ? button.text : ""}
											onChange={(event) => {
												const nextRows = [...rows];
												const nextRow = [...row];
												nextRow[buttonIndex] = {
													...button,
													text: event.target.value,
												};
												nextRows[rowIndex] = nextRow;
												update(nextRows);
											}}
											className={INPUT_CLS}
											placeholder="Button text"
										/>
										{buttonType === "callback" ? (
											<>
												<input
													value={
														typeof button.callback_data === "string"
															? button.callback_data
															: ""
													}
													onChange={(event) => {
														const nextRows = [...rows];
														const nextRow = [...row];
														nextRow[buttonIndex] = {
															text: button.text ?? "",
															callback_data: event.target.value,
														};
														nextRows[rowIndex] = nextRow;
														update(nextRows);
													}}
													className={INPUT_CLS}
													placeholder="Callback data / branch key"
												/>
												<div className="inline-flex items-center rounded-full border border-[#d9dde6] bg-[#f8fafc] px-3 py-1 text-[11px] font-medium text-[#6f7786]">
													Branch: {branchLabel}
												</div>
											</>
										) : (
											<input
												value={typeof button.url === "string" ? button.url : ""}
												onChange={(event) => {
													const nextRows = [...rows];
													const nextRow = [...row];
													nextRow[buttonIndex] = {
														text: button.text ?? "",
														url: event.target.value,
													};
													nextRows[rowIndex] = nextRow;
													update(nextRows);
												}}
												className={INPUT_CLS}
												placeholder="https://example.com"
											/>
										)}
									</div>
								);
							})}
						</div>
						<Button
							variant="ghost"
							size="sm"
							type="button"
							onClick={() => {
								const nextRows = [...rows];
								nextRows[rowIndex] = [...row, { text: "", callback_data: "" }];
								update(nextRows);
							}}
							className="h-8 w-full gap-1 rounded-xl border border-dashed border-[#d9dde6] text-[11px] hover:bg-accent/30"
						>
							<Plus className="size-3" />
							Add button to row
						</Button>
					</div>
				))}
			</div>
			<Button
				variant="ghost"
				size="sm"
				type="button"
				onClick={() => update([...rows, [{ text: "", callback_data: "" }]])}
				className="h-8 w-full gap-1 rounded-xl border border-dashed border-[#d9dde6] text-[11px] hover:bg-accent/30"
			>
				<Plus className="size-3" />
				Add keyboard row
			</Button>
			{hint}
		</div>
	);
}
