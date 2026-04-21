// Action form dispatcher (Plan 2 — Unit B4, Task O2).
//
// Selects the right per-type editor based on `action.type`. If the catalog
// contains an unknown/future type we fall back to a read-only JSON view so
// the row is still representable while the operator upgrades.

import { useMemo } from "react";
import { useAutomationCatalog } from "../use-catalog";
import { AutomationControlsUnknownHint } from "./unknown-hint";
import {
	AssignConversationForm,
	NoFieldsInfo,
	SnoozeConversationForm,
} from "./action-forms/conversation";
import { ChangeMainMenuForm } from "./action-forms/change-main-menu";
import { ChannelOptForm, ListSubscriptionForm } from "./action-forms/subscription";
import { DeleteContactForm } from "./action-forms/contact";
import { FieldActionForm } from "./action-forms/field";
import { LogConversionForm } from "./action-forms/conversion";
import { NotifyAdminForm } from "./action-forms/notify";
import {
	PauseContactForm,
	ResumeContactForm,
} from "./action-forms/automation-controls";
import { SegmentActionForm } from "./action-forms/segment";
import { TagActionForm } from "./action-forms/tag";
import { WebhookOutForm } from "./action-forms/webhook";
import {
	validateAction,
	type Action,
	type ValidationProblem,
} from "./types";

interface Props {
	action: Action;
	onChange(next: Action): void;
}

export function ActionForm({ action, onChange }: Props) {
	const catalog = useAutomationCatalog();
	const problems = useMemo(() => validateAction(action), [action]);
	const errors = problemsToErrorMap(problems);

	const knownTypes = new Set(
		(catalog.data?.action_types ?? []).map((t) => t.type),
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
				<TagActionForm
					action={action}
					onChange={onChange}
					error={errors.tag}
				/>
			);
		case "field_set":
		case "field_clear":
			return (
				<FieldActionForm
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
				<NotifyAdminForm
					action={action}
					onChange={onChange}
					errors={errors}
				/>
			);
		case "webhook_out":
			return (
				<WebhookOutForm action={action} onChange={onChange} errors={errors} />
			);
		case "pause_automations_for_contact":
			return (
				<PauseContactForm
					action={action}
					onChange={onChange}
					errors={errors}
				/>
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
				<LogConversionForm
					action={action}
					onChange={onChange}
					errors={errors}
				/>
			);
		case "change_main_menu":
			return <ChangeMainMenuForm action={action} onChange={onChange} />;
		default: {
			// Exhaustiveness — unreachable in well-typed code, but we return a
			// stub rather than crashing if an ActionType is added elsewhere.
			const _exhaust: never = action;
			void _exhaust;
			return null;
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
