import authentication from './authentication';
import createPost from './creates/createPost';
import updatePost from './creates/updatePost';
import deletePost from './creates/deletePost';
import uploadMedia from './creates/uploadMedia';
import postPublished from './triggers/postPublished';
import postFailed from './triggers/postFailed';
import postRecycled from './triggers/postRecycled';
import postScheduled from './triggers/postScheduled';
import commentReceived from './triggers/commentReceived';
import messageReceived from './triggers/messageReceived';
import findAccount from './searches/findAccount';
import findPost from './searches/findPost';
import { addAuthHeader, handleErrors } from './lib/requestHelper';

const App = {
  version: require('../package.json').version,
  platformVersion: require('zapier-platform-core').version,

  authentication,

  beforeRequest: [addAuthHeader],
  afterResponse: [handleErrors],

  triggers: {
    [postPublished.key]: postPublished,
    [postFailed.key]: postFailed,
    [postRecycled.key]: postRecycled,
    [postScheduled.key]: postScheduled,
    [commentReceived.key]: commentReceived,
    [messageReceived.key]: messageReceived,
  },

  creates: {
    [createPost.key]: createPost,
    [updatePost.key]: updatePost,
    [deletePost.key]: deletePost,
    [uploadMedia.key]: uploadMedia,
  },

  searches: {
    [findAccount.key]: findAccount,
    [findPost.key]: findPost,
  },
};

export default App;
module.exports = App;
