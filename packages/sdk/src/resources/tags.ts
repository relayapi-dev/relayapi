import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { buildHeaders } from '../internal/headers';
import { RequestOptions } from '../internal/request-options';
import { path } from '../internal/utils/path';

export class Tags extends APIResource {
  /**
   * Create a tag
   */
  create(body: TagCreateParams, options?: RequestOptions): APIPromise<TagCreateResponse> {
    return this._client.post('/v1/tags', { body, ...options });
  }

  /**
   * Update a tag
   */
  update(
    id: string,
    body: TagUpdateParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<TagUpdateResponse> {
    return this._client.patch(path`/v1/tags/${id}`, { body, ...options });
  }

  /**
   * List tags
   */
  list(
    query: TagListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<TagListResponse> {
    return this._client.get('/v1/tags', { query, ...options });
  }

  /**
   * Delete a tag
   */
  delete(id: string, options?: RequestOptions): APIPromise<void> {
    return this._client.delete(path`/v1/tags/${id}`, {
      ...options,
      headers: buildHeaders([{ Accept: '*/*' }, options?.headers]),
    });
  }
}

export interface TagResponse {
  id: string;
  name: string;
  color: string;
  workspace_id: string | null;
  created_at: string;
}

export type TagCreateResponse = TagResponse;
export type TagUpdateResponse = TagResponse;

export interface TagListResponse {
  data: Array<TagResponse>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface TagCreateParams {
  name: string;
  color: string;
  workspace_id?: string;
}

export interface TagUpdateParams {
  name?: string;
  color?: string;
}

export interface TagListParams {
  cursor?: string;
  limit?: number;
  workspace_id?: string;
}

export declare namespace Tags {
  export {
    type TagResponse as TagResponse,
    type TagCreateResponse as TagCreateResponse,
    type TagUpdateResponse as TagUpdateResponse,
    type TagListResponse as TagListResponse,
    type TagCreateParams as TagCreateParams,
    type TagUpdateParams as TagUpdateParams,
    type TagListParams as TagListParams,
  };
}
