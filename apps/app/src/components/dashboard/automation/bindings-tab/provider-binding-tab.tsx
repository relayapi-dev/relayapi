import { Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { AutomationPicker } from "./automation-picker";
import { BINDING_CONFIG_EDITORS } from "./binding-editors";
import type { BindingChannel, BindingType } from "./types";

export type ProviderBindingType = Extract<
	BindingType,
	"get_started" | "main_menu" | "ice_breaker"
>;

type MenuItem =
	| { label: string; action: "postback"; payload: string }
	| { label: string; action: "url"; url: string };
export type ProviderConfig =
	| { payload: string }
	| { items: MenuItem[]; composer_input_disabled: boolean }
	| { questions: Array<{ question: string; payload: string }> };

interface BindingRow {
	id: string;
	automation_id: string;
	binding_type: ProviderBindingType;
	config: Record<string, unknown> | null;
	status: string;
	desired_active: boolean;
	sync_revision: number;
	last_synced_revision: number;
	sync_error: string | null;
	updated_at: string;
}

const INPUT_CLS =
	"h-9 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-foreground/40 focus:ring-2 focus:ring-foreground/10";

export function defaultProviderBindingConfig(
	type: ProviderBindingType,
): ProviderConfig {
	if (type === "get_started") return { payload: "GET_STARTED" };
	if (type === "ice_breaker") {
		return { questions: [{ question: "How can we help?", payload: "HELP" }] };
	}
	return {
		items: [{ label: "Help", action: "postback", payload: "HELP" }],
		composer_input_disabled: false,
	};
}

export function normalizeProviderBindingConfig(
	type: ProviderBindingType,
	value: Record<string, unknown> | null,
	channel?: BindingChannel,
): ProviderConfig {
	if (!value) return defaultProviderBindingConfig(type);
	if (type === "get_started") {
		return { payload: typeof value.payload === "string" ? value.payload : "" };
	}
	if (type === "ice_breaker") {
		return {
			questions: Array.isArray(value.questions)
				? (value.questions as Array<{ question: string; payload: string }>)
				: [],
		};
	}
	return {
		items: Array.isArray(value.items) ? (value.items as MenuItem[]) : [],
		composer_input_disabled:
			channel === "instagram" ? false : value.composer_input_disabled === true,
	};
}

function statusStyle(status: string): string {
	if (status === "active") {
		return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
	}
	if (status === "sync_failed") {
		return "border-destructive/30 bg-destructive/10 text-destructive";
	}
	return "border-amber-500/30 bg-amber-500/10 text-amber-700";
}

export function ProviderAutomationBindingTab({
	socialAccountId,
	channel,
	bindingType,
}: {
	socialAccountId: string;
	channel: BindingChannel;
	bindingType: ProviderBindingType;
}) {
	const descriptor = BINDING_CONFIG_EDITORS[bindingType];
	const automationPickerId = useId();
	const [binding, setBinding] = useState<BindingRow | null>(null);
	const [automationId, setAutomationId] = useState<string | null>(null);
	const [config, setConfig] = useState<ProviderConfig>(() =>
		defaultProviderBindingConfig(bindingType),
	);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{
		type: "error" | "success";
		text: string;
	} | null>(null);

	const refresh = useCallback(
		async (silent = false) => {
			if (!silent) setLoading(true);
			try {
				const url = new URL("/api/automation-bindings", window.location.origin);
				url.searchParams.set("social_account_id", socialAccountId);
				url.searchParams.set("binding_type", bindingType);
				const response = await fetch(url, { credentials: "same-origin" });
				if (!response.ok) throw new Error(`Error ${response.status}`);
				const body = (await response.json()) as { data?: BindingRow[] };
				const next =
					body.data?.find(
						(candidate) => candidate.binding_type === bindingType,
					) ?? null;
				setBinding(next);
				if (next) {
					setAutomationId(next.automation_id);
					setConfig(
						normalizeProviderBindingConfig(bindingType, next.config, channel),
					);
				}
			} catch (error) {
				setMessage({
					type: "error",
					text:
						error instanceof Error ? error.message : "Unable to load binding",
				});
			} finally {
				if (!silent) setLoading(false);
			}
		},
		[bindingType, channel, socialAccountId],
	);

	useEffect(() => {
		setBinding(null);
		setAutomationId(null);
		setConfig(defaultProviderBindingConfig(bindingType));
		void refresh();
	}, [bindingType, refresh]);

	useEffect(() => {
		if (binding?.status !== "pending_sync") return;
		const timer = window.setInterval(() => void refresh(true), 2_000);
		return () => window.clearInterval(timer);
	}, [binding?.status, refresh]);

	const save = async () => {
		if (!automationId) {
			setMessage({ type: "error", text: "Choose an automation first." });
			return;
		}
		setSaving(true);
		setMessage(null);
		try {
			const response = await fetch(
				binding
					? `/api/automation-bindings/${binding.id}`
					: "/api/automation-bindings",
				{
					method: binding ? "PATCH" : "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						binding
							? { automation_id: automationId, config }
							: {
									social_account_id: socialAccountId,
									channel,
									binding_type: bindingType,
									automation_id: automationId,
									config,
								},
					),
				},
			);
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				throw new Error(body?.error?.message ?? `Error ${response.status}`);
			}
			setBinding(body as BindingRow);
			setMessage({
				type: "success",
				text: "Saved. Provider synchronization is queued.",
			});
		} catch (error) {
			setMessage({
				type: "error",
				text: error instanceof Error ? error.message : "Unable to save binding",
			});
		} finally {
			setSaving(false);
		}
	};

	const remove = async () => {
		if (!binding || !confirm("Remove this provider binding?")) return;
		setSaving(true);
		try {
			const response = await fetch(`/api/automation-bindings/${binding.id}`, {
				method: "DELETE",
			});
			if (!response.ok && response.status !== 204) {
				throw new Error(`Error ${response.status}`);
			}
			setBinding({ ...binding, status: "pending_sync", desired_active: false });
			setMessage({
				type: "success",
				text: "Removal queued. This panel will update after Meta confirms it.",
			});
		} catch (error) {
			setMessage({
				type: "error",
				text:
					error instanceof Error ? error.message : "Unable to remove binding",
			});
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="flex justify-center py-10">
				<Loader2 className="size-4 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-sm font-medium">{descriptor.title}</h2>
				<p className="mt-0.5 text-xs text-muted-foreground">
					{descriptor.subtitle}
				</p>
			</div>
			{bindingType === "main_menu" && channel === "facebook" ? (
				<div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-[11px] text-muted-foreground">
					Facebook requires an active, synchronized Get Started binding before
					its main menu can be published.
				</div>
			) : null}
			{message ? (
				<div
					className={`rounded-md border px-3 py-2 text-xs ${
						message.type === "error"
							? "border-destructive/30 bg-destructive/10 text-destructive"
							: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
					}`}
				>
					{message.text}
				</div>
			) : null}
			{binding ? (
				<div className="flex flex-wrap items-center gap-2 text-[10px]">
					<span
						className={`rounded-full border px-2 py-0.5 font-medium ${statusStyle(binding.status)}`}
					>
						{binding.status.replace(/_/g, " ")}
					</span>
					<span className="text-muted-foreground">
						revision {binding.last_synced_revision}/{binding.sync_revision}
					</span>
					{binding.sync_error ? (
						<span className="w-full text-destructive">
							{binding.sync_error}
						</span>
					) : null}
				</div>
			) : null}
			<div>
				<label
					htmlFor={automationPickerId}
					className="mb-1 block text-[11px] font-medium text-muted-foreground"
				>
					Automation
				</label>
				<AutomationPicker
					id={automationPickerId}
					channel={channel}
					value={automationId}
					onChange={setAutomationId}
					disabled={saving || binding?.desired_active === false}
				/>
			</div>
			<ProviderConfigEditor
				type={bindingType}
				channel={channel}
				config={config}
				onChange={setConfig}
				disabled={saving || binding?.desired_active === false}
			/>
			<div className="flex items-center gap-2">
				<Button size="sm" onClick={() => void save()} disabled={saving}>
					{saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
					{binding ? "Save changes" : "Publish binding"}
				</Button>
				{binding ? (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:text-destructive"
						onClick={() => void remove()}
						disabled={saving || binding.desired_active === false}
					>
						<Trash2 className="mr-1.5 size-3.5" />
						Remove
					</Button>
				) : null}
			</div>
		</div>
	);
}

export function ProviderConfigEditor({
	type,
	channel,
	config,
	onChange,
	disabled,
}: {
	type: ProviderBindingType;
	channel: BindingChannel;
	config: ProviderConfig;
	onChange: (next: ProviderConfig) => void;
	disabled: boolean;
}) {
	const inputId = useId();

	if (type === "get_started") {
		const value = config as { payload: string };
		return (
			<div>
				<label
					htmlFor={inputId}
					className="mb-1 block text-[11px] font-medium text-muted-foreground"
				>
					Postback payload
				</label>
				<input
					id={inputId}
					className={INPUT_CLS}
					value={value.payload}
					disabled={disabled}
					onChange={(event) => onChange({ payload: event.target.value })}
				/>
			</div>
		);
	}
	if (type === "ice_breaker") {
		const value = config as {
			questions: Array<{ question: string; payload: string }>;
		};
		return (
			<div className="space-y-2">
				{value.questions.map((question, index) => (
					<div
						key={`question-${index}`}
						className="grid grid-cols-[1fr_1fr_auto] gap-2"
					>
						<input
							className={INPUT_CLS}
							value={question.question}
							disabled={disabled}
							placeholder="Question"
							onChange={(event) => {
								const questions = value.questions.slice();
								questions[index] = {
									...question,
									question: event.target.value,
								};
								onChange({ questions });
							}}
						/>
						<input
							className={INPUT_CLS}
							value={question.payload}
							disabled={disabled}
							placeholder="Payload"
							onChange={(event) => {
								const questions = value.questions.slice();
								questions[index] = { ...question, payload: event.target.value };
								onChange({ questions });
							}}
						/>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="size-9 p-0 text-destructive"
							disabled={disabled || value.questions.length === 1}
							onClick={() =>
								onChange({
									questions: value.questions.filter(
										(_, itemIndex) => itemIndex !== index,
									),
								})
							}
						>
							<Trash2 className="size-3.5" />
						</Button>
					</div>
				))}
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={disabled || value.questions.length >= 4}
					onClick={() =>
						onChange({
							questions: [...value.questions, { question: "", payload: "" }],
						})
					}
				>
					<Plus className="mr-1.5 size-3.5" /> Add question
				</Button>
			</div>
		);
	}

	const value = config as {
		items: MenuItem[];
		composer_input_disabled: boolean;
	};
	const maxItems = 20;
	return (
		<div className="space-y-3">
			{channel === "facebook" ? (
				<label className="flex items-center gap-2 text-xs text-foreground">
					<input
						type="checkbox"
						checked={value.composer_input_disabled}
						disabled={disabled}
						onChange={(event) =>
							onChange({
								...value,
								composer_input_disabled: event.target.checked,
							})
						}
					/>
					Disable message composer
				</label>
			) : null}
			{value.items.map((item, index) => (
				<div
					key={`item-${index}`}
					className="space-y-2 rounded-md border border-border p-2.5"
				>
					<div className="grid grid-cols-[1fr_110px_auto] gap-2">
						<input
							className={INPUT_CLS}
							value={item.label}
							disabled={disabled}
							placeholder="Label"
							onChange={(event) => {
								const items = value.items.slice();
								items[index] = { ...item, label: event.target.value };
								onChange({ ...value, items });
							}}
						/>
						<select
							className={INPUT_CLS}
							value={item.action}
							disabled={disabled}
							onChange={(event) => {
								const items = value.items.slice();
								items[index] =
									event.target.value === "url"
										? { label: item.label, action: "url", url: "https://" }
										: { label: item.label, action: "postback", payload: "" };
								onChange({ ...value, items });
							}}
						>
							<option value="postback">Postback</option>
							<option value="url">Website</option>
						</select>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="size-9 p-0 text-destructive"
							disabled={disabled || value.items.length === 1}
							onClick={() =>
								onChange({
									...value,
									items: value.items.filter(
										(_, itemIndex) => itemIndex !== index,
									),
								})
							}
						>
							<Trash2 className="size-3.5" />
						</Button>
					</div>
					<input
						className={INPUT_CLS}
						value={item.action === "url" ? item.url : item.payload}
						disabled={disabled}
						placeholder={
							item.action === "url" ? "https://example.com" : "Payload"
						}
						onChange={(event) => {
							const items = value.items.slice();
							items[index] =
								item.action === "url"
									? { ...item, url: event.target.value }
									: { ...item, payload: event.target.value };
							onChange({ ...value, items });
						}}
					/>
				</div>
			))}
			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={disabled || value.items.length >= maxItems}
				onClick={() =>
					onChange({
						...value,
						items: [
							...value.items,
							{ label: "", action: "postback", payload: "" },
						],
					})
				}
			>
				<Plus className="mr-1.5 size-3.5" /> Add item ({value.items.length}/
				{maxItems})
			</Button>
		</div>
	);
}
