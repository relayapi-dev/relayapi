import { Bundle, ZObject } from 'zapier-platform-core';

const performSubscribe = async (z: ZObject, bundle: Bundle) => {
  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/webhooks',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify({
      url: bundle.targetUrl,
      events: ['post.published'],
    }),
  });

  return response.data;
};

const performUnsubscribe = async (z: ZObject, bundle: Bundle) => {
  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/webhooks',
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify({
      id: bundle.subscribeData?.id,
    }),
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

const postPublished = {
  key: 'post_published',
  noun: 'Post',

  display: {
    label: 'Post Published',
    description: 'Triggers when a post is successfully published to a platform.',
    important: true,
  },

  operation: {
    type: 'hook' as const,

    performSubscribe,
    performUnsubscribe,
    perform,
    performList,

    sample: {
      id: 'post_abc123',
      status: 'published',
      content: 'Hello from RelayAPI!',
      platform: 'twitter',
      created_at: '2025-01-01T00:00:00Z',
    },
  },
};

export default postPublished;
