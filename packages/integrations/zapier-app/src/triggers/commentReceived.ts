import { Bundle, ZObject } from 'zapier-platform-core';

const performSubscribe = async (z: ZObject, bundle: Bundle) => {
  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/webhooks',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify({
      url: bundle.targetUrl,
      events: ['comment.received'],
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

const performList = async (_z: ZObject, _bundle: Bundle) => {
  // No polling fallback for comments — webhook-only
  return [];
};

const commentReceived = {
  key: 'comment_received',
  noun: 'Comment',

  display: {
    label: 'Comment Received',
    description: 'Triggers when a new comment is received on one of your posts.',
  },

  operation: {
    type: 'hook' as const,

    performSubscribe,
    performUnsubscribe,
    perform,
    performList,

    sample: {
      id: 'cmt_abc123',
      post_id: 'post_abc123',
      platform: 'instagram',
      author: 'user123',
      text: 'Great post!',
      created_at: '2025-01-01T00:00:00Z',
    },
  },
};

export default commentReceived;
