/**
 * Email service — renders React Email templates and sends via queue (or direct fallback).
 */

import { render } from "@react-email/render";
import { sendEmail } from "../lib/email-queue/producer";
import { PaymentFailedReminder } from "../lib/emails/templates/PaymentFailedReminder";
import { PlanDeactivated } from "../lib/emails/templates/PlanDeactivated";

export async function sendPaymentFailedReminder(
	queue: Queue | undefined,
	resendApiKey: string,
	params: {
		to: string;
		orgName: string;
		invoiceUrl: string | null;
		portalUrl: string;
		isSecondReminder: boolean;
	},
): Promise<void> {
	const subject = params.isSecondReminder
		? "[Action Required] Your RelayAPI payment is still outstanding"
		: "Your RelayAPI payment failed";

	const html = await render(
		PaymentFailedReminder({
			orgName: params.orgName,
			invoiceUrl: params.invoiceUrl,
			portalUrl: params.portalUrl,
			isSecondReminder: params.isSecondReminder,
		}),
	);

	await sendEmail(queue, resendApiKey, {
		to: params.to,
		subject,
		html,
	});
}

export async function sendPlanDeactivatedEmail(
	queue: Queue | undefined,
	resendApiKey: string,
	params: {
		to: string;
		orgName: string;
	},
): Promise<void> {
	const html = await render(
		PlanDeactivated({
			orgName: params.orgName,
		}),
	);

	await sendEmail(queue, resendApiKey, {
		to: params.to,
		subject: "Your RelayAPI Pro plan has been deactivated",
		html,
	});
}
