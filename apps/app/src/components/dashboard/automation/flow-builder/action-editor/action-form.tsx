// Action form dispatcher (Plan 2 — Unit B4, Task O2).
//
// Selects the right per-type editor based on `action.type`. If the catalog
// contains an unknown/future type we fall back to a read-only JSON view so
// the row is still representable while the operator upgrades.

import { useMemo } from "react";
import { useAutomationCatalog } from "../use-catalog";
import {
	PauseContactForm,
	ResumeContactForm,
} from "./action-forms/automation-controls";
import { ReplyToCommentForm } from "./action-forms/comment";
import { DeleteContactForm } from "./action-forms/contact";
import {
	AssignConversationForm,
	NoFieldsInfo,
	SnoozeConversationForm,
} from "./action-forms/conversation";
import {
	ContactFieldSetForm,
	ConversionEventForm,
} from "./action-forms/data-and-conversion";
import { FieldActionForm } from "./action-forms/field";
import { ChangeMainMenuForm } from "./action-forms/main-menu";
import { NotifyAdminForm } from "./action-forms/notify";
import { SegmentActionForm } from "./action-forms/segment";
import {
	ChannelOptForm,
	ListSubscriptionForm,
} from "./action-forms/subscription";
import { TagActionForm } from "./action-forms/tag";
import { WebhookOutForm } from "./action-forms/webhook";
import { type Action, type ValidationProblem, validateAction } from "./types";
import { AutomationControlsUnknownHint } from "./unknown-hint";

interface Props {
	action: Action;
	onChange(next: Action): void;
}

export function ActionForm({ action, onChange }: Props) {
	const catalog = useAutomationCatalog();
	const problems = useMemo(() => validateAction(action), [action]);
	const errors = problemsToErrorMap(problems);

	const knownTypes = new Set(
		(catalog.data?.action_types ?? [])
			.filter((entry) => entry.enabled !== false)
			.map((entry) => entry.type),
	);
	// If the catalog is loaded but this action type isn't in it, treat it as
	// an "unknown" type — still render *something* so the row remains usable.
	const isUnknown = catalog.data !== undefined && !knownTypes.has(action.type);

	if (isUnknown) {
		return (
			<AutomationControlsUnknownHint
				action={action}
				onChange={onChange}
				knownTypes={Array.from(knownTypes)}
			/>
		);
	}

	switch (action.type) {
		case "tag_add":
		case "tag_remove":
			return (
				<TagActionForm action={action} onChange={onChange} error={errors.tag} />
			);
		case "field_set":
		case "field_clear":
			return (
				<FieldActionForm action={action} onChange={onChange} errors={errors} />
			);
		case "contact_field_set":
			return (
				<ContactFieldSetForm
					action={action}
					onChange={onChange}
					errors={errors}
				/>
			);
		case "segment_add":
		case "segment_remove":
			return (
				<SegmentActionForm
					action={action}
					onChange={onChange}
					error={errors.segment_id}
				/>
			);
		case "subscribe_list":
		case "unsubscribe_list":
			return (
				<ListSubscriptionForm
					action={action}
					onChange={onChange}
					error={errors.list_id}
				/>
			);
		case "opt_in_channel":
		case "opt_out_channel":
			return <ChannelOptForm action={action} onChange={onChange} />;
		case "assign_conversation":
			return (
				<AssignConversationForm
					action={action}
					onChange={onChange}
					error={errors.user_id}
				/>
			);
		case "unassign_conversation":
			return <NoFieldsInfo label="Unassign conversation" />;
		case "conversation_open":
			return <NoFieldsInfo label="Open conversation" />;
		case "conversation_close":
			return <NoFieldsInfo label="Close conversation" />;
		case "reply_to_comment":
			return (
				<ReplyToCommentForm
					action={action}
					onChange={onChange}
					error={errors.text}
				/>
			);
		case "conversation_snooze":
			return (
				<SnoozeConversationForm
					action={action}
					onChange={onChange}
					error={errors.snooze_minutes}
				/>
			);
		case "notify_admin":
			return (
				<NotifyAdminForm action={action} onChange={onChange} errors={errors} />
			);
		case "webhook_out":
			return (
				<WebhookOutForm action={action} onChange={onChange} errors={errors} />
			);
		case "pause_automations_for_contact":
			return (
				<PauseContactForm action={action} onChange={onChange} errors={errors} />
			);
		case "resume_automations_for_contact":
			return <ResumeContactForm action={action} onChange={onChange} />;
		case "delete_contact":
			return (
				<DeleteContactForm
					action={action}
					onChange={onChange}
					error={errors.confirm}
				/>
			);
		case "log_conversion_event":
			return (
				<ConversionEventForm
					action={action}
					onChange={onChange}
					errors={errors}
				/>
			);
		case "change_main_menu":
			return (
				<ChangeMainMenuForm
					action={action}
					onChange={onChange}
					errors={errors}
				/>
			);
		default: {
			return (
				<AutomationControlsUnknownHint
					action={action}
					onChange={onChange}
					knownTypes={Array.from(knownTypes)}
				/>
			);
		}
	}
}

function problemsToErrorMap(
	problems: ValidationProblem[],
): Record<string, string> {
	const map: Record<string, string> = {};
	for (const p of problems) {
		if (!(p.path in map)) map[p.path] = p.message;
	}
	return map;
}
