import { Bundle, ZObject } from 'zapier-platform-core';

const performSubscribe = async (z: ZObject, bundle: Bundle) => {
  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/webhooks',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify({
      url: bundle.targetUrl,
      events: ['post.recycled'],
    }),
  });

  return response.data;
};

const performUnsubscribe = async (z: ZObject, bundle: Bundle) => {
  const response = await z.request({
    url: `https://api.relayapi.dev/v1/webhooks/${bundle.subscribeData?.id}`,
    method: 'DELETE',
  });

  return response.data;
};

const perform = (z: ZObject, bundle: Bundle) => {
  return [bundle.cleanedRequest];
};

const performList = async (z: ZObject, bundle: Bundle) => {
  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/posts',
    method: 'GET',
    params: {
      status: 'published',
      limit: '5',
    },
  });

  return (response.data as { data: unknown[] }).data || [];
};

const postRecycled = {
  key: 'post_recycled',
  noun: 'Post',

  display: {
    label: 'Post Recycled',
    description: 'Triggers when a post is automatically recycled (evergreen content republished).',
  },

  operation: {
    type: 'hook' as const,

    performSubscribe,
    performUnsubscribe,
    perform,
    performList,

    sample: {
      source_post_id: 'post_abc123',
      recycled_post_id: 'post_def456',
      recycle_count: 3,
      content_variation_used: 1,
      next_recycle_at: '2025-07-01T10:00:00Z',
      remaining_cycles: 7,
    },
  },
};

export default postRecycled;
