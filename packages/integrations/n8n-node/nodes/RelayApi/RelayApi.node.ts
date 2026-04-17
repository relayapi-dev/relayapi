import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { relayApiRequest } from './GenericFunctions';

const PLATFORMS = [
	'twitter',
	'instagram',
	'facebook',
	'linkedin',
	'tiktok',
	'youtube',
	'pinterest',
	'reddit',
	'bluesky',
	'threads',
	'telegram',
	'snapchat',
	'googlebusiness',
	'whatsapp',
	'mastodon',
	'discord',
	'sms',
] as const;

export class RelayApi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'RelayAPI',
		name: 'relayApi',
		icon: 'file:relayapi.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Post to 21 platforms',
		defaults: {
			name: 'RelayAPI',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'relayApi',
				required: true,
			},
		],
		properties: [
			// ── Resource ──
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Post', value: 'post' },
					{ name: 'Account', value: 'account' },
					{ name: 'Media', value: 'media' },
					{ name: 'Usage', value: 'usage' },
				],
				default: 'post',
			},

			// ── Post Operations ──
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['post'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a post' },
					{ name: 'Delete', value: 'delete', action: 'Delete a post' },
					{ name: 'Get', value: 'get', action: 'Get a post' },
					{ name: 'List', value: 'list', action: 'List posts' },
					{ name: 'Update', value: 'update', action: 'Update a post' },
				],
				default: 'create',
			},

			// ── Account Operations ──
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{ name: 'Get', value: 'get', action: 'Get an account' },
					{ name: 'Health Check', value: 'healthCheck', action: 'Health check accounts' },
					{ name: 'List', value: 'list', action: 'List accounts' },
				],
				default: 'list',
			},

			// ── Media Operations ──
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['media'] } },
				options: [
					{ name: 'List', value: 'list', action: 'List media' },
					{ name: 'Presign', value: 'presign', action: 'Get presigned upload URL' },
				],
				default: 'presign',
			},

			// ── Usage Operations ──
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['usage'] } },
				options: [
					{ name: 'Get', value: 'get', action: 'Get usage info' },
				],
				default: 'get',
			},

			// ─────────────────────────────────────
			// Post: Create
			// ─────────────────────────────────────
			{
				displayName: 'Content',
				name: 'content',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['post'], operation: ['create'] } },
				description: 'The text content of the post',
			},
			{
				displayName: 'Target Accounts',
				name: 'targets',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getAccounts' },
				default: [],
				required: true,
				displayOptions: { show: { resource: ['post'], operation: ['create'] } },
				description: 'Accounts to publish to',
			},
			{
				displayName: 'Schedule',
				name: 'scheduledAt',
				type: 'options',
				options: [
					{ name: 'Publish Now', value: 'now' },
					{ name: 'Save as Draft', value: 'draft' },
					{ name: 'Schedule (set below)', value: 'schedule' },
				],
				default: 'now',
				displayOptions: { show: { resource: ['post'], operation: ['create'] } },
				description: 'When to publish the post',
			},
			{
				displayName: 'Scheduled Date/Time',
				name: 'scheduledDateTime',
				type: 'dateTime',
				default: '',
				displayOptions: {
					show: { resource: ['post'], operation: ['create'], scheduledAt: ['schedule'] },
				},
				description: 'ISO 8601 date/time to schedule the post',
			},
			{
				displayName: 'Timezone',
				name: 'timezone',
				type: 'string',
				default: 'UTC',
				displayOptions: {
					show: { resource: ['post'], operation: ['create'], scheduledAt: ['schedule'] },
				},
				description: 'Timezone for the scheduled time (e.g. America/New_York)',
			},
			{
				displayName: 'Media',
				name: 'media',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				displayOptions: { show: { resource: ['post'], operation: ['create'] } },
				options: [
					{
						name: 'items',
						displayName: 'Media Item',
						values: [
							{
								displayName: 'URL',
								name: 'url',
								type: 'string',
								default: '',
								description: 'URL of the media file',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								options: [
									{ name: 'Image', value: 'image' },
									{ name: 'Video', value: 'video' },
									{ name: 'GIF', value: 'gif' },
								],
								default: 'image',
							},
						],
					},
				],
				description: 'Media attachments for the post',
			},

			// ─────────────────────────────────────
			// Post: Get / Delete
			// ─────────────────────────────────────
			{
				displayName: 'Post ID',
				name: 'postId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['post'], operation: ['get', 'delete', 'update'] } },
				description: 'The ID of the post',
			},

			// ─────────────────────────────────────
			// Post: List
			// ─────────────────────────────────────
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				options: [
					{ name: 'All', value: '' },
					{ name: 'Draft', value: 'draft' },
					{ name: 'Failed', value: 'failed' },
					{ name: 'Partial', value: 'partial' },
					{ name: 'Published', value: 'published' },
					{ name: 'Scheduled', value: 'scheduled' },
				],
				default: '',
				displayOptions: { show: { resource: ['post'], operation: ['list'] } },
				description: 'Filter posts by status',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 20,
				displayOptions: { show: { resource: ['post'], operation: ['list'] } },
				description: 'Max number of results to return',
			},

			// ─────────────────────────────────────
			// Post: Update
			// ─────────────────────────────────────
			{
				displayName: 'Content',
				name: 'updateContent',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				displayOptions: { show: { resource: ['post'], operation: ['update'] } },
				description: 'New content for the post (leave empty to keep current)',
			},
			{
				displayName: 'Scheduled At',
				name: 'updateScheduledAt',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['post'], operation: ['update'] } },
				description: 'New scheduled time (ISO 8601) or "now" or "draft"',
			},

			// ─────────────────────────────────────
			// Account: List
			// ─────────────────────────────────────
			{
				displayName: 'Platform',
				name: 'platform',
				type: 'options',
				options: [
					{ name: 'All', value: '' },
					...PLATFORMS.map((p) => ({
						name: p.charAt(0).toUpperCase() + p.slice(1),
						value: p,
					})),
				],
				default: '',
				displayOptions: { show: { resource: ['account'], operation: ['list'] } },
				description: 'Filter by platform',
			},

			// ─────────────────────────────────────
			// Account: Get
			// ─────────────────────────────────────
			{
				displayName: 'Account ID',
				name: 'accountId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['account'], operation: ['get'] } },
				description: 'The ID of the account',
			},

			// ─────────────────────────────────────
			// Media: Presign
			// ─────────────────────────────────────
			{
				displayName: 'Filename',
				name: 'filename',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['media'], operation: ['presign'] } },
				description: 'Name of the file to upload',
			},
			{
				displayName: 'Content Type',
				name: 'contentType',
				type: 'string',
				default: 'image/jpeg',
				required: true,
				displayOptions: { show: { resource: ['media'], operation: ['presign'] } },
				description: 'MIME type of the file (e.g. image/jpeg, video/mp4)',
			},

			// ─────────────────────────────────────
			// Media: List
			// ─────────────────────────────────────
			{
				displayName: 'Limit',
				name: 'mediaLimit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 20,
				displayOptions: { show: { resource: ['media'], operation: ['list'] } },
				description: 'Max number of results to return',
			},
		],
	};

	methods = {
		loadOptions: {
			async getAccounts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await relayApiRequest.call(this, 'GET', '/v1/accounts', undefined, {
					limit: 100,
				});

				const accounts = response.data ?? response;

				if (!Array.isArray(accounts)) {
					return [];
				}

				return accounts.map((account: any) => ({
					name: `${account.display_name ?? account.username ?? account.id} (${account.platform})`,
					value: account.id,
				}));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				let response: any;

				// ── Post ──
				if (resource === 'post') {
					if (operation === 'create') {
						const content = this.getNodeParameter('content', i) as string;
						const targets = this.getNodeParameter('targets', i) as string[];
						const scheduledAt = this.getNodeParameter('scheduledAt', i) as string;
						const mediaCollection = this.getNodeParameter('media', i) as any;

						const body: Record<string, any> = {
							content,
							targets,
						};

						if (scheduledAt === 'now') {
							body.scheduled_at = 'now';
						} else if (scheduledAt === 'draft') {
							body.scheduled_at = 'draft';
						} else if (scheduledAt === 'schedule') {
							body.scheduled_at = this.getNodeParameter('scheduledDateTime', i) as string;
							body.timezone = this.getNodeParameter('timezone', i) as string;
						}

						if (mediaCollection?.items?.length) {
							body.media = mediaCollection.items.map((item: any) => ({
								url: item.url,
								type: item.type,
							}));
						}

						response = await relayApiRequest.call(this, 'POST', '/v1/posts', body);
					} else if (operation === 'get') {
						const postId = this.getNodeParameter('postId', i) as string;
						response = await relayApiRequest.call(this, 'GET', `/v1/posts/${postId}`);
					} else if (operation === 'list') {
						const limit = this.getNodeParameter('limit', i) as number;
						const status = this.getNodeParameter('status', i) as string;
						const qs: Record<string, string | number> = { limit };
						if (status) {
							qs.status = status;
						}
						response = await relayApiRequest.call(this, 'GET', '/v1/posts', undefined, qs);
					} else if (operation === 'update') {
						const postId = this.getNodeParameter('postId', i) as string;
						const body: Record<string, any> = {};
						const content = this.getNodeParameter('updateContent', i) as string;
						const scheduledAt = this.getNodeParameter('updateScheduledAt', i) as string;
						if (content) body.content = content;
						if (scheduledAt) body.scheduled_at = scheduledAt;
						response = await relayApiRequest.call(
							this,
							'PATCH',
							`/v1/posts/${postId}`,
							body,
						);
					} else if (operation === 'delete') {
						const postId = this.getNodeParameter('postId', i) as string;
						response = await relayApiRequest.call(this, 'DELETE', `/v1/posts/${postId}`);
					}
				}

				// ── Account ──
				if (resource === 'account') {
					if (operation === 'list') {
						const platform = this.getNodeParameter('platform', i) as string;
						const qs: Record<string, string | number> = {};
						if (platform) {
							qs.platform = platform;
						}
						response = await relayApiRequest.call(
							this,
							'GET',
							'/v1/accounts',
							undefined,
							qs,
						);
					} else if (operation === 'get') {
						const accountId = this.getNodeParameter('accountId', i) as string;
						response = await relayApiRequest.call(
							this,
							'GET',
							`/v1/accounts/${accountId}`,
						);
					} else if (operation === 'healthCheck') {
						response = await relayApiRequest.call(
							this,
							'GET',
							'/v1/accounts/health',
						);
					}
				}

				// ── Media ──
				if (resource === 'media') {
					if (operation === 'presign') {
						const filename = this.getNodeParameter('filename', i) as string;
						const contentType = this.getNodeParameter('contentType', i) as string;
						response = await relayApiRequest.call(this, 'POST', '/v1/media/presign', {
							filename,
							content_type: contentType,
						});
					} else if (operation === 'list') {
						const limit = this.getNodeParameter('mediaLimit', i) as number;
						response = await relayApiRequest.call(this, 'GET', '/v1/media', undefined, {
							limit,
						});
					}
				}

				// ── Usage ──
				if (resource === 'usage') {
					response = await relayApiRequest.call(this, 'GET', '/v1/usage');
				}

				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(response),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
