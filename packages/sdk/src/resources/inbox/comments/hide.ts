// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import { APIPromise } from '../../../core/api-promise';
import { RequestOptions } from '../../../internal/request-options';
import { path } from '../../../internal/utils/path';

export class Hide extends APIResource {
  /**
   * Hide a comment
   */
  create(commentID: string, options?: RequestOptions): APIPromise<HideCreateResponse> {
    return this._client.post(path`/v1/inbox/comments/${commentID}/hide`, options);
  }

  /**
   * Unhide a comment
   */
  delete(commentID: string, options?: RequestOptions): APIPromise<HideDeleteResponse> {
    return this._client.delete(path`/v1/inbox/comments/${commentID}/hide`, options);
  }
}

export interface HideCreateResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;

  /**
   * Comment ID
   */
  comment_id?: string;
}

export interface HideDeleteResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;

  /**
   * Comment ID
   */
  comment_id?: string;
}

export declare namespace Hide {
  export { type HideCreateResponse as HideCreateResponse, type HideDeleteResponse as HideDeleteResponse };
}
