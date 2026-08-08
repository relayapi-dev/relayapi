export interface EmailQueueMessage {
	id: string;
}

/** Application-encrypted in `email_deliveries`; never place this in Queue. */
export interface EmailDeliveryEnvelope {
	to: string;
	subject: string;
	html: string;
	from?: string;
}

export interface EmailSendResult {
	success: boolean;
	shouldRetry: boolean;
	error?: string;
	providerMessageId?: string;
}
