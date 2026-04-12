// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class Logs extends APIResource {
  /**
   * Get publishing logs for a post
   *
   * @example
   * ```ts
   * const log = await client.posts.logs.retrieve('id');
   * ```
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<LogRetrieveResponse> {
    return this._client.get(path`/v1/posts/${id}/logs`, options);
  }

  /**
   * Query publishing logs across all posts with pagination.
   *
   * @example
   * ```ts
   * const logs = await client.posts.logs.list();
   * ```
   */
  list(query: LogListParams | null | undefined = {}, options?: RequestOptions): APIPromise<LogListResponse> {
    return this._client.get('/v1/posts/logs', { query, ...options });
  }
}

export interface LogRetrieveResponse {
  data: Array<LogRetrieveResponse.Data>;

  has_more: boolean;

  next_cursor: string | null;
}

export namespace LogRetrieveResponse {
  export interface Data {
    /**
     * Log entry ID (post target ID)
     */
    id: string;

    /**
     * Error message if failed
     */
    error: string | null;

    /**
     * Platform name
     */
    platform: string;

    /**
     * Platform post ID
     */
    platform_post_id: string | null;

    /**
     * Published URL
     */
    platform_url: string | null;

    /**
     * Post ID
     */
    post_id: string;

    /**
     * Published timestamp
     */
    published_at: string | null;

    /**
     * Social account ID
     */
    social_account_id: string;

    /**
     * Target status
     */
    status: string;

    /**
     * Last updated
     */
    updated_at: string;
  }
}

export interface LogListResponse {
  data: Array<LogListResponse.Data>;

  has_more: boolean;

  next_cursor: string | null;
}

export namespace LogListResponse {
  export interface Data {
    /**
     * Log entry ID (post target ID)
     */
    id: string;

    /**
     * Error message if failed
     */
    error: string | null;

    /**
     * Platform name
     */
    platform: string;

    /**
     * Platform post ID
     */
    platform_post_id: string | null;

    /**
     * Published URL
     */
    platform_url: string | null;

    /**
     * Post ID
     */
    post_id: string;

    /**
     * Published timestamp
     */
    published_at: string | null;

    /**
     * Social account ID
     */
    social_account_id: string;

    /**
     * Target status
     */
    status: string;

    /**
     * Last updated
     */
    updated_at: string;
  }
}

export interface LogListParams {
  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items per page
   */
  limit?: number;
}

export declare namespace Logs {
  export {
    type LogRetrieveResponse as LogRetrieveResponse,
    type LogListResponse as LogListResponse,
    type LogListParams as LogListParams,
  };
}
