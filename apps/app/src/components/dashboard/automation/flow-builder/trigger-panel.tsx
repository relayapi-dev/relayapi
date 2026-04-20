import { useMemo } from "react";
import { ChevronLeft, Tag, X, Zap } from "lucide-react";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { platformIcons } from "@/lib/platform-icons";
import { cn } from "@/lib/utils";
import type {
	AutomationDetail,
	AutomationNodeSpec,
	AutomationSchema,
	SchemaTriggerDef,
} from "./types";
import { FilterGroupEditor, type FilterGroup } from "./filter-group-editor";
import { INPUT_CLS } from "./field-styles";
import { FieldRow, parseFieldsSchema } from "./property-panel";
import {
	defaultTriggerLabel,
	triggerDisplayRows,
	withTriggerDisplayRows,
} from "./trigger-ui";

const PANEL_WIDTH_CLS = "w-[360px] xl:w-[392px]";

const STEP_TITLE_OVERRIDES: Record<string, string> = {
	message_text: "Send Message",
	message_media: "Send Media",
	message_file: "Send File",
	condition: "Condition",
	smart_delay: "Delay",
	randomizer: "Randomizer",
	http_request: "HTTP Request",
	goto: "Go To Step",
	end: "End Automation",
	tag_add: "Add Tag",
	tag_remove: "Remove Tag",
	field_set: "Set Field",
	field_clear: "Clear Field",
};

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

function triggerOperationLabel(automation: AutomationDetail) {
	return (
		TRIGGER_OPERATION_OVERRIDES[automation.trigger_type] ??
		titleize(
			automation.trigger_type.replace(
				new RegExp(`^${automation.channel}_`),
				"",
			),
		)
	);
}

function nextStepLabel(node: AutomationNodeSpec | undefined) {
	if (!node) return "Choose next step";
	return STEP_TITLE_OVERRIDES[node.type] ?? titleize(node.type);
}

interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	onChange: (
		patch: Partial<
			Pick<
				AutomationDetail,
				| "trigger_type"
				| "trigger_config"
				| "trigger_filters"
				| "social_account_id"
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

	const displayRows = useMemo(
		() => triggerDisplayRows(automation),
		[automation],
	);
	const triggerSummary = useMemo(
		() => triggerOperationLabel(automation),
		[automation],
	);
	const connectedSteps = useMemo(
		() =>
			automation.edges
				.filter((edge) => edge.from === "trigger")
				.sort(
					(a, b) =>
						(a.order ?? Number.MAX_SAFE_INTEGER) -
							(b.order ?? Number.MAX_SAFE_INTEGER) ||
						(a.label ?? "next").localeCompare(b.label ?? "next"),
				)
				.map((edge) => ({
					edge,
					node: automation.nodes.find((node) => node.key === edge.to),
				})),
		[automation.edges, automation.nodes],
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

	const setDisplayRows = (rows: string[]) => {
		onChange({
			trigger_config: withTriggerDisplayRows(automation.trigger_config, rows),
		});
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
						onClick={onClose}
						className="rounded-full p-1 text-[#6f7786] transition hover:bg-white/70 hover:text-[#353a44]"
						aria-label="Close trigger editor"
					>
						<ChevronLeft className="size-4" />
					</button>
					<div className="min-w-0 flex-1">
						<h3 className="truncate text-[18px] font-semibold text-[#353a44]">
							When...
						</h3>
						<p className="mt-1 text-[12px] text-[#6f7786]">
							Configure what starts this automation.
						</p>
					</div>
				</div>
			</div>

			<ScrollArea className="flex-1 bg-[#fbfcfe]">
				<div className="space-y-5 px-4 py-5">
					<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
						<div className="space-y-3">
							{displayRows.map((row, index) => (
								<div
									key={`${row}-${index}`}
									className="rounded-[18px] border border-[#e6e9ef] bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
								>
									<div className="flex items-start gap-3">
										<div className="mt-0.5 flex size-7 items-center justify-center rounded-full bg-[#f7ecfb] text-[#8f5bb3]">
											<div className="scale-[0.8]">
												{platformIcons[automation.channel] ?? (
													<Zap className="size-3.5" />
												)}
											</div>
										</div>
										<div className="min-w-0 flex-1">
											<input
												type="text"
												value={row}
												disabled={readOnly}
												onChange={(event) => {
													const next = [...displayRows];
													next[index] = event.target.value;
													setDisplayRows(next);
												}}
												placeholder={defaultTriggerLabel(
													automation.trigger_type,
													index + 1,
												)}
												className={cn(
													"w-full border-0 bg-transparent p-0 text-[12px] font-medium text-[#8b92a0] outline-none",
													readOnly && "opacity-60",
												)}
											/>
											<div className="mt-1 text-[15px] font-medium text-[#353a44]">
												{triggerSummary}
											</div>
										</div>
										{!readOnly && displayRows.length > 1 ? (
											<button
												type="button"
												onClick={() =>
													setDisplayRows(
														displayRows.filter(
															(_, rowIndex) => rowIndex !== index,
														),
													)
												}
												className="rounded-md p-1 text-[#98a0ae] transition hover:bg-[#f6f8fb] hover:text-destructive"
												aria-label={`Remove trigger row ${index + 1}`}
											>
												<X className="size-3.5" />
											</button>
										) : null}
									</div>
								</div>
							))}
						</div>

						{!readOnly && (
							<button
								type="button"
								onClick={() =>
									setDisplayRows([
										...displayRows,
										defaultTriggerLabel(
											automation.trigger_type,
											displayRows.length + 1,
										),
									])
								}
								className="mt-4 flex h-11 w-full items-center justify-center rounded-[14px] border border-dashed border-[#d9dde6] text-[16px] font-medium text-[#4680ff] transition hover:border-[#bfc6d3] hover:bg-[#fafbfc]"
							>
								+ New Trigger
							</button>
						)}
					</div>

					<div className="rounded-[20px] border border-[#e6e9ef] bg-white p-4">
						<div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0]">
							Then...
						</div>
						<div className="mt-4 space-y-3">
							{connectedSteps.length === 0 ? (
								<div className="rounded-[16px] border border-dashed border-[#d9dde6] px-4 py-4 text-[13px] text-[#7e8695]">
									Add a step to continue after the trigger runs.
								</div>
							) : (
								connectedSteps.map(({ edge, node }) => (
									<div
										key={`${edge.to}-${edge.label ?? "next"}`}
										className="flex items-center gap-3 rounded-[16px] border border-[#d9dde6] bg-white px-4 py-4"
									>
										<div className="flex size-10 items-center justify-center rounded-full bg-[#f7ecfb] text-[#8f5bb3]">
											<div className="scale-[0.9]">
												{platformIcons[automation.channel] ?? (
													<Zap className="size-4" />
												)}
											</div>
										</div>
										<div className="min-w-0 flex-1">
											<div className="text-[12px] text-[#8b92a0]">
												{titleize(automation.channel)}
											</div>
											<div className="truncate text-[16px] font-medium text-[#353a44]">
												{nextStepLabel(node)}
											</div>
										</div>
									</div>
								))
							)}
						</div>
					</div>

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
									value={automation.trigger_type}
									disabled={readOnly}
									onChange={(e) =>
										onChange({
											trigger_type: e.target.value,
											trigger_config: undefined,
										})
									}
									className="h-10 w-full rounded-xl border border-[#d9dde6] bg-white px-3 text-[13px] text-[#353a44] shadow-[0_1px_2px_rgba(16,24,40,0.04)] outline-none disabled:opacity-60"
								>
									{triggersForChannel.map((t) => (
										<option key={t.type} value={t.type}>
											{t.type.replace(/_/g, " ")}
										</option>
									))}
								</select>
								{selected?.description && (
									<p className="mt-1 text-[11px] text-[#7e8695]">
										{selected.description}
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
										value={automation.social_account_id ?? null}
										onSelect={(accountId) =>
											onChange({ social_account_id: accountId })
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
