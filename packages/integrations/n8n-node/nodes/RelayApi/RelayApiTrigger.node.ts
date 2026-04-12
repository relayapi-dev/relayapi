import type {
	IWebhookFunctions,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookResponseData,
} from 'n8n-workflow';
import { relayApiRequest } from './GenericFunctions';

export class RelayApiTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'RelayAPI Trigger',
		name: 'relayApiTrigger',
		icon: 'file:relayapi.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Triggers on RelayAPI webhook events',
		defaults: {
			name: 'RelayAPI Trigger',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'relayApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: [],
				options: [
					{
						name: 'Comment Received',
						value: 'comment.received',
					},
					{
						name: 'Message Received',
						value: 'message.received',
					},
					{
						name: 'Post Failed',
						value: 'post.failed',
					},
					{
						name: 'Post Published',
						value: 'post.published',
					},
					{
						name: 'Post Recycled',
						value: 'post.recycled',
					},
					{
						name: 'Post Scheduled',
						value: 'post.scheduled',
					},
				],
				description: 'The events to listen for',
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const webhookData = this.getWorkflowStaticData('node');

				try {
					const response = await relayApiRequest.call(
						this as any,
						'GET',
						'/v1/webhooks',
					);

					const webhooks = response.data ?? response;
					if (!Array.isArray(webhooks)) return false;

					const existing = webhooks.find(
						(wh: any) => wh.url === webhookUrl,
					);

					if (existing) {
						webhookData.webhookId = existing.id;
						return true;
					}
				} catch {
					// Webhook endpoint may not exist yet — treat as not found
				}

				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default');
				const events = this.getNodeParameter('events') as string[];
				const webhookData = this.getWorkflowStaticData('node');

				const response = await relayApiRequest.call(this as any, 'POST', '/v1/webhooks', {
					url: webhookUrl,
					events,
				});

				const webhook = response.data ?? response;
				webhookData.webhookId = webhook.id;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				const webhookId = webhookData.webhookId as string;

				if (!webhookId) return true;

				try {
					await relayApiRequest.call(this as any, 'DELETE', `/v1/webhooks/${webhookId}`);
				} catch {
					// Webhook may already be deleted — ignore
				}

				delete webhookData.webhookId;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const bodyData = this.getBodyData();

		return {
			workflowData: [this.helpers.returnJsonArray(bodyData)],
		};
	}
}
