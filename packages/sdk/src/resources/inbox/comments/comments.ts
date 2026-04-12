// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import * as HideAPI from './hide';
import { Hide, HideCreateResponse, HideDeleteResponse } from './hide';
import * as LikeAPI from './like';
import { Like, LikeCreateResponse, LikeDeleteResponse } from './like';
import { APIPromise } from '../../../core/api-promise';
import { RequestOptions } from '../../../internal/request-options';
import { path } from '../../../internal/utils/path';

export class Comments extends APIResource {
  hide: HideAPI.Hide = new HideAPI.Hide(this._client);
  like: LikeAPI.Like = new LikeAPI.Like(this._client);

  /**
   * Get comments for a specific post
   */
  retrieve(
    postID: string,
    query: CommentRetrieveParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<CommentRetrieveResponse> {
    return this._client.get(path`/v1/inbox/comments/${postID}`, { query, ...options });
  }

  /**
   * List comments across platforms
   */
  list(
    query: CommentListParams | null | undefined = {},
    options?: RequestOptions,
  ): APIPromise<CommentListResponse> {
    return this._client.get('/v1/inbox/comments', { query, ...options });
  }

  /**
   * Delete a comment
   */
  delete(commentID: string, options?: RequestOptions): APIPromise<CommentDeleteResponse> {
    return this._client.delete(path`/v1/inbox/comments/${commentID}`, options);
  }

  /**
   * Send a private reply to a commenter
   */
  privateReply(
    commentID: string,
    body: CommentPrivateReplyParams,
    options?: RequestOptions,
  ): APIPromise<CommentPrivateReplyResponse> {
    return this._client.post(path`/v1/inbox/comments/${commentID}/private-reply`, { body, ...options });
  }

  /**
   * Reply to a comment
   */
  reply(
    postID: string,
    body: CommentReplyParams,
    options?: RequestOptions,
  ): APIPromise<CommentReplyResponse> {
    return this._client.post(path`/v1/inbox/comments/${postID}/reply`, { body, ...options });
  }
}

export interface CommentRetrieveResponse {
  data: Array<CommentRetrieveResponse.Data>;

  has_more?: boolean;

  next_cursor?: string | null;

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

  /**
   * Post ID if filtered by post
   */
  post_id?: string;
}

export namespace CommentRetrieveResponse {
  export interface Data {
    /**
     * Comment ID
     */
    id: string;

    /**
     * Comment author name
     */
    author_name: string;

    /**
     * Comment timestamp
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
     * Comment text
     */
    text: string;

    /**
     * Author avatar URL
     */
    author_avatar?: string | null;

    /**
     * Whether comment is hidden
     */
    hidden?: boolean;

    /**
     * Like count
     */
    likes?: number;

    /**
     * Reply count
     */
    replies_count?: number;
  }
}

export interface CommentListResponse {
  data: Array<CommentListResponse.Data>;

  has_more?: boolean;

  next_cursor?: string | null;

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

  /**
   * Post ID if filtered by post
   */
  post_id?: string;
}

export namespace CommentListResponse {
  export interface Data {
    /**
     * Comment ID
     */
    id: string;

    /**
     * Comment author name
     */
    author_name: string;

    /**
     * Comment timestamp
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
     * Comment text
     */
    text: string;

    /**
     * Social account ID
     */
    account_id?: string;

    /**
     * Social account avatar URL
     */
    account_avatar_url?: string | null;

    /**
     * Author avatar URL
     */
    author_avatar?: string | null;

    /**
     * Whether comment is hidden
     */
    hidden?: boolean;

    /**
     * Like count
     */
    likes?: number;

    /**
     * Parent comment ID if this is a reply
     */
    parent_id?: string | null;

    /**
     * Platform post/media/video ID
     */
    post_id?: string;

    /**
     * Post caption snippet
     */
    post_text?: string | null;

    /**
     * Post thumbnail URL
     */
    post_thumbnail_url?: string | null;

    /**
     * URL to the post on the platform
     */
    post_platform_url?: string | null;

    /**
     * Reply count
     */
    replies_count?: number;
  }
}

export interface CommentDeleteResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;

  /**
   * Comment ID
   */
  comment_id?: string;
}

export interface CommentPrivateReplyResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;

  /**
   * Comment ID
   */
  comment_id?: string;
}

export interface CommentReplyResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;

  /**
   * Comment ID
   */
  comment_id?: string;
}

export interface CommentRetrieveParams {
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

export interface CommentListParams {
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

export interface CommentPrivateReplyParams {
  /**
   * Account ID to reply from
   */
  account_id: string;

  /**
   * Private reply text
   */
  text: string;
}

export interface CommentReplyParams {
  /**
   * Account ID to reply from
   */
  account_id: string;

  /**
   * Reply text
   */
  text: string;

  /**
   * Parent comment ID for threaded replies
   */
  comment_id?: string;
}

Comments.Hide = Hide;
Comments.Like = Like;

export declare namespace Comments {
  export {
    type CommentRetrieveResponse as CommentRetrieveResponse,
    type CommentListResponse as CommentListResponse,
    type CommentDeleteResponse as CommentDeleteResponse,
    type CommentPrivateReplyResponse as CommentPrivateReplyResponse,
    type CommentReplyResponse as CommentReplyResponse,
    type CommentRetrieveParams as CommentRetrieveParams,
    type CommentListParams as CommentListParams,
    type CommentPrivateReplyParams as CommentPrivateReplyParams,
    type CommentReplyParams as CommentReplyParams,
  };

  export {
    Hide as Hide,
    type HideCreateResponse as HideCreateResponse,
    type HideDeleteResponse as HideDeleteResponse,
  };

  export {
    Like as Like,
    type LikeCreateResponse as LikeCreateResponse,
    type LikeDeleteResponse as LikeDeleteResponse,
  };
}
