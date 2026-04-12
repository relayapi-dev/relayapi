import { Bundle, ZObject } from 'zapier-platform-core';

const perform = async (z: ZObject, bundle: Bundle) => {
  const { postId } = bundle.inputData;

  const response = await z.request({
    url: `https://api.relayapi.dev/v1/posts/${postId}`,
    method: 'DELETE',
  });

  return response.data;
};

const deletePost = {
  key: 'delete_post',
  noun: 'Post',

  display: {
    label: 'Delete Post',
    description: 'Delete an existing post.',
  },

  operation: {
    inputFields: [
      {
        key: 'postId',
        label: 'Post ID',
        type: 'string' as const,
        required: true,
        helpText: 'The ID of the post to delete (e.g. post_abc123).',
      },
    ],

    perform,

    sample: {
      id: 'post_abc123',
      deleted: true,
    },
  },
};

export default deletePost;
