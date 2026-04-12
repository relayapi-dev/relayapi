import { Resend } from "resend";
import type { EmailQueueMessage, EmailSendResult } from "./types";

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_FROM = "RelayAPI <notifications@relayapi.dev>";

export async function processEmailMessage(
	message: EmailQueueMessage,
	resendApiKey: string,
): Promise<EmailSendResult> {
	const resend = new Resend(resendApiKey);
	const from = message.from || DEFAULT_FROM;

	try {
		const { error } = await resend.emails.send({
			from,
			to: message.to,
			subject: message.subject,
			html: message.html,
		});

		if (!error) {
			console.log(
				`[EmailQueue] Sent email ${message.id} to ${message.to}: "${message.subject}"`,
			);
			return { success: true, shouldRetry: false };
		}

		const statusCode = (error as any).statusCode as number | undefined;
		const shouldRetry = statusCode ? RETRYABLE_STATUS_CODES.has(statusCode) : false;

		console.error(
			`[EmailQueue] Failed to send email ${message.id} (status ${statusCode ?? "unknown"}, retry=${shouldRetry}): ${error.message}`,
		);

		return {
			success: false,
			shouldRetry,
			error: error.message,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		console.error(
			`[EmailQueue] Network error sending email ${message.id}: ${errorMessage}`,
		);
		return { success: false, shouldRetry: true, error: errorMessage };
	}
}

export function handleDeadLetterMessage(message: EmailQueueMessage): void {
	console.error(
		`[EmailQueue DLQ] Email ${message.id} permanently failed after max retries`,
		{
			to: message.to,
			subject: message.subject,
			id: message.id,
		},
	);
}
