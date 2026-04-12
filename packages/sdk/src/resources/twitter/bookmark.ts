// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Bookmark extends APIResource {
  /**
   * Bookmark a tweet
   */
  create(body: BookmarkCreateParams, options?: RequestOptions): APIPromise<BookmarkCreateResponse> {
    return this._client.post('/v1/twitter/bookmark', { body, ...options });
  }

  /**
   * Remove a bookmark
   */
  remove(body: BookmarkRemoveParams, options?: RequestOptions): APIPromise<BookmarkRemoveResponse> {
    return this._client.delete('/v1/twitter/bookmark', { body, ...options });
  }
}

export interface BookmarkCreateResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;
}

export interface BookmarkRemoveResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;
}

export interface BookmarkCreateParams {
  /**
   * Twitter account ID
   */
  account_id: string;

  /**
   * Tweet ID to bookmark
   */
  tweet_id: string;
}

export interface BookmarkRemoveParams {
  /**
   * Twitter account ID
   */
  account_id: string;

  /**
   * Tweet ID to bookmark
   */
  tweet_id: string;
}

export declare namespace Bookmark {
  export {
    type BookmarkCreateResponse as BookmarkCreateResponse,
    type BookmarkRemoveResponse as BookmarkRemoveResponse,
    type BookmarkCreateParams as BookmarkCreateParams,
    type BookmarkRemoveParams as BookmarkRemoveParams,
  };
}
