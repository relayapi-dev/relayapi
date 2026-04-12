import { Bundle, ZObject } from 'zapier-platform-core';

const perform = async (z: ZObject, bundle: Bundle) => {
  const { postId, content, scheduled_at } = bundle.inputData;

  const body: Record<string, unknown> = {};

  if (content !== undefined) {
    body.content = content;
  }

  if (scheduled_at !== undefined) {
    body.scheduled_at = scheduled_at;
  }

  const response = await z.request({
    url: `https://api.relayapi.dev/v1/posts/${postId}`,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify(body),
  });

  return response.data;
};

const updatePost = {
  key: 'update_post',
  noun: 'Post',

  display: {
    label: 'Update Post',
    description: 'Update the content or schedule of an existing post.',
  },

  operation: {
    inputFields: [
      {
        key: 'postId',
        label: 'Post ID',
        type: 'string' as const,
        required: true,
        helpText: 'The ID of the post to update (e.g. post_abc123).',
      },
      {
        key: 'content',
        label: 'Content',
        type: 'text' as const,
        required: false,
        helpText: 'New text content for the post.',
      },
      {
        key: 'scheduled_at',
        label: 'Schedule',
        type: 'string' as const,
        required: false,
        helpText:
          '"now" to publish immediately, "draft" to save as draft, or an ISO 8601 timestamp.',
      },
    ],

    perform,

    sample: {
      id: 'post_abc123',
      status: 'scheduled',
      content: 'Updated content',
      created_at: '2025-01-01T00:00:00Z',
    },
  },
};

export default updatePost;
