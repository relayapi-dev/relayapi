import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { buildHeaders } from '../../internal/headers';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';
import type { TagResponse } from '../tags';

export class PostTags extends APIResource {
  list(
    postID: string,
    query: PostTagListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<PostTagListResponse> {
    return this._client.get(path`/v1/posts/${postID}/tags`, { query, ...options });
  }

  attach(postID: string, tagID: string, options?: RequestOptions): APIPromise<TagResponse> {
    return this._client.put(path`/v1/posts/${postID}/tags/${tagID}`, { ...options });
  }

  detach(postID: string, tagID: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/posts/${postID}/tags/${tagID}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface PostTagListParams {
  cursor?: string;
  limit?: number;
}

export interface PostTagListResponse {
  data: TagResponse[];
  next_cursor: string | null;
  has_more: boolean;
}
