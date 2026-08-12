import { describe, expect, it } from 'bun:test';
import { buildCreatePostRequestBody, parseTargetOptions, RelayApi } from '../nodes/RelayApi/RelayApi.node';

describe('n8n post status contract', () => {
	it.each([
		'../../claude-plugin/.claude-plugin/plugin.json',
		'../../cursor-plugin/.cursor-plugin/plugin.json',
		'../../codex-plugin/.codex-plugin/plugin.json',
	])('advertises 22 platforms in %s', async (relativePath) => {
		const manifest = (await Bun.file(new URL(relativePath, import.meta.url)).json()) as {
			description: string;
			interface?: { longDescription?: string };
		};

		expect(manifest.description).toContain('22 platforms');
		expect(manifest.description).not.toContain('21 platforms');
		expect(manifest.interface?.longDescription ?? '').not.toContain('21 platforms');
	});

	it('offers every registered publishing platform, including Slack', () => {
		const node = new RelayApi();
		const platformProperty = node.description.properties.find(
			(property) => property.name === 'platform' && property.displayOptions?.show?.resource?.includes('account'),
		);
		const advertisedPlatforms = (platformProperty?.options ?? []).map((option) => String(option.value)).filter(Boolean);

		expect(advertisedPlatforms).toHaveLength(22);
		expect(new Set(advertisedPlatforms)).toHaveProperty('size', 22);
		expect(advertisedPlatforms).toContain('slack');
	});

	it('forwards typed media and validated target_options to Create Post', () => {
		const targetOptions = {
			whatsapp: { to: '15551234567' },
			snapchat: { content_type: 'saved_story' },
			tiktok: {
				privacy_level: 'SELF_ONLY',
				allow_comment: true,
				allow_duet: false,
				allow_stitch: false,
				brand_content_toggle: false,
				brand_organic_toggle: false,
				content_preview_confirmed: true,
				express_consent_given: true,
			},
		};
		const body = buildCreatePostRequestBody({
			content: '',
			targets: ['whatsapp'],
			scheduledAt: 'now',
			mediaCollection: {
				items: [
					{
						url: 'https://example.com/voice.mp3',
						type: 'audio',
						mimeType: 'audio/mpeg',
						durationMs: 42_000,
					},
				],
			},
			targetOptions: JSON.stringify(targetOptions),
		});

		expect(body).toEqual({
			content: '',
			targets: ['whatsapp'],
			scheduled_at: 'now',
			media: [
				{
					url: 'https://example.com/voice.mp3',
					type: 'audio',
					mime_type: 'audio/mpeg',
					duration_ms: 42_000,
				},
			],
			target_options: targetOptions,
		});
	});

	it('rejects target_options that are not an object of objects', () => {
		expect(() => parseTargetOptions('[{"to":"15551234567"}]')).toThrow('must be a JSON object');
		expect(() => parseTargetOptions('{"whatsapp":null}')).toThrow(
			'must map each platform, account, or workspace target',
		);
		expect(() => parseTargetOptions('{invalid')).toThrow('must be valid JSON');
	});

	it('offers document and audio media attachments plus JSON target options', () => {
		const node = new RelayApi();
		const mediaProperty = node.description.properties.find((property) => property.name === 'media');
		const mediaGroup =
			mediaProperty && 'options' in mediaProperty
				? (mediaProperty.options?.[0] as { values?: Array<{ name: string; options?: unknown[] }> } | undefined)
				: undefined;
		const mediaValues = mediaGroup?.values
			?.find((value) => value.name === 'type')
			?.options?.map((option) => String((option as { value: unknown }).value))
			.filter(Boolean);

		expect(mediaValues).toEqual(['image', 'video', 'gif', 'document', 'audio']);
		expect(mediaGroup?.values?.map((value) => value.name)).toEqual([
			'url',
			'type',
			'mimeType',
			'altText',
			'width',
			'height',
			'durationMs',
		]);
		expect(node.description.properties.find((property) => property.name === 'targetOptions')?.type).toBe('json');
	});

	it('only advertises list filters accepted by the pinned RelayAPI OpenAPI contract', async () => {
		const node = new RelayApi();
		const statusProperty = node.description.properties.find((property) => property.name === 'status');
		expect(statusProperty).toBeDefined();

		const advertisedStatuses = (statusProperty?.options ?? []).map((option) => String(option.value)).filter(Boolean);

		expect(advertisedStatuses).toContain('partial');

		const specUrl = new URL('../../../../apps/docs/openapi.json', import.meta.url);
		const spec = (await Bun.file(specUrl).json()) as {
			paths: Record<
				string,
				{
					get?: {
						parameters?: Array<{ name?: string; schema?: { enum?: string[] } }>;
					};
				}
			>;
		};
		const apiStatuses =
			spec.paths['/v1/posts']?.get?.parameters?.find((parameter) => parameter.name === 'status')?.schema?.enum ?? [];

		for (const status of advertisedStatuses) {
			expect(apiStatuses).toContain(status);
		}
	});
});
