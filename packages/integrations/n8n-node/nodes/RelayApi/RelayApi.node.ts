import type {
	IDataObject,
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
	'slack',
	'sms',
	'beehiiv',
	'convertkit',
	'mailchimp',
	'listmonk',
] as const;

type CreatePostRequestInput = {
	content: string;
	targets: string[];
	scheduledAt: string;
	scheduledDateTime?: string;
	timezone?: string;
	mediaCollection?: IDataObject;
	targetOptions?: unknown;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseTargetOptions(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}

	let parsed: unknown = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new Error('Target Options must be valid JSON.');
		}
	}

	if (!isJsonObject(parsed)) {
		throw new Error('Target Options must be a JSON object keyed by target.');
	}

	for (const [target, options] of Object.entries(parsed)) {
		if (!target.trim() || !isJsonObject(options)) {
			throw new Error('Target Options must map each platform, account, or workspace target to a JSON object.');
		}
	}

	return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function buildCreatePostRequestBody(input: CreatePostRequestInput): Record<string, unknown> {
	const body: Record<string, unknown> = {
		content: input.content,
		targets: input.targets,
	};

	if (input.scheduledAt === 'now' || input.scheduledAt === 'draft') {
		body.scheduled_at = input.scheduledAt;
	} else if (input.scheduledAt === 'schedule') {
		body.scheduled_at = input.scheduledDateTime;
		body.timezone = input.timezone;
	}

	const mediaItems = input.mediaCollection?.items as IDataObject[] | undefined;
	if (mediaItems?.length) {
		body.media = mediaItems.map((item) => ({
			url: item.url,
			type: item.type,
			...(typeof item.altText === 'string' && item.altText ? { alt_text: item.altText } : {}),
			...(typeof item.mimeType === 'string' && item.mimeType ? { mime_type: item.mimeType } : {}),
			...(typeof item.width === 'number' && item.width > 0 ? { width: item.width } : {}),
			...(typeof item.height === 'number' && item.height > 0 ? { height: item.height } : {}),
			...(typeof item.durationMs === 'number' && item.durationMs > 0 ? { duration_ms: item.durationMs } : {}),
		}));
	}

	const targetOptions = parseTargetOptions(input.targetOptions);
	if (targetOptions) {
		body.target_options = targetOptions;
	}

	return body;
}

export class RelayApi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'RelayAPI',
		name: 'relayApi',
		icon: 'file:relayapi.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Post to 22 platforms',
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
					{
						name: 'Health Check',
						value: 'healthCheck',
						action: 'Health check accounts',
					},
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
					{
						name: 'Presign',
						value: 'presign',
						action: 'Get presigned upload URL',
					},
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
				options: [{ name: 'Get', value: 'get', action: 'Get usage info' }],
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
				displayOptions: { show: { resource: ['post'], operation: ['create'] } },
				description: 'The text content of the post. Optional when media or per-target content is provided.',
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
					show: {
						resource: ['post'],
						operation: ['create'],
						scheduledAt: ['schedule'],
					},
				},
				description: 'ISO 8601 date/time to schedule the post',
			},
			{
				displayName: 'Timezone',
				name: 'timezone',
				type: 'string',
				default: 'UTC',
				displayOptions: {
					show: {
						resource: ['post'],
						operation: ['create'],
						scheduledAt: ['schedule'],
					},
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
								required: true,
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
									{ name: 'Document', value: 'document' },
									{ name: 'Audio', value: 'audio' },
								],
								default: 'image',
							},
							{
								displayName: 'MIME Type',
								name: 'mimeType',
								type: 'string',
								default: '',
								description: 'Authoritative MIME type when known (e.g. audio/mpeg)',
							},
							{
								displayName: 'Alt Text',
								name: 'altText',
								type: 'string',
								default: '',
								description: 'Accessible media description',
							},
							{
								displayName: 'Width',
								name: 'width',
								type: 'number',
								typeOptions: { minValue: 0 },
								default: 0,
								description: 'Width in pixels when known',
							},
							{
								displayName: 'Height',
								name: 'height',
								type: 'number',
								typeOptions: { minValue: 0 },
								default: 0,
								description: 'Height in pixels when known',
							},
							{
								displayName: 'Duration (Milliseconds)',
								name: 'durationMs',
								type: 'number',
								typeOptions: { minValue: 0 },
								default: 0,
								description: 'Media duration in milliseconds. Required for TikTok video validation.',
							},
						],
					},
				],
				description: 'Media attachments for the post',
			},
			{
				displayName: 'Target Options (JSON)',
				name: 'targetOptions',
				type: 'json',
				typeOptions: { rows: 12 },
				default: '{}',
				displayOptions: { show: { resource: ['post'], operation: ['create'] } },
				description:
					'JSON object keyed by platform, account ID, or workspace ID. Examples: {"whatsapp":{"to":"15551234567"}}, {"snapchat":{"content_type":"saved_story"}}, or {"tiktok":{"privacy_level":"SELF_ONLY","allow_comment":true,"allow_duet":false,"allow_stitch":false,"brand_content_toggle":false,"brand_organic_toggle":false,"content_preview_confirmed":true,"express_consent_given":true}}.',
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
				displayOptions: {
					show: { resource: ['post'], operation: ['get', 'delete', 'update'] },
				},
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
				displayOptions: {
					show: { resource: ['account'], operation: ['list'] },
				},
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
				displayOptions: {
					show: { resource: ['media'], operation: ['presign'] },
				},
				description: 'Name of the file to upload',
			},
			{
				displayName: 'Content Type',
				name: 'contentType',
				type: 'string',
				default: 'image/jpeg',
				required: true,
				displayOptions: {
					show: { resource: ['media'], operation: ['presign'] },
				},
				description: 'MIME type of the file (e.g. image/jpeg, video/mp4, audio/mpeg, application/pdf)',
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

				return (accounts as IDataObject[]).map((account: IDataObject) => ({
					name: `${account.display_name ?? account.username ?? account.id} (${account.platform})`,
					value: account.id as string,
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
				let response: IDataObject | undefined;

				// ── Post ──
				if (resource === 'post') {
					if (operation === 'create') {
						const content = this.getNodeParameter('content', i) as string;
						const targets = this.getNodeParameter('targets', i) as string[];
						const scheduledAt = this.getNodeParameter('scheduledAt', i) as string;
						const mediaCollection = this.getNodeParameter('media', i) as IDataObject;
						const targetOptions = this.getNodeParameter('targetOptions', i) as unknown;
						const body = buildCreatePostRequestBody({
							content,
							targets,
							scheduledAt,
							scheduledDateTime:
								scheduledAt === 'schedule' ? (this.getNodeParameter('scheduledDateTime', i) as string) : undefined,
							timezone: scheduledAt === 'schedule' ? (this.getNodeParameter('timezone', i) as string) : undefined,
							mediaCollection,
							targetOptions,
						});

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
						const body: Record<string, unknown> = {};
						const content = this.getNodeParameter('updateContent', i) as string;
						const scheduledAt = this.getNodeParameter('updateScheduledAt', i) as string;
						if (content) body.content = content;
						if (scheduledAt) body.scheduled_at = scheduledAt;
						response = await relayApiRequest.call(this, 'PATCH', `/v1/posts/${postId}`, body);
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
						response = await relayApiRequest.call(this, 'GET', '/v1/accounts', undefined, qs);
					} else if (operation === 'get') {
						const accountId = this.getNodeParameter('accountId', i) as string;
						response = await relayApiRequest.call(this, 'GET', `/v1/accounts/${accountId}`);
					} else if (operation === 'healthCheck') {
						response = await relayApiRequest.call(this, 'GET', '/v1/accounts/health');
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
					this.helpers.returnJsonArray(response as IDataObject),
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
