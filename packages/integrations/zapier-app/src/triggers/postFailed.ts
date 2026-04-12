import { Bundle, ZObject } from 'zapier-platform-core';

const performSubscribe = async (z: ZObject, bundle: Bundle) => {
  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/webhooks',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify({
      url: bundle.targetUrl,
      events: ['post.failed'],
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
      status: 'failed',
      limit: '5',
    },
  });

  return (response.data as { data: unknown[] }).data || [];
};

const postFailed = {
  key: 'post_failed',
  noun: 'Post',

  display: {
    label: 'Post Failed',
    description: 'Triggers when a post fails to publish.',
  },

  operation: {
    type: 'hook' as const,

    performSubscribe,
    performUnsubscribe,
    perform,
    performList,

    sample: {
      id: 'post_abc123',
      status: 'failed',
      content: 'Hello from RelayAPI!',
      platform: 'twitter',
      error: 'Rate limit exceeded',
      created_at: '2025-01-01T00:00:00Z',
    },
  },
};

export default postFailed;
