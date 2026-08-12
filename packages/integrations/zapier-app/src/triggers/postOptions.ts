import type { Bundle, ZObject } from 'zapier-platform-core';
import findPost from '../searches/findPost';

const perform = async (z: ZObject, bundle: Bundle) => {
  const posts = (await findPost.operation.perform(z, bundle)) as Array<Record<string, unknown>>;

  return posts.map((post) => {
    const id = String(post.id ?? 'unknown');
    const status = String(post.status ?? 'unknown');
    const content =
      typeof post.content === 'string' && post.content.trim()
        ? post.content.trim().slice(0, 80)
        : `Post ${id}`;

    return {
      ...post,
      display_name: `${content} (${status})`,
    };
  });
};

const postOptions = {
  ...findPost,
  key: 'post_options',
  display: {
    ...findPost.display,
    label: 'Post Options',
    description: 'Lists recent posts for dynamic post pickers.',
    hidden: true,
  },
  operation: {
    ...findPost.operation,
    perform,
  },
};

export default postOptions;
