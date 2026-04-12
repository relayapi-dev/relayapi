import { Bundle, ZObject } from 'zapier-platform-core';

const perform = async (z: ZObject, bundle: Bundle) => {
  const params: Record<string, string> = {};

  if (bundle.inputData.status) {
    params.status = bundle.inputData.status;
  }

  params.limit = String(bundle.inputData.limit || 10);

  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/posts',
    method: 'GET',
    params,
  });

  return (response.data as { data: unknown[] }).data || (response.data as unknown[]);
};

const findPost = {
  key: 'find_post',
  noun: 'Post',

  display: {
    label: 'Find Post',
    description: 'Find an existing post by status.',
  },

  operation: {
    inputFields: [
      {
        key: 'status',
        label: 'Status',
        type: 'string' as const,
        required: false,
        helpText: 'Filter posts by status.',
        choices: {
          draft: 'Draft',
          scheduled: 'Scheduled',
          published: 'Published',
          failed: 'Failed',
        },
      },
      {
        key: 'limit',
        label: 'Limit',
        type: 'number' as const,
        required: false,
        default: '10',
        helpText: 'Maximum number of posts to return (1-100).',
      },
    ],

    perform,

    sample: {
      id: 'post_abc123',
      status: 'published',
      content: 'Hello from RelayAPI!',
      created_at: '2025-01-01T00:00:00Z',
    },
  },
};

export default findPost;
