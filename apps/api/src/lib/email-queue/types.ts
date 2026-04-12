export interface EmailQueueMessage {
	id: string;
	to: string;
	subject: string;
	html: string;
	from?: string;
}

export interface EmailSendResult {
	success: boolean;
	shouldRetry: boolean;
	error?: string;
}
