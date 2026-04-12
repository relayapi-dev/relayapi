import { Resend } from "resend";
import type { EmailQueueMessage } from "./types";

const DEFAULT_FROM = "RelayAPI <notifications@relayapi.dev>";

export interface SendEmailOptions {
	to: string;
	subject: string;
	html: string;
	from?: string;
}

/**
 * Enqueue an email to be sent via Cloudflare Queue.
 */
export async function enqueueEmail(
	queue: Queue,
	options: SendEmailOptions,
): Promise<void> {
	const message: EmailQueueMessage = {
		id: crypto.randomUUID(),
		to: options.to,
		subject: options.subject,
		html: options.html,
		from: options.from || DEFAULT_FROM,
	};

	await queue.send(message);
	console.log(
		`[EmailQueue] Enqueued email ${message.id} to ${message.to}: "${message.subject}"`,
	);
}

/**
 * Send an email directly via Resend (fallback for local dev without queue binding).
 */
export async function sendEmailDirect(
	resendApiKey: string,
	options: SendEmailOptions,
): Promise<void> {
	const resend = new Resend(resendApiKey);
	const from = options.from || DEFAULT_FROM;

	const { error } = await resend.emails.send({
		from,
		to: options.to,
		subject: options.subject,
		html: options.html,
	});

	if (error) {
		console.error(
			`[EmailQueue] Direct send failed: ${error.message}`,
		);
		throw new Error(`Failed to send email: ${error.message}`);
	}

	console.log(
		`[EmailQueue] Direct sent email to ${options.to}: "${options.subject}"`,
	);
}

/**
 * Send an email: uses queue if available, falls back to direct send.
 */
export async function sendEmail(
	queue: Queue | undefined,
	resendApiKey: string,
	options: SendEmailOptions,
): Promise<void> {
	if (queue) {
		await enqueueEmail(queue, options);
	} else {
		await sendEmailDirect(resendApiKey, options);
	}
}
