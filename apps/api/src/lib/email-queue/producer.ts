import { Resend } from "resend";
import type { EmailQueueMessage } from "./types";

const DEFAULT_FROM = "RelayAPI <notifications@relayapi.dev>";

export interface SendEmailOptions {
	/** Owning tenant for durable failure-ledger cleanup. */
	organizationId: string;
	to: string;
	subject: string;
	html: string;
	from?: string;
	/** Stable for one logical email occurrence. */
	idempotencyKey: string;
}

/**
 * Enqueue an email to be sent via Cloudflare Queue.
 */
export async function enqueueEmail(
	queue: Queue,
	options: SendEmailOptions,
): Promise<void> {
	const message: EmailQueueMessage = {
		id: options.idempotencyKey,
		organization_id: options.organizationId,
		to: options.to,
		subject: options.subject,
		html: options.html,
		from: options.from || DEFAULT_FROM,
	};

	await queue.send(message);
	console.log(`[EmailQueue] Enqueued email ${message.id}`);
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
	const idempotencyKey = options.idempotencyKey;

	const { error } = await resend.emails.send(
		{
			from,
			to: options.to,
			subject: options.subject,
			html: options.html,
		},
		{ idempotencyKey },
	);

	if (error) {
		console.error(`[EmailQueue] Direct send failed (${error.name})`);
		throw new Error(`Failed to send email: ${error.message}`);
	}

	console.log(`[EmailQueue] Direct sent email ${idempotencyKey}`);
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
