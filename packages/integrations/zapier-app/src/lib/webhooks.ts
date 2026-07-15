import type { Bundle, ZObject } from 'zapier-platform-core';

/** Delete the exact webhook created by Zapier's subscribe hook. */
export const unsubscribeWebhook = async (z: ZObject, bundle: Bundle) => {
  const webhookId = bundle.subscribeData?.id;
  if (!webhookId) {
    throw new z.errors.Error(
      'Zapier did not provide the RelayAPI webhook ID to unsubscribe.',
      'MissingWebhookId',
    );
  }

  const response = await z.request({
    url: `https://api.relayapi.dev/v1/webhooks/${encodeURIComponent(webhookId)}`,
    method: 'DELETE',
  });

  return response.data;
};
