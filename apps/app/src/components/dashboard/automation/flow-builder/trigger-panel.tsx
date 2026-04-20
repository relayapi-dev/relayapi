import { useMemo } from "react";
import { ChevronLeft, Tag, Trash2, X, Zap } from "lucide-react";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { platformIcons } from "@/lib/platform-icons";
import { cn } from "@/lib/utils";
import type {
	AutomationDetail,
	AutomationSchema,
	AutomationTriggerSpec,
	SchemaTriggerDef,
} from "./types";
import { FilterGroupEditor, type FilterGroup } from "./filter-group-editor";
import { INPUT_CLS } from "./field-styles";
import { FieldRow, parseFieldsSchema } from "./property-panel";
import { TriggerTypePicker } from "./guided-flow";

const PANEL_WIDTH_CLS = "w-[360px] xl:w-[392px]";

const TRIGGER_OPERATION_OVERRIDES: Record<string, string> = {
	instagram_comment: "User comments on your Post or Reel",
	instagram_dm: "User sends a message",
	instagram_story_reply: "User replies to your Story",
	instagram_story_mention: "User mentions your Story",
	facebook_comment: "User comments on your Post",
	facebook_dm: "User sends a message",
	whatsapp_message: "User sends a WhatsApp message",
	telegram_message: "User sends a Telegram message",
	sms_received: "User sends an SMS",
	manual: "Manual start",
	external_api: "External API event",
};

function titleize(value: string): string {
	return value
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function triggerOperationLabelFor(triggerType: string, channel: string) {
	return (
		TRIGGER_OPERATION_OVERRIDES[triggerType] ??
		titleize(triggerType.replace(new RegExp(`^${channel}_`), ""))
	);
}

interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	selectedTriggerId: string | null;
	onSelectTrigger: (triggerId: string | null) => void;
	onAddTrigger: (triggerType: string) => void;
	onUpdateTrigger: (
		triggerId: string,
		patch: Partial<AutomationTriggerSpec>,
	) => void;
	onRemoveTrigger: (triggerId: string) => void;
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
	selectedTriggerId,
	onSelectTrigger,
	onAddTrigger,
	onUpdateTrigger,
	onRemoveTrigger,
	onClose,
	readOnly,
}: Props) {
	const selected = selectedTriggerId
		? (automation.triggers.find((t) => t.id === selectedTriggerId) ?? null)
		: null;

	if (!selected) {
		return (
			<TriggerListMode
				automation={automation}
				schema={schema}
				onSelectTrigger={onSelectTrigger}
				onAddTrigger={onAddTrigger}
				onClose={onClose}
				readOnly={readOnly}
			/>
		);
	}

	return (
		<TriggerDetailMode
			automation={automation}
			schema={schema}
			trigger={selected}
			onBack={() => onSelectTrigger(null)}
			onChange={(patch) => onUpdateTrigger(selected.id, patch)}
			onRemove={() => onRemoveTrigger(selected.id)}
			canRemove={automation.triggers.length > 1}
			readOnly={readOnly}
		/>
	);
}

interface TriggerListModeProps {
	automation: AutomationDetail;
	schema: AutomationSchema;
	onSelectTrigger: (triggerId: string | null) => void;
	onAddTrigger: (triggerType: string) => void;
	onClose: () => void;
	readOnly?: boolean;
}

function TriggerListMode({
	automation,
	schema,
	onSelectTrigger,
	onAddTrigger,
	onClose,
	readOnly,
}: TriggerListModeProps) {
	return (
		<div
			className={cn(
				PANEL_WIDTH_CLS,
				"flex flex-col overflow-hidden border-l border-[#e6e9ef] bg-white shadow-[-12px_0_32px_rgba(15,23,42,0.03)]",
			)}
		>
			<div className="border-b border-[#e6e9ef] bg-[#e4f5e6] px-4 py-4">
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={onClose}
						className="rounded-full p-1 text-[#6f7786] transition hover:bg-white/70 hover:text-[#353a44]"
						aria-label="Close"
					>
						<ChevronLeft className="size-4" />
					</button>
					<div className="min-w-0 flex-1">
						<h3 className="truncate text-[18px] font-semibold text-[#353a44]">
							When...
						</h3>
						<p className="mt-1 text-[12px] text-[#6f7786]">
							Configure the triggers that start this automation.
						</p>
					</div>
				</div>
			</div>
			<ScrollArea className="flex-1 bg-[#fbfcfe]">
				<div className="space-y-3 px-4 py-4">
					{automation.triggers.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => onSelectTrigger(t.id)}
							className="flex w-full items-center gap-3 rounded-[16px] border border-[#e6e9ef] bg-white px-4 py-3 text-left transition hover:border-[#4680ff]"
						>
							<div className="flex size-10 items-center justify-center rounded-full bg-[#f7ecfb] text-[#8f5bb3]">
								<div className="scale-[0.9]">
									{platformIcons[automation.channel] ?? (
										<Zap className="size-4" />
									)}
								</div>
							</div>
							<div className="min-w-0 flex-1">
								<div className="text-[12px] text-[#8b92a0]">{t.label}</div>
								<div className="truncate text-[14px] font-medium text-[#353a44]">
									{triggerOperationLabelFor(t.type, automation.channel)}
								</div>
							</div>
						</button>
					))}
					{!readOnly && (
						<TriggerTypePicker
							automationChannel={automation.channel}
							schema={schema}
							onPick={onAddTrigger}
						>
							<button
								type="button"
								className="mt-2 flex h-11 w-full items-center justify-center rounded-[14px] border border-dashed border-[#d9dde6] text-[15px] font-medium text-[#4680ff] transition hover:border-[#bfc6d3] hover:bg-[#fafbfc]"
							>
								+ New Trigger
							</button>
						</TriggerTypePicker>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}

interface TriggerDetailModeProps {
	automation: AutomationDetail;
	schema: AutomationSchema;
	trigger: AutomationTriggerSpec;
	onBack: () => void;
	onChange: (patch: Partial<AutomationTriggerSpec>) => void;
	onRemove: () => void;
	canRemove: boolean;
	readOnly?: boolean;
}

function TriggerDetailMode({
	automation,
	schema,
	trigger,
	onBack,
	onChange,
	onRemove,
	canRemove,
	readOnly,
}: TriggerDetailModeProps) {
	const triggersForChannel = useMemo<SchemaTriggerDef[]>(() => {
		return schema.triggers
			.filter((t) => t.channel === automation.channel)
			.sort((a, b) => a.type.localeCompare(b.type));
	}, [schema.triggers, automation.channel]);

	const selectedTriggerDef = triggersForChannel.find(
		(t) => t.type === trigger.type,
	);

	const configFields = useMemo(
		() =>
			selectedTriggerDef
				? parseFieldsSchema(selectedTriggerDef.config_schema)
				: [],
		[selectedTriggerDef],
	);

	const config = useMemo<Record<string, unknown>>(
		() => trigger.config ?? {},
		[trigger.config],
	);

	const filters = useMemo<TriggerFiltersShape>(
		() => (trigger.filters ?? {}) as TriggerFiltersShape,
		[trigger.filters],
	);

	const setConfigField = (name: string, v: unknown) => {
		const next = { ...config };
		if (v === undefined || v === null || v === "") delete next[name];
		else next[name] = v;
		onChange({ config: next });
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
		onChange({ filters: next as Record<string, unknown> });
	};

	return (
		<div
			className={cn(
				PANEL_WIDTH_CLS,
				"flex flex-col overflow-hidden border-l border-[#e6e9ef] bg-white shadow-[-12px_0_32px_rgba(15,23,42,0.03)]",
			)}
		>
			<div className="border-b border-[#e6e9ef] bg-[#e4f5e6] px-4 py-4">
				<div className="flex items-center gap-3">
					<button
						type="button"
						onClick={onBack}
						className="rounded-full p-1 text-[#6f7786] transition hover:bg-white/70 hover:text-[#353a44]"
						aria-label="Back to trigger list"
					>
						<ChevronLeft className="size-4" />
					</button>
					<div className="min-w-0 flex-1">
						<input
							type="text"
							value={trigger.label}
							disabled={readOnly}
							onChange={(event) => onChange({ label: event.target.value })}
							placeholder="Trigger label"
							className={cn(
								"w-full truncate border-0 bg-transparent p-0 text-[18px] font-semibold text-[#353a44] outline-none",
								readOnly && "opacity-60",
							)}
						/>
						<p className="mt-1 text-[12px] text-[#6f7786]">
							{triggerOperationLabelFor(trigger.type, automation.channel)}
						</p>
					</div>
				</div>
			</div>

			<ScrollArea className="flex-1 bg-[#fbfcfe]">
				<div className="space-y-5 px-4 py-5">
					<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
						<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
							Trigger Settings
						</div>
						<div className="mt-4 space-y-4">
							<div>
								<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
									Channel
								</label>
								<div className="rounded-xl border border-[#d9dde6] bg-[#f8fafc] px-3 py-3 text-[13px] capitalize text-[#353a44]">
									{automation.channel}
								</div>
							</div>

							<div>
								<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
									Trigger type <span className="text-destructive">*</span>
								</label>
								<select
									value={trigger.type}
									disabled={readOnly}
									onChange={(e) =>
										onChange({ type: e.target.value, config: {} })
									}
									className="h-10 w-full rounded-xl border border-[#d9dde6] bg-white px-3 text-[13px] text-[#353a44] shadow-[0_1px_2px_rgba(16,24,40,0.04)] outline-none disabled:opacity-60"
								>
									{triggersForChannel.map((t) => (
										<option key={t.type} value={t.type}>
											{t.type.replace(/_/g, " ")}
										</option>
									))}
								</select>
								{selectedTriggerDef?.description && (
									<p className="mt-1 text-[11px] text-[#7e8695]">
										{selectedTriggerDef.description}
									</p>
								)}
							</div>

							<div>
								<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
									Account
								</label>
								<div
									className={cn(readOnly && "pointer-events-none opacity-60")}
								>
									<AccountSearchCombobox
										value={trigger.account_id ?? null}
										onSelect={(accountId) =>
											onChange({ account_id: accountId })
										}
										platforms={
											automation.channel === "multi"
												? undefined
												: [automation.channel]
										}
										showAllOption={false}
										placeholder="Select a connected account"
										variant="input"
									/>
								</div>
							</div>

							{configFields.length > 0 && (
								<div className="space-y-4 border-t border-[#edf0f5] pt-4">
									<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
										Config
									</div>
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
					</div>

					<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
						<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
							Filters
						</div>
						<p className="mt-1 text-[12px] text-[#7e8695]">
							Only enroll events that match these filters.
						</p>
						<div className="mt-4 space-y-4">
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
								<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
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

					{!readOnly && (
						<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
							<button
								type="button"
								onClick={onRemove}
								disabled={!canRemove}
								className={cn(
									"flex w-full items-center justify-center gap-2 rounded-[14px] border border-dashed px-3 py-3 text-[13px] font-medium transition",
									canRemove
										? "border-destructive/30 text-destructive hover:bg-destructive/5"
										: "border-[#e6e9ef] text-[#bfc6d3] cursor-not-allowed",
								)}
							>
								<Trash2 className="size-3.5" />
								Delete trigger
							</button>
							{!canRemove && (
								<p className="mt-2 text-center text-[11px] text-[#7e8695]">
									At least one trigger is required.
								</p>
							)}
						</div>
					)}
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
			<label className="mb-1 block text-[11px] font-medium text-[#7e8695]">
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
