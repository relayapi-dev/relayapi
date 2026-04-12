import { Bundle, ZObject } from 'zapier-platform-core';

interface Account {
  id: string;
  platform: string;
  display_name?: string;
  username?: string;
  [key: string]: unknown;
}

const perform = async (z: ZObject, bundle: Bundle) => {
  const params: Record<string, string> = {};

  if (bundle.inputData.platform) {
    params.platform = bundle.inputData.platform;
  }

  const response = await z.request({
    url: 'https://api.relayapi.dev/v1/accounts',
    method: 'GET',
    params,
  });

  const accounts: Account[] =
    (response.data as { data: Account[] }).data || (response.data as Account[]);

  return accounts.map((acc) => ({
    ...acc,
    display_name: `${acc.display_name || acc.username || acc.id} (${acc.platform})`,
  }));
};

const findAccount = {
  key: 'find_account',
  noun: 'Account',

  display: {
    label: 'Find Account',
    description: 'Find a connected social media account.',
    hidden: false,
  },

  operation: {
    inputFields: [
      {
        key: 'platform',
        label: 'Platform',
        type: 'string' as const,
        required: false,
        helpText: 'Filter accounts by platform.',
        choices: {
          twitter: 'Twitter / X',
          instagram: 'Instagram',
          facebook: 'Facebook',
          linkedin: 'LinkedIn',
          tiktok: 'TikTok',
          youtube: 'YouTube',
          pinterest: 'Pinterest',
          reddit: 'Reddit',
          bluesky: 'Bluesky',
          threads: 'Threads',
          telegram: 'Telegram',
          snapchat: 'Snapchat',
          googlebusiness: 'Google Business',
          whatsapp: 'WhatsApp',
          mastodon: 'Mastodon',
          discord: 'Discord',
          sms: 'SMS',
        },
      },
    ],

    perform,

    sample: {
      id: 'acc_abc123',
      platform: 'twitter',
      display_name: 'My Twitter (twitter)',
      username: 'myhandle',
    },
  },
};

export default findAccount;
