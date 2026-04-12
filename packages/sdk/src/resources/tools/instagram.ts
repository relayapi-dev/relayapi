// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';

export class Instagram extends APIResource {
  /**
   * Check Instagram hashtag safety status
   *
   * @example
   * ```ts
   * const response =
   *   await client.tools.instagram.checkHashtagSafety({
   *     hashtags: ['string'],
   *   });
   * ```
   */
  checkHashtagSafety(
    body: InstagramCheckHashtagSafetyParams,
    options?: RequestOptions,
  ): APIPromise<InstagramCheckHashtagSafetyResponse> {
    return this._client.post('/v1/tools/instagram/hashtag-checker', { body, ...options });
  }
}

export interface InstagramCheckHashtagSafetyResponse {
  results: Array<InstagramCheckHashtagSafetyResponse.Result>;
}

export namespace InstagramCheckHashtagSafetyResponse {
  export interface Result {
    /**
     * Hashtag checked
     */
    hashtag: string;

    /**
     * Hashtag safety status
     */
    status: 'safe' | 'restricted' | 'banned';
  }
}

export interface InstagramCheckHashtagSafetyParams {
  /**
   * Hashtags to check (without # prefix)
   */
  hashtags: Array<string>;
}

export declare namespace Instagram {
  export {
    type InstagramCheckHashtagSafetyResponse as InstagramCheckHashtagSafetyResponse,
    type InstagramCheckHashtagSafetyParams as InstagramCheckHashtagSafetyParams,
  };
}
