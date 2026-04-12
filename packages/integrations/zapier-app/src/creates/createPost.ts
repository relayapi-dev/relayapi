import { Bundle, ZObject } from 'zapier-platform-core';

const perform = async (z: ZObject, bundle: Bundle) => {
  const { content, targets, scheduled_at, media, timezone } = bundle.inputData;

  const body: Record<string, unknown> = {
    targets: (targets as string[]).map((accountId: string) => ({ account_id: accountId })),
    scheduled_at: scheduled_at || 'now',
  };

  if (content) {
    body.content = content;
  }

  if (timezone) {
    body.timezone = timezone;
  }

  if (media && (media as string[]).length > 0) {
    body.media = (media as string[]).map((url: string) => ({ url }));
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
    important: true,
  },

  operation: {
    inputFields: [
      {
        key: 'content',
        label: 'Content',
        type: 'text' as const,
        required: false,
        helpText:
          'The text content of your post. Optional if using per-target content.',
      },
      {
        key: 'targets',
        label: 'Target Accounts',
        type: 'string' as const,
        list: true,
        required: true,
        dynamic: 'find_account.id.display_name',
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
        key: 'media',
        label: 'Media URLs',
        type: 'string' as const,
        list: true,
        required: false,
        helpText:
          'Public URLs of images or videos to attach. Use the Upload Media action to get a URL first if needed.',
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
