import findAccount from '../searches/findAccount';

const accountOptions = {
  ...findAccount,
  key: 'account_options',
  display: {
    ...findAccount.display,
    label: 'Account Options',
    description: 'Lists connected accounts for dynamic account pickers.',
    hidden: true,
  },
};

export default accountOptions;
