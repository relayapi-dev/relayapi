import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
	type AccountOption,
	AccountSearchCombobox,
} from "@/components/dashboard/account-search-combobox";
import { ContactSearchPicker } from "@/components/dashboard/campaigns/contact-search-picker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useMutation } from "@/hooks/use-api";

interface SelectedContact {
	id: string;
	phone: string;
	name: string | null;
	tags?: string[];
}

interface WhatsAppTemplate {
	id: string;
	name: string;
	language: string;
	status: string;
}

interface BroadcastsCreateDialogProps {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onCreated: () => void;
}

export function BroadcastsCreateDialog({
	open,
	onOpenChange,
	onCreated,
}: BroadcastsCreateDialogProps) {
	const [name, setName] = useState("");
	const [accountId, setAccountId] = useState("");
	const [accountPlatform, setAccountPlatform] = useState<string | null>(null);
	const [accountWorkspaceId, setAccountWorkspaceId] = useState<string | null>(
		null,
	);
	const [message, setMessage] = useState("");
	const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
	const [templateName, setTemplateName] = useState("");
	const [templateLanguage, setTemplateLanguage] = useState("en_US");
	const [templatesLoading, setTemplatesLoading] = useState(false);
	const [selectedContacts, setSelectedContacts] = useState<SelectedContact[]>(
		[],
	);
	const [scheduleEnabled, setScheduleEnabled] = useState(false);
	const [scheduledAt, setScheduledAt] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	const createMutation = useMutation<{ id: string }>("broadcasts", "POST");

	// Reset form when dialog closes
	useEffect(() => {
		if (!open) {
			setName("");
			setAccountId("");
			setAccountPlatform(null);
			setAccountWorkspaceId(null);
			setMessage("");
			setTemplates([]);
			setTemplateName("");
			setTemplateLanguage("en_US");
			setSelectedContacts([]);
			setScheduleEnabled(false);
			setScheduledAt("");
			setError(null);
		}
	}, [open]);

	useEffect(() => {
		if (accountPlatform !== "whatsapp" || !accountId) {
			setTemplates([]);
			setTemplateName("");
			setTemplateLanguage("en_US");
			return;
		}

		const controller = new AbortController();
		setTemplatesLoading(true);
		void fetch(
			`/api/whatsapp/templates?account_id=${encodeURIComponent(accountId)}`,
			{ signal: controller.signal },
		)
			.then(async (response) => {
				if (!response.ok)
					throw new Error(`Failed to load templates (${response.status})`);
				return response.json() as Promise<{ data?: WhatsAppTemplate[] }>;
			})
			.then((response) => {
				const approved = (response.data ?? []).filter(
					(template) => template.status.toLowerCase() === "approved",
				);
				setTemplates(approved);
				const first = approved[0];
				setTemplateName(first?.name ?? "");
				setTemplateLanguage(first?.language ?? "en_US");
			})
			.catch((cause: unknown) => {
				if (cause instanceof DOMException && cause.name === "AbortError")
					return;
				setTemplates([]);
				setTemplateName("");
				setError(
					cause instanceof Error ? cause.message : "Failed to load templates",
				);
			})
			.finally(() => {
				if (!controller.signal.aborted) setTemplatesLoading(false);
			});

		return () => controller.abort();
	}, [accountId, accountPlatform]);

	const buildBody = () => {
		return {
			...(name.trim() ? { name: name.trim() } : {}),
			account_id: accountId,
			...(accountWorkspaceId ? { workspace_id: accountWorkspaceId } : {}),
			...(accountPlatform === "whatsapp"
				? {
						template: {
							name: templateName,
							language: templateLanguage,
						},
					}
				: { message_text: message.trim() }),
		};
	};

	const validate = (willDeliver: boolean) => {
		setError(null);
		if (!accountId) {
			setError("Account is required.");
			return false;
		}
		if (accountPlatform === "whatsapp" ? !templateName : !message.trim()) {
			setError(
				accountPlatform === "whatsapp"
					? "Select an approved WhatsApp template."
					: "Message is required.",
			);
			return false;
		}
		if (willDeliver && selectedContacts.length === 0) {
			setError("Select at least one recipient before delivery.");
			return false;
		}
		if (willDeliver && scheduleEnabled) {
			const scheduled = new Date(scheduledAt);
			if (
				!scheduledAt ||
				Number.isNaN(scheduled.getTime()) ||
				scheduled <= new Date()
			) {
				setError("Choose a future delivery time.");
				return false;
			}
		}
		return true;
	};

	const createDraftWithRecipients = async (requireRecipients: boolean) => {
		const result = await createMutation.mutate(buildBody());
		if (!result) return null;
		if (selectedContacts.length === 0) return result;

		const recipientsResponse = await fetch(
			`/api/broadcasts/${encodeURIComponent(result.id)}/recipients`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contact_ids: selectedContacts.map((contact) => contact.id),
				}),
			},
		);
		const recipients = (await recipientsResponse.json().catch(() => null)) as {
			added?: number;
			error?: { message?: string };
		} | null;
		if (!recipientsResponse.ok) {
			throw new Error(
				recipients?.error?.message ??
					`Draft created, but recipients could not be added (${recipientsResponse.status}).`,
			);
		}
		if (requireRecipients && !recipients?.added) {
			throw new Error(
				"Draft created, but no selected recipient has current marketing consent.",
			);
		}
		return result;
	};

	const handleCreateDraft = async () => {
		if (!validate(false)) return;
		setSubmitting(true);
		try {
			const result = await createDraftWithRecipients(false);
			if (!result) return;
			onCreated();
			onOpenChange(false);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Failed to create draft.",
			);
		} finally {
			setSubmitting(false);
		}
	};

	const handleCreateAndDeliver = async () => {
		if (!validate(true)) return;
		setSubmitting(true);
		try {
			const result = await createDraftWithRecipients(true);
			if (!result) return;
			const action = scheduleEnabled ? "schedule" : "send";
			const response = await fetch(
				`/api/broadcasts/${encodeURIComponent(result.id)}/${action}`,
				{
					method: "POST",
					...(scheduleEnabled
						? {
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									scheduled_at: new Date(scheduledAt).toISOString(),
								}),
							}
						: {}),
				},
			);
			if (!response.ok) {
				const responseBody = (await response.json().catch(() => null)) as {
					error?: { message?: string };
				} | null;
				throw new Error(
					responseBody?.error?.message ??
						`Draft created, but delivery could not be queued (${response.status}).`,
				);
			}
			onCreated();
			onOpenChange(false);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Failed to queue broadcast.",
			);
		} finally {
			setSubmitting(false);
		}
	};

	const busy = submitting || createMutation.loading;
	const contentReady =
		accountPlatform === "whatsapp"
			? Boolean(templateName)
			: Boolean(message.trim());

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-base">Create Broadcast</DialogTitle>
					<DialogDescription className="text-xs">
						Send a message to multiple recipients at once.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 py-2">
					{/* Name */}
					<div>
						<label
							htmlFor="broadcast-name"
							className="text-xs font-medium text-muted-foreground"
						>
							Name
						</label>
						<input
							id="broadcast-name"
							type="text"
							placeholder="e.g. Welcome campaign"
							value={name}
							onChange={(e) => setName(e.target.value)}
							className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
						/>
					</div>

					{/* Account */}
					<div>
						<span className="text-xs font-medium text-muted-foreground">
							Account
						</span>
						<div className="mt-1">
							<AccountSearchCombobox
								value={accountId || null}
								onSelect={(id) => {
									setAccountId(id || "");
									setSelectedContacts([]);
								}}
								onSelectAccount={(account: AccountOption | null) => {
									setAccountPlatform(account?.platform.toLowerCase() ?? null);
									setAccountWorkspaceId(account?.workspace?.id ?? null);
									setMessage("");
									setError(null);
								}}
								showAllOption={false}
								placeholder="Select an account"
								variant="input"
							/>
						</div>
					</div>

					{accountPlatform === "whatsapp" ? (
						<div>
							<label
								htmlFor="broadcast-template"
								className="text-xs font-medium text-muted-foreground"
							>
								Approved template
							</label>
							<select
								id="broadcast-template"
								value={`${templateName}:${templateLanguage}`}
								onChange={(event) => {
									const selected = templates.find(
										(template) =>
											`${template.name}:${template.language}` ===
											event.target.value,
									);
									setTemplateName(selected?.name ?? "");
									setTemplateLanguage(selected?.language ?? "en_US");
								}}
								disabled={templatesLoading || templates.length === 0}
								className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
							>
								{templatesLoading ? (
									<option value=":en_US">Loading templates…</option>
								) : templates.length === 0 ? (
									<option value=":en_US">No approved templates</option>
								) : (
									templates.map((template) => (
										<option
											key={template.id}
											value={`${template.name}:${template.language}`}
										>
											{template.name} ({template.language})
										</option>
									))
								)}
							</select>
							<p className="mt-1 text-[11px] text-muted-foreground">
								WhatsApp marketing broadcasts use an approved template.
							</p>
						</div>
					) : (
						<div>
							<label
								htmlFor="broadcast-message"
								className="text-xs font-medium text-muted-foreground"
							>
								Message
							</label>
							<textarea
								id="broadcast-message"
								placeholder="Type your message..."
								value={message}
								onChange={(e) => setMessage(e.target.value)}
								rows={4}
								className="mt-1 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
							/>
						</div>
					)}

					{/* Recipients */}
					<div>
						<span className="text-xs font-medium text-muted-foreground">
							Recipients
						</span>
						<div className="mt-1">
							<ContactSearchPicker
								accountId={accountId}
								selected={selectedContacts}
								onSelectionChange={setSelectedContacts}
							/>
						</div>
					</div>

					{/* Schedule */}
					<label
						htmlFor="broadcast-schedule-enabled"
						className="flex cursor-pointer items-center gap-2"
					>
						<Checkbox
							id="broadcast-schedule-enabled"
							checked={scheduleEnabled}
							onCheckedChange={(checked) =>
								setScheduleEnabled(Boolean(checked))
							}
						/>
						<span className="text-xs text-foreground">Schedule for later</span>
					</label>
					{scheduleEnabled && (
						<input
							aria-label="Scheduled delivery time"
							type="datetime-local"
							value={scheduledAt}
							onChange={(e) => setScheduledAt(e.target.value)}
							className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
						/>
					)}

					{/* Error */}
					{(error || createMutation.error) && (
						<div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
							{error || createMutation.error}
						</div>
					)}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onOpenChange(false)}
						disabled={busy}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={handleCreateDraft}
						disabled={busy || !accountId || !contentReady}
					>
						{busy ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							"Create Draft"
						)}
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={handleCreateAndDeliver}
						disabled={
							busy ||
							!accountId ||
							!contentReady ||
							selectedContacts.length === 0
						}
					>
						{busy ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : scheduleEnabled ? (
							"Create & Schedule"
						) : (
							"Create & Send"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
