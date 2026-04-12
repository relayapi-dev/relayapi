// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import { APIPromise } from '../../../core/api-promise';
import { RequestOptions } from '../../../internal/request-options';
import { path } from '../../../internal/utils/path';

export class Like extends APIResource {
  /**
   * Like a comment
   */
  create(commentID: string, options?: RequestOptions): APIPromise<LikeCreateResponse> {
    return this._client.post(path`/v1/inbox/comments/${commentID}/like`, options);
  }

  /**
   * Unlike a comment
   */
  delete(commentID: string, options?: RequestOptions): APIPromise<LikeDeleteResponse> {
    return this._client.delete(path`/v1/inbox/comments/${commentID}/like`, options);
  }
}

export interface LikeCreateResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;

  /**
   * Comment ID
   */
  comment_id?: string;
}

export interface LikeDeleteResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;

  /**
   * Comment ID
   */
  comment_id?: string;
}

export declare namespace Like {
  export { type LikeCreateResponse as LikeCreateResponse, type LikeDeleteResponse as LikeDeleteResponse };
}
