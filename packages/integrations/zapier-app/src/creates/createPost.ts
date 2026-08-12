import type { Bundle, ZObject } from 'zapier-platform-core';

const MEDIA_TYPES = ['image', 'video', 'gif', 'document', 'audio'] as const;
const MEDIA_ITEM_KEYS = new Set([
  'url',
  'type',
  'alt_text',
  'mime_type',
  'width',
  'height',
  'duration_ms',
]);
type MediaType = (typeof MEDIA_TYPES)[number];
type MediaItem = {
  url: string;
  type?: MediaType;
  alt_text?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration_ms?: number;
};

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseJsonInput = (value: unknown, label: string): unknown => {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
};

export const parseTargetOptions = (
  value: unknown,
): Record<string, Record<string, unknown>> | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = parseJsonInput(value, 'Target Options');
  if (!isJsonObject(parsed)) {
    throw new Error('Target Options must be a JSON object keyed by target.');
  }

  for (const [target, options] of Object.entries(parsed)) {
    if (!target.trim() || !isJsonObject(options)) {
      throw new Error(
        'Target Options must map each platform, account, or workspace target to a JSON object.',
      );
    }
  }

  return Object.keys(parsed).length > 0
    ? (parsed as Record<string, Record<string, unknown>>)
    : undefined;
};

export const parseMediaItems = (value: unknown): MediaItem[] | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = parseJsonInput(value, 'Media Items');
  if (!Array.isArray(parsed) || parsed.length > 50) {
    throw new Error('Media Items must be a JSON array with at most 50 items.');
  }

  const media = parsed.map((item, index): MediaItem => {
    if (!isJsonObject(item) || typeof item.url !== 'string') {
      throw new Error(`Media Items entry ${index + 1} must contain a URL.`);
    }

    if (Object.keys(item).some((key) => !MEDIA_ITEM_KEYS.has(key))) {
      throw new Error(`Media Items entry ${index + 1} contains an unsupported field.`);
    }

    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      throw new Error(`Media Items entry ${index + 1} has an invalid URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Media Items entry ${index + 1} URL must use HTTP or HTTPS.`);
    }

    if (
      item.type !== undefined &&
      (!MEDIA_TYPES.includes(item.type as MediaType) || typeof item.type !== 'string')
    ) {
      throw new Error(
        `Media Items entry ${index + 1} type must be image, video, gif, document, or audio.`,
      );
    }

    if (item.alt_text !== undefined && typeof item.alt_text !== 'string') {
      throw new Error(`Media Items entry ${index + 1} alt_text must be a string.`);
    }
    if (item.mime_type !== undefined && typeof item.mime_type !== 'string') {
      throw new Error(`Media Items entry ${index + 1} mime_type must be a string.`);
    }
    for (const dimension of ['width', 'height'] as const) {
      const value = item[dimension];
      if (
        value !== undefined &&
        (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
      ) {
        throw new Error(`Media Items entry ${index + 1} ${dimension} must be a positive integer.`);
      }
    }
    if (
      item.duration_ms !== undefined &&
      (typeof item.duration_ms !== 'number' ||
        !Number.isInteger(item.duration_ms) ||
        item.duration_ms < 0)
    ) {
      throw new Error(`Media Items entry ${index + 1} duration_ms must be a non-negative integer.`);
    }

    return item as MediaItem;
  });

  return media.length > 0 ? media : undefined;
};

const perform = async (z: ZObject, bundle: Bundle) => {
  const { content, targets, scheduled_at, media, media_items, target_options, timezone } =
    bundle.inputData;

  const body: Record<string, unknown> = {
    targets: targets as string[],
    scheduled_at: scheduled_at || 'now',
  };

  if (content) {
    body.content = content;
  }

  if (timezone) {
    body.timezone = timezone;
  }

  const typedMedia = parseMediaItems(media_items);
  if (typedMedia) {
    body.media = typedMedia;
  } else {
    const legacyMedia = Array.isArray(media)
      ? media
      : typeof media === 'string' && media
        ? [media]
        : [];
    if (legacyMedia.length > 0) {
      body.media = legacyMedia.map((url) => ({ url }));
    }
  }

  const targetOptions = parseTargetOptions(target_options);
  if (targetOptions) {
    body.target_options = targetOptions;
  }

  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/posts',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify(body),
  });

  return response.data;
};

const createPost = {
  key: 'create_post',
  noun: 'Post',

  display: {
    label: 'Create Post',
    description: 'Publish or schedule a post to one or more social media platforms.',
  },

  operation: {
    inputFields: [
      {
        key: 'content',
        label: 'Content',
        type: 'text' as const,
        required: false,
        helpText: 'The text content of your post. Optional if using per-target content.',
      },
      {
        key: 'targets',
        label: 'Target Accounts',
        type: 'string' as const,
        list: true,
        required: true,
        dynamic: 'account_options.id.display_name',
        helpText: 'Select one or more connected social media accounts to post to.',
      },
      {
        key: 'scheduled_at',
        label: 'Schedule',
        type: 'string' as const,
        required: true,
        default: 'now',
        helpText:
          '"now" to publish immediately, "draft" to save as draft, or an ISO 8601 timestamp (e.g. 2025-06-15T14:00:00Z) to schedule.',
      },
      {
        key: 'media_items',
        label: 'Media Items',
        type: 'json' as const,
        required: false,
        schema: {
          type: 'array',
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', format: 'uri' },
              type: { type: 'string', enum: MEDIA_TYPES },
              alt_text: { type: 'string' },
              mime_type: { type: 'string' },
              width: { type: 'integer', minimum: 1 },
              height: { type: 'integer', minimum: 1 },
              duration_ms: { type: 'integer', minimum: 0 },
            },
            required: ['url'],
            additionalProperties: false,
          },
        },
        helpText:
          'Enter a JSON array of attachment objects. Each object requires a url and may set type to image, video, GIF, document, or audio.',
      },
      {
        key: 'media',
        label: 'Media URLs (Legacy)',
        type: 'string' as const,
        list: true,
        required: false,
        helpText:
          'Legacy untyped public URLs. Prefer Media Items so RelayAPI receives an explicit image, video, GIF, document, or audio type.',
      },
      {
        key: 'target_options',
        label: 'Target Options',
        type: 'json' as const,
        required: false,
        schema: {
          type: 'object',
          additionalProperties: { type: 'object' },
        },
        helpText:
          'JSON object keyed by platform, account ID, or workspace ID. Examples: {"whatsapp":{"to":"15551234567"}}, {"snapchat":{"content_type":"saved_story"}}, or {"tiktok":{"privacy_level":"SELF_ONLY","allow_comment":true,"allow_duet":false,"allow_stitch":false,"brand_content_toggle":false,"brand_organic_toggle":false,"content_preview_confirmed":true,"express_consent_given":true}}.',
      },
      {
        key: 'timezone',
        label: 'Timezone',
        type: 'string' as const,
        required: false,
        default: 'UTC',
        helpText: 'Timezone for the scheduled_at timestamp (e.g. America/New_York).',
      },
    ],

    perform,

    sample: {
      id: 'post_abc123',
      status: 'published',
      content: 'Hello!',
      targets: {},
      created_at: '2025-01-01T00:00:00Z',
    },
  },
};

export default createPost;
