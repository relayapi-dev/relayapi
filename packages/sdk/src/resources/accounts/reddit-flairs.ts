// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class RedditFlairs extends APIResource {
  /**
   * Fetch Reddit flairs for a subreddit
   */
  retrieve(
    id: string,
    query: RedditFlairRetrieveParams,
    options?: RequestOptions,
  ): APIPromise<RedditFlairRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/reddit-flairs`, { query, ...options });
  }
}

export interface RedditFlairRetrieveResponse {
  data: Array<RedditFlairRetrieveResponse.Data>;
}

export namespace RedditFlairRetrieveResponse {
  export interface Data {
    id: string;

    text: string;
  }
}

export interface RedditFlairRetrieveParams {
  /**
   * Subreddit name
   */
  subreddit: string;
}

export declare namespace RedditFlairs {
  export {
    type RedditFlairRetrieveResponse as RedditFlairRetrieveResponse,
    type RedditFlairRetrieveParams as RedditFlairRetrieveParams,
  };
}
