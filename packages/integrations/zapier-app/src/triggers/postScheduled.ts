import { Bundle, ZObject } from 'zapier-platform-core';

const performSubscribe = async (z: ZObject, bundle: Bundle) => {
  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/webhooks',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify({
      url: bundle.targetUrl,
      events: ['post.scheduled'],
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
      status: 'scheduled',
      limit: '5',
    },
  });

  return (response.data as { data: unknown[] }).data || [];
};

const postScheduled = {
  key: 'post_scheduled',
  noun: 'Post',

  display: {
    label: 'Post Scheduled',
    description: 'Triggers when a post is scheduled for future publishing.',
  },

  operation: {
    type: 'hook' as const,

    performSubscribe,
    performUnsubscribe,
    perform,
    performList,

    sample: {
      id: 'post_abc123',
      status: 'scheduled',
      content: 'Scheduled post from RelayAPI!',
      platform: 'twitter',
      scheduled_at: '2025-06-15T14:00:00Z',
      created_at: '2025-01-01T00:00:00Z',
    },
  },
};

export default postScheduled;
