/**
 * Email service — renders React Email templates and sends via queue (or direct fallback).
 */

import { sendEmail } from "../lib/email-queue/producer";

/**
 * react-email + templates are loaded lazily so this module (imported from
 * the queue consumer entry) doesn't drag the react-email stack — the
 * largest chunk of the worker bundle — into cold-start evaluation.
 * Rendering only happens for dunning cron emails.
 */
async function loadRenderStack() {
	const [{ render }, { PaymentFailedReminder }, { PlanDeactivated }] =
		await Promise.all([
			import("@react-email/render"),
			import("../lib/emails/templates/PaymentFailedReminder"),
			import("../lib/emails/templates/PlanDeactivated"),
		]);
	return { render, PaymentFailedReminder, PlanDeactivated };
}

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

	const { render, PaymentFailedReminder } = await loadRenderStack();
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
	const { render, PlanDeactivated } = await loadRenderStack();
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
