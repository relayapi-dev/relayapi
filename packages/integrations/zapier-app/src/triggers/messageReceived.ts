import type { Bundle, ZObject } from 'zapier-platform-core';
import { unsubscribeWebhook } from '../lib/webhooks';

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

const perform = (_z: ZObject, bundle: Bundle) => {
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
    performUnsubscribe: unsubscribeWebhook,
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
