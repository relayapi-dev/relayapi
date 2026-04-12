import { Bundle, ZObject } from 'zapier-platform-core';

const test = async (z: ZObject, bundle: Bundle) => {
  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/usage',
    method: 'GET',
  });

  return response.data;
};

const authentication = {
  type: 'custom' as const,
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password' as const,
      required: true,
      helpText:
        'Your RelayAPI key. Find it in [your dashboard](https://app.relayapi.dev/settings/api-keys).',
      placeholder: 'rlay_live_...',
    },
  ],
  test,
  connectionLabel: (z: ZObject, bundle: Bundle) => {
    return `RelayAPI (${(bundle.inputData as Record<string, string>).plan || 'connected'})`;
  },
};

export default authentication;
