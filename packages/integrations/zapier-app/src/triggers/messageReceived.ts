import { Bundle, ZObject } from 'zapier-platform-core';

const performSubscribe = async (z: ZObject, bundle: Bundle) => {
  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/webhooks',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: z.JSON.stringify({
      url: bundle.targetUrl,
      events: ['message.received'],
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
  // No polling fallback for messages — webhook-only
  return [];
};

const messageReceived = {
  key: 'message_received',
  noun: 'Message',

  display: {
    label: 'Message Received',
    description: 'Triggers when a new direct message is received.',
  },

  operation: {
    type: 'hook' as const,

    performSubscribe,
    performUnsubscribe,
    perform,
    performList,

    sample: {
      id: 'msg_abc123',
      platform: 'instagram',
      from: 'user123',
      text: 'Hey there!',
      created_at: '2025-01-01T00:00:00Z',
    },
  },
};

export default messageReceived;
