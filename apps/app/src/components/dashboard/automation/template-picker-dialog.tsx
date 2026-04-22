// Unified "Create automation" dialog (Plan 2 — Unit B5, Task P4).
//
// Replaces the old template-picker dialog AND the dedicated
// /app/automation/new page with a single modal flow:
//
//   Step 1 — Template grid (blank + quick starts + scaffolds)
//   Step 2 — Template-specific config form
//   Step 3 — Review & submit
//
// Submission path: `POST /api/automations` (already proxied). Payload shape
// matches the new SDK `AutomationCreateParams`:
//   { name, description?, channel, template: { kind, config } }
//
// NOTE: we keep the filename so existing imports keep resolving; the export
// name is now `CreateAutomationDialog`. The old
// `AutomationTemplatePickerDialog` export is kept as an alias pointing at the
// same component for any callers not yet migrated.

import { useEffect, useMemo, useState } from "react";
import {
	ArrowLeft,
	Bot,
	CheckCircle2,
	FilePlus,
	Gift,
	Loader2,
	MessageSquare,
	Sparkles,
	UserPlus,
	Workflow,
} from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { AccountSearchCombobox } from "@/components/dashboard/account-search-combobox";
import { PostSearchCombobox } from "@/components/dashboard/post-search-combobox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TemplateSlug =
	| "blank"
	| "comment_to_dm"
	| "story_leads"
	| "follower_growth"
	| "follow_to_dm"
	| "welcome_flow"
	| "faq_bot"
	| "lead_capture";

type ChannelOption = "instagram" | "facebook" | "whatsapp" | "telegram";

interface TemplateMeta {
	slug: TemplateSlug;
	name: string;
	description: string;
	icon: typeof Sparkles;
	channels: ChannelOption[];
	group: "blank" | "quick_start" | "scaffold";
}

const TEMPLATES: TemplateMeta[] = [
	{
		slug: "blank",
		name: "Blank automation",
		description: "Start from an empty canvas.",
		icon: FilePlus,
		channels: ["instagram", "facebook", "whatsapp", "telegram"],
		group: "blank",
	},
	{
		slug: "comment_to_dm",
		name: "Comment to DM",
		description: "Reply to a comment with a DM.",
		icon: MessageSquare,
		channels: ["instagram", "facebook"],
		group: "quick_start",
	},
	{
		slug: "story_leads",
		name: "Story leads",
		description: "Capture a field when someone replies to your story.",
		icon: Sparkles,
		channels: ["instagram"],
		group: "quick_start",
	},
	{
		slug: "follower_growth",
		name: "Follower growth",
		description: "Run a contest that grows your follower count.",
		icon: Gift,
		channels: ["instagram"],
		group: "quick_start",
	},
	{
		slug: "follow_to_dm",
		name: "Follow to DM",
		description: "DM new followers automatically.",
		icon: UserPlus,
		channels: ["instagram"],
		group: "quick_start",
	},
	{
		slug: "welcome_flow",
		name: "Welcome flow",
		description: "Greet new conversations with a branded intro.",
		icon: Workflow,
		channels: ["instagram", "facebook", "whatsapp", "telegram"],
		group: "scaffold",
	},
	{
		slug: "faq_bot",
		name: "FAQ bot",
		description: "Answer common questions with canned replies.",
		icon: Bot,
		channels: ["instagram", "facebook", "whatsapp", "telegram"],
		group: "scaffold",
	},
	{
		slug: "lead_capture",
		name: "Lead capture",
		description: "Collect email or phone then tag the contact.",
		icon: Sparkles,
		channels: ["instagram", "facebook", "whatsapp", "telegram"],
		group: "scaffold",
	},
];

// ---------------------------------------------------------------------------
// Form state per template
// ---------------------------------------------------------------------------

interface FormState {
	name: string;
	description?: string;
	channel: ChannelOption;
	// comment_to_dm fields
	social_account_id?: string;
	post_ids?: string[];
	keyword_filter?: string; // comma-separated
	public_reply?: string;
	dm_text?: string;
	once_per_user?: boolean;
	fallback_message?: string;
	// story_leads fields
	story_ids?: string[] | null;
	capture_field?: "email" | "phone";
	success_tag?: string;
	// follower_growth fields
	contest_post_id?: string;
	trigger_keyword?: string;
	entry_requirements?: string[];
	// follow_to_dm fields
	daily_cap?: number;
	cooldown_hours?: number;
}

const defaultForm: FormState = {
	name: "",
	channel: "instagram",
	once_per_user: true,
	capture_field: "email",
	success_tag: "lead",
	daily_cap: 100,
	cooldown_hours: 24,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onCreated: () => void;
	initialTemplate?: TemplateSlug | null;
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function CreateAutomationDialog({
	open,
	onOpenChange,
	onCreated,
	initialTemplate = null,
}: Props) {
	const [step, setStep] = useState<1 | 2 | 3>(1);
	const [selected, setSelected] = useState<TemplateSlug | null>(initialTemplate);
	const [form, setForm] = useState<FormState>(defaultForm);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const template = useMemo(
		() => (selected ? TEMPLATES.find((t) => t.slug === selected) ?? null : null),
		[selected],
	);

	// Reset when dialog closes / initialTemplate changes.
	useEffect(() => {
		if (!open) {
			setStep(1);
			setSelected(initialTemplate);
			setForm(defaultForm);
			setError(null);
			setSubmitting(false);
		} else if (initialTemplate) {
			setSelected(initialTemplate);
			setStep(2);
		}
	}, [open, initialTemplate]);

	// Clamp channel to template-supported options when template changes.
	useEffect(() => {
		if (!template) return;
		if (!template.channels.includes(form.channel)) {
			setForm((f) => ({ ...f, channel: template.channels[0]! }));
		}
	}, [template, form.channel]);

	const blank = template?.slug === "blank";

	// ---- Validation -------------------------------------------------------

	const validate = (): string | null => {
		if (!selected) return "Pick a template.";
		if (!form.name.trim()) return "Name is required.";
		if (!form.channel) return "Channel is required.";
		switch (selected) {
			case "comment_to_dm":
				if (!form.social_account_id) return "Select an account.";
				if (!form.dm_text?.trim()) return "DM text is required.";
				return null;
			case "story_leads":
				if (!form.social_account_id) return "Select an account.";
				if (!form.dm_text?.trim()) return "DM text is required.";
				return null;
			case "follower_growth":
				if (!form.social_account_id) return "Select an account.";
				if (!form.trigger_keyword?.trim())
					return "Trigger keyword is required.";
				if (!form.dm_text?.trim()) return "DM text is required.";
				return null;
			case "follow_to_dm":
				if (!form.social_account_id) return "Select an account.";
				if (!form.dm_text?.trim()) return "DM text is required.";
				return null;
			default:
				return null;
		}
	};

	// ---- Build server payload --------------------------------------------

	const buildTemplateConfig = (): Record<string, unknown> => {
		if (!selected || selected === "blank") return {};
		const kw = (form.keyword_filter ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		switch (selected) {
			case "comment_to_dm":
				return {
					post_ids: form.post_ids,
					keyword_filter: kw.length > 0 ? kw : undefined,
					public_reply: form.public_reply?.trim() || undefined,
					dm_message: {
						blocks: [{ id: "txt", type: "text", text: form.dm_text ?? "" }],
					},
					once_per_user: form.once_per_user,
					fallback_message: form.fallback_message?.trim() || undefined,
					social_account_id: form.social_account_id,
				};
			case "story_leads":
				return {
					story_ids: form.story_ids ?? null,
					keyword_filter: kw.length > 0 ? kw : undefined,
					dm_message: {
						blocks: [{ id: "txt", type: "text", text: form.dm_text ?? "" }],
					},
					capture_field: form.capture_field,
					success_tag: form.success_tag,
					social_account_id: form.social_account_id,
				};
			case "follower_growth":
				return {
					contest_post_id: form.contest_post_id,
					trigger_keyword: form.trigger_keyword,
					public_reply: form.public_reply?.trim() || undefined,
					dm_message: {
						blocks: [{ id: "txt", type: "text", text: form.dm_text ?? "" }],
					},
					entry_requirements: form.entry_requirements ?? [],
					social_account_id: form.social_account_id,
				};
			case "follow_to_dm":
				return {
					dm_message: {
						blocks: [{ id: "txt", type: "text", text: form.dm_text ?? "" }],
					},
					daily_cap: form.daily_cap,
					cooldown_hours: form.cooldown_hours,
					social_account_id: form.social_account_id,
				};
			case "welcome_flow":
			case "faq_bot":
			case "lead_capture":
				return {};
			default:
				return {};
		}
	};

	const submit = async () => {
		const problem = validate();
		if (problem) {
			setError(problem);
			setStep(2);
			return;
		}
		setError(null);
		setSubmitting(true);
		try {
			const body: Record<string, unknown> = {
				name: form.name.trim(),
				channel: form.channel,
			};
			if (form.description) body.description = form.description;
			if (selected && selected !== "blank") {
				body.template = {
					kind: selected,
					config: buildTemplateConfig(),
				};
			}
			const res = await fetch("/api/automations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const parsed = await res.json().catch(() => null);
				setError(parsed?.error?.message ?? `Request failed (${res.status}).`);
				return;
			}
			const created = (await res.json().catch(() => null)) as
				| { id?: string }
				| null;
			onCreated();
			onOpenChange(false);
			if (created?.id) {
				window.location.href = `/app/automation/${created.id}`;
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : "Network error");
		} finally {
			setSubmitting(false);
		}
	};

	// ---- Render -----------------------------------------------------------

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{step > 1 && (
							<button
								type="button"
								onClick={() => {
									if (step === 3) setStep(2);
									else if (step === 2) {
										setStep(1);
										setSelected(null);
									}
								}}
								className="text-muted-foreground hover:text-foreground"
								aria-label="Back"
							>
								<ArrowLeft className="size-4" />
							</button>
						)}
						{step === 1
							? "Create automation"
							: step === 2
								? (template?.name ?? "Configure")
								: "Review"}
					</DialogTitle>
					<DialogDescription>
						{step === 1
							? "Start blank or pick a template. Quick starts ship with entrypoints pre-wired."
							: step === 2
								? (template?.description ?? "Fill in the details.")
								: "Confirm your configuration and create the automation."}
					</DialogDescription>
				</DialogHeader>

				{step === 1 && (
					<TemplateGrid
						onPick={(slug) => {
							setSelected(slug);
							setStep(2);
						}}
					/>
				)}

				{step === 2 && template && (
					<ScrollArea className="max-h-[60dvh]">
						<div className="space-y-3 py-2 pr-4">
							<div>
								<label className="text-xs font-medium text-muted-foreground">
									Name
								</label>
								<input
									type="text"
									value={form.name}
									onChange={(e) =>
										setForm((f) => ({ ...f, name: e.target.value }))
									}
									placeholder={`e.g. ${template.name}`}
									className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
								/>
							</div>

							<div>
								<label className="text-xs font-medium text-muted-foreground">
									Channel
								</label>
								<select
									value={form.channel}
									onChange={(e) =>
										setForm((f) => ({
											...f,
											channel: e.target.value as ChannelOption,
										}))
									}
									className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
								>
									{template.channels.map((c) => (
										<option key={c} value={c}>
											{c}
										</option>
									))}
								</select>
							</div>

							{!blank && template.slug !== "welcome_flow" && template.slug !== "faq_bot" && template.slug !== "lead_capture" && (
								<div>
									<label className="text-xs font-medium text-muted-foreground">
										Account
									</label>
									<div className="mt-1">
										<AccountSearchCombobox
											value={form.social_account_id ?? null}
											onSelect={(id) =>
												setForm((f) => ({ ...f, social_account_id: id ?? undefined }))
											}
											platforms={[form.channel]}
											showAllOption={false}
											placeholder="Select an account"
											variant="input"
										/>
									</div>
								</div>
							)}

							{template.slug === "comment_to_dm" && (
								<CommentToDmFields form={form} setForm={setForm} />
							)}
							{template.slug === "story_leads" && (
								<StoryLeadsFields form={form} setForm={setForm} />
							)}
							{template.slug === "follower_growth" && (
								<FollowerGrowthFields form={form} setForm={setForm} />
							)}
							{template.slug === "follow_to_dm" && (
								<FollowToDmFields form={form} setForm={setForm} />
							)}

							{error && (
								<div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
									{error}
								</div>
							)}
						</div>
					</ScrollArea>
				)}

				{step === 3 && template && (
					<ReviewStep form={form} template={template} />
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onOpenChange(false)}
						disabled={submitting}
					>
						Cancel
					</Button>
					{step === 2 && (
						<Button
							type="button"
							size="sm"
							onClick={() => {
								const problem = validate();
								if (problem) {
									setError(problem);
									return;
								}
								setError(null);
								setStep(3);
							}}
						>
							Review
						</Button>
					)}
					{step === 3 && (
						<Button type="button" size="sm" onClick={submit} disabled={submitting}>
							{submitting ? (
								<Loader2 className="mr-1.5 size-3.5 animate-spin" />
							) : (
								<CheckCircle2 className="mr-1.5 size-3.5" />
							)}
							Create
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// Backwards-compat alias so any caller still importing the old name keeps
// working until the rename is mechanical everywhere.
export const AutomationTemplatePickerDialog = CreateAutomationDialog;
export type AutomationTemplateId = TemplateSlug;

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TemplateGrid({ onPick }: { onPick: (slug: TemplateSlug) => void }) {
	const groups: Array<{ key: "blank" | "quick_start" | "scaffold"; label: string }> = [
		{ key: "blank", label: "Start from scratch" },
		{ key: "quick_start", label: "Quick starts" },
		{ key: "scaffold", label: "Scaffolds" },
	];
	return (
		<ScrollArea className="max-h-[60dvh]">
			<div className="space-y-4 py-2 pr-4">
				{groups.map((g) => {
					const items = TEMPLATES.filter((t) => t.group === g.key);
					if (items.length === 0) return null;
					return (
						<div key={g.key}>
							<div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
								{g.label}
							</div>
							<div className="grid grid-cols-2 gap-2">
								{items.map((t) => (
									<button
										key={t.slug}
										type="button"
										onClick={() => onPick(t.slug)}
										className={cn(
											"group flex flex-col items-start gap-1.5 rounded-md border border-border bg-background p-3 text-left transition-colors hover:border-foreground/30 hover:bg-accent/20",
										)}
									>
										<t.icon className="size-4 text-muted-foreground group-hover:text-foreground" />
										<div className="text-[13px] font-medium">{t.name}</div>
										<div className="text-[11px] leading-snug text-muted-foreground">
											{t.description}
										</div>
										<div className="mt-0.5 flex flex-wrap gap-1">
											{t.channels.map((c) => (
												<span
													key={c}
													className="rounded-full bg-accent/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground"
												>
													{c}
												</span>
											))}
										</div>
									</button>
								))}
							</div>
						</div>
					);
				})}
			</div>
		</ScrollArea>
	);
}

function CommentToDmFields({
	form,
	setForm,
}: {
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
	return (
		<>
			<div>
				<label className="text-xs font-medium text-muted-foreground">
					Posts (optional)
				</label>
				<div className="mt-1">
					<PostSearchCombobox
						value={form.post_ids?.[0] ?? null}
						onSelect={(id) =>
							setForm((f) => ({ ...f, post_ids: id ? [id] : undefined }))
						}
						accountId={form.social_account_id ?? null}
						placeholder={
							form.social_account_id
								? "All posts on this account"
								: "Select an account first"
						}
						variant="input"
					/>
				</div>
			</div>
			<TextField
				label="Keyword filter (comma-separated)"
				value={form.keyword_filter ?? ""}
				onChange={(v) => setForm((f) => ({ ...f, keyword_filter: v }))}
				placeholder="LINK, INFO, PRICE"
			/>
			<TextField
				label="Public reply (optional)"
				value={form.public_reply ?? ""}
				onChange={(v) => setForm((f) => ({ ...f, public_reply: v }))}
				placeholder="Check your DMs!"
			/>
			<TextAreaField
				label="DM text"
				value={form.dm_text ?? ""}
				onChange={(v) => setForm((f) => ({ ...f, dm_text: v }))}
				placeholder="Hey {{first_name}} 👋 here's the link you asked for."
			/>
			<Checkbox
				label="Only once per user"
				checked={form.once_per_user ?? true}
				onChange={(v) => setForm((f) => ({ ...f, once_per_user: v }))}
			/>
			<TextField
				label="Fallback message (optional)"
				value={form.fallback_message ?? ""}
				onChange={(v) => setForm((f) => ({ ...f, fallback_message: v }))}
				placeholder="Sent if the DM couldn't be delivered"
			/>
		</>
	);
}

function StoryLeadsFields({
	form,
	setForm,
}: {
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
	return (
		<>
			<TextField
				label="Keyword filter (optional, comma-separated)"
				value={form.keyword_filter ?? ""}
				onChange={(v) => setForm((f) => ({ ...f, keyword_filter: v }))}
				placeholder="interested, more"
			/>
			<TextAreaField
				label="DM text"
				value={form.dm_text ?? ""}
				onChange={(v) => setForm((f) => ({ ...f, dm_text: v }))}
				placeholder="Thanks for replying! Share your email and we'll follow up."
			/>
			<div>
				<label className="text-xs font-medium text-muted-foreground">
					Capture field
				</label>
				<select
					value={form.capture_field ?? "email"}
					onChange={(e) =>
						setForm((f) => ({
							...f,
							capture_field: e.target.value as "email" | "phone",
						}))
					}
					className="mt-1 h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
				>
					<option value="email">Email</option>
					<option value="phone">Phone</option>
				</select>
			</div>
			<TextField
				label="Success tag"
				value={form.success_tag ?? "story_lead"}
				onChange={(v) => setForm((f) => ({ ...f, success_tag: v }))}
			/>
		</>
	);
}

function FollowerGrowthFields({
	form,
	setForm,
}: {
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
	return (
		<>
			<div>
				<label className="text-xs font-medium text-muted-foreground">
					Contest post
				</label>
				<div className="mt-1">
					<PostSearchCombobox
						value={form.contest_post_id ?? null}
						onSelect={(id) =>
							setForm((f) => ({ ...f, contest_post_id: id ?? undefined }))
						}
						accountId={form.social_account_id ?? null}
						placeholder={
							form.social_account_id
								? "Select the contest post"
								: "Select an account first"
						}
						variant="input"
					/>
				</div>
			</div>
			<TextField
				label="Trigger keyword"
				value={form.trigger_keyword ?? ""}
				onChange={(v) => setForm((f) => ({ ...f, trigger_keyword: v }))}
				placeholder="ENTER"
			/>
			<TextField
				label="Public reply (optional)"
				value={form.public_reply ?? ""}
				onChange={(v) => setForm((f) => ({ ...f, public_reply: v }))}
				placeholder="You're in! Check your DMs."
			/>
			<TextAreaField
				label="DM text"
				value={form.dm_text ?? ""}
				onChange={(v) => setForm((f) => ({ ...f, dm_text: v }))}
				placeholder="Welcome to the contest 🎉"
			/>
			<TextField
				label="Entry requirements (comma-separated, optional)"
				value={(form.entry_requirements ?? []).join(", ")}
				onChange={(v) =>
					setForm((f) => ({
						...f,
						entry_requirements: v
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean),
					}))
				}
				placeholder="follow, tag_friend"
			/>
		</>
	);
}

function FollowToDmFields({
	form,
	setForm,
}: {
	form: FormState;
	setForm: React.Dispatch<React.SetStateAction<FormState>>;
}) {
	return (
		<>
			<TextAreaField
				label="DM text"
				value={form.dm_text ?? ""}
				onChange={(v) => setForm((f) => ({ ...f, dm_text: v }))}
				placeholder="Thanks for following 🙌"
			/>
			<div className="grid grid-cols-2 gap-2">
				<TextField
					label="Daily cap"
					type="number"
					value={String(form.daily_cap ?? 100)}
					onChange={(v) => setForm((f) => ({ ...f, daily_cap: Number(v) || 0 }))}
				/>
				<TextField
					label="Cooldown (hours)"
					type="number"
					value={String(form.cooldown_hours ?? 24)}
					onChange={(v) =>
						setForm((f) => ({ ...f, cooldown_hours: Number(v) || 0 }))
					}
				/>
			</div>
		</>
	);
}

function ReviewStep({
	form,
	template,
}: {
	form: FormState;
	template: TemplateMeta;
}) {
	const rows: Array<[string, string]> = [
		["Template", template.name],
		["Name", form.name || "—"],
		["Channel", form.channel],
	];
	if (form.social_account_id) {
		rows.push(["Account", form.social_account_id.slice(-6)]);
	}
	if (form.dm_text) {
		rows.push([
			"DM text",
			form.dm_text.length > 60
				? `${form.dm_text.slice(0, 60)}…`
				: form.dm_text,
		]);
	}
	if (form.keyword_filter) {
		rows.push(["Keywords", form.keyword_filter]);
	}
	if (form.trigger_keyword) {
		rows.push(["Trigger keyword", form.trigger_keyword]);
	}
	return (
		<div className="space-y-3 py-2">
			<div className="rounded-md border border-border bg-card/40 p-3">
				<table className="w-full text-sm">
					<tbody>
						{rows.map(([k, v]) => (
							<tr key={k}>
								<td className="py-1 pr-4 text-xs text-muted-foreground">{k}</td>
								<td className="py-1 text-[13px] text-foreground">{v}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p className="text-[11px] text-muted-foreground">
				After creation you can tweak the generated graph on the canvas.
			</p>
		</div>
	);
}

// ---- Field atoms ----------------------------------------------------------

function TextField({
	label,
	value,
	onChange,
	placeholder,
	type = "text",
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	type?: string;
}) {
	return (
		<div>
			<label className="text-xs font-medium text-muted-foreground">{label}</label>
			<input
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
			/>
		</div>
	);
}

function TextAreaField({
	label,
	value,
	onChange,
	placeholder,
	rows = 3,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	rows?: number;
}) {
	return (
		<div>
			<label className="text-xs font-medium text-muted-foreground">{label}</label>
			<textarea
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				rows={rows}
				className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
			/>
		</div>
	);
}

function Checkbox({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<label className="flex items-center gap-2 text-[13px] text-foreground">
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
			/>
			{label}
		</label>
	);
}
