// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import { APIPromise } from '../../../core/api-promise';
import { RequestOptions } from '../../../internal/request-options';
import { path } from '../../../internal/utils/path';

export class Reply extends APIResource {
  /**
   * Reply to a review
   */
  create(
    reviewID: string,
    body: ReplyCreateParams,
    options?: RequestOptions,
  ): APIPromise<ReplyCreateResponse> {
    return this._client.post(path`/v1/inbox/reviews/${reviewID}/reply`, { body, ...options });
  }

  /**
   * Delete a review reply
   */
  delete(reviewID: string, options?: RequestOptions): APIPromise<ReplyDeleteResponse> {
    return this._client.delete(path`/v1/inbox/reviews/${reviewID}/reply`, options);
  }
}

export interface ReplyCreateResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;
}

export interface ReplyDeleteResponse {
  /**
   * Whether the action succeeded
   */
  success: boolean;
}

export interface ReplyCreateParams {
  /**
   * Account ID
   */
  account_id: string;

  /**
   * Reply text
   */
  text: string;
}

export declare namespace Reply {
  export {
    type ReplyCreateResponse as ReplyCreateResponse,
    type ReplyDeleteResponse as ReplyDeleteResponse,
    type ReplyCreateParams as ReplyCreateParams,
  };
}
