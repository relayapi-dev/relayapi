// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../core/resource';
import { APIPromise } from '../core/api-promise';
import { RequestOptions } from '../internal/request-options';

export class Reddit extends APIResource {
  /**
   * Get subreddit feed
   */
  getFeed(query: RedditGetFeedParams, options?: RequestOptions): APIPromise<RedditGetFeedResponse> {
    return this._client.get('/v1/reddit/feed', { query, ...options });
  }

  /**
   * Search Reddit posts
   */
  search(query: RedditSearchParams, options?: RequestOptions): APIPromise<RedditSearchResponse> {
    return this._client.get('/v1/reddit/search', { query, ...options });
  }
}

export interface RedditGetFeedResponse {
  data: Array<RedditGetFeedResponse.Data>;

  has_more: boolean;

  next_cursor: string | null;
}

export namespace RedditGetFeedResponse {
  export interface Data {
    /**
     * Reddit post ID
     */
    id: string;

    /**
     * Post author
     */
    author: string;

    /**
     * Created timestamp (Unix)
     */
    created_utc: number;

    /**
     * Whether it's a self post
     */
    is_self: boolean;

    /**
     * Whether NSFW
     */
    nsfw: boolean;

    /**
     * Comment count
     */
    num_comments: number;

    /**
     * Post score
     */
    score: number;

    /**
     * Subreddit name
     */
    subreddit: string;

    /**
     * Post title
     */
    title: string;

    /**
     * Post URL
     */
    url: string;

    /**
     * Self text
     */
    selftext?: string | null;

    /**
     * Thumbnail URL
     */
    thumbnail?: string | null;
  }
}

export interface RedditSearchResponse {
  data: Array<RedditSearchResponse.Data>;

  has_more: boolean;

  next_cursor: string | null;
}

export namespace RedditSearchResponse {
  export interface Data {
    /**
     * Reddit post ID
     */
    id: string;

    /**
     * Post author
     */
    author: string;

    /**
     * Created timestamp (Unix)
     */
    created_utc: number;

    /**
     * Whether it's a self post
     */
    is_self: boolean;

    /**
     * Whether NSFW
     */
    nsfw: boolean;

    /**
     * Comment count
     */
    num_comments: number;

    /**
     * Post score
     */
    score: number;

    /**
     * Subreddit name
     */
    subreddit: string;

    /**
     * Post title
     */
    title: string;

    /**
     * Post URL
     */
    url: string;

    /**
     * Self text
     */
    selftext?: string | null;

    /**
     * Thumbnail URL
     */
    thumbnail?: string | null;
  }
}

export interface RedditGetFeedParams {
  /**
   * Reddit account ID
   */
  account_id: string;

  /**
   * Subreddit name
   */
  subreddit: string;

  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items per page
   */
  limit?: number;

  /**
   * Sort order
   */
  sort?: 'hot' | 'new' | 'top' | 'rising';

  /**
   * Time filter (for top sort)
   */
  time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
}

export interface RedditSearchParams {
  /**
   * Reddit account ID
   */
  account_id: string;

  /**
   * Search query
   */
  query: string;

  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items per page
   */
  limit?: number;

  /**
   * Sort order
   */
  sort?: 'relevance' | 'hot' | 'top' | 'new' | 'comments';

  /**
   * Limit to subreddit
   */
  subreddit?: string;

  /**
   * Time filter
   */
  time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
}

export declare namespace Reddit {
  export {
    type RedditGetFeedResponse as RedditGetFeedResponse,
    type RedditSearchResponse as RedditSearchResponse,
    type RedditGetFeedParams as RedditGetFeedParams,
    type RedditSearchParams as RedditSearchParams,
  };
}
