// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as ReplyAPI from './reply';
import { Reply, ReplyCreateParams, ReplyCreateResponse, ReplyDeleteResponse } from './reply';
import { APIPromise } from '../../../core/api-promise';
import { RequestOptions } from '../../../internal/request-options';

export class Reviews extends APIResource {
  reply: ReplyAPI.Reply = new ReplyAPI.Reply(this._client);

  /**
   * List reviews across platforms
   */
  list(
    query: ReviewListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<ReviewListResponse> {
    return this._client.get('/v1/inbox/reviews', { query, ...options });
  }
}

export interface ReviewListResponse {
  data: Array<ReviewListResponse.Data>;

  /**
   * Whether more items exist
   */
  has_more: boolean;

  /**
   * Cursor for next page
   */
  next_cursor: string | null;
}

export namespace ReviewListResponse {
  export interface Data {
    /**
     * Review ID
     */
    id: string;

    /**
     * Review author name
     */
    author_name: string;

    /**
     * Review timestamp
     */
    created_at: string;

    platform:
      | 'twitter'
      | 'instagram'
      | 'facebook'
      | 'linkedin'
      | 'tiktok'
      | 'youtube'
      | 'pinterest'
      | 'reddit'
      | 'bluesky'
      | 'threads'
      | 'telegram'
      | 'snapchat'
      | 'googlebusiness'
      | 'whatsapp'
      | 'mastodon'
      | 'discord'
      | 'sms';

    /**
     * Rating (1-5)
     */
    rating: number;

    /**
     * Business reply text
     */
    reply?: string | null;

    /**
     * Review text
     */
    text?: string | null;
  }
}

export interface ReviewListParams {
  /**
   * Filter by account ID
   */
  account_id?: string;

  /**
   * Pagination cursor
   */
  cursor?: string;

  /**
   * Number of items
   */
  limit?: number;

  max_rating?: number;

  min_rating?: number;

  /**
   * Filter by platform
   */
  platform?:
    | 'twitter'
    | 'instagram'
    | 'facebook'
    | 'linkedin'
    | 'tiktok'
    | 'youtube'
    | 'pinterest'
    | 'reddit'
    | 'bluesky'
    | 'threads'
    | 'telegram'
    | 'snapchat'
    | 'googlebusiness'
    | 'whatsapp'
    | 'mastodon'
    | 'discord'
    | 'sms';
}

Reviews.Reply = Reply;

export declare namespace Reviews {
  export { type ReviewListResponse as ReviewListResponse, type ReviewListParams as ReviewListParams };

  export {
    Reply as Reply,
    type ReplyCreateResponse as ReplyCreateResponse,
    type ReplyDeleteResponse as ReplyDeleteResponse,
    type ReplyCreateParams as ReplyCreateParams,
  };
}
