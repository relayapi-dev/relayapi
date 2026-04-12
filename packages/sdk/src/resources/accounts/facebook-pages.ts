// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class FacebookPages extends APIResource {
  /**
   * Fetch Facebook pages for an account
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<FacebookPageRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/facebook-pages`, options);
  }

  /**
   * Set default Facebook page
   */
  setDefault(
    id: string,
    body: FacebookPageSetDefaultParams,
    options?: RequestOptions,
  ): APIPromise<FacebookPageSetDefaultResponse> {
    return this._client.put(path`/v1/accounts/${id}/facebook-pages`, { body, ...options });
  }
}

export interface FacebookPageRetrieveResponse {
  data: Array<FacebookPageRetrieveResponse.Data>;
}

export namespace FacebookPageRetrieveResponse {
  export interface Data {
    id: string;

    name: string;

    access_token?: string;
  }
}

export interface FacebookPageSetDefaultResponse {
  /**
   * Account ID
   */
  id: string;

  avatar_url: string | null;

  connected_at: string;

  display_name: string | null;

  metadata: { [key: string]: unknown } | null;

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

  platform_account_id: string;

  updated_at: string;

  username: string | null;
}

export interface FacebookPageSetDefaultParams {
  /**
   * Facebook page ID to set as default
   */
  page_id: string;
}

export declare namespace FacebookPages {
  export {
    type FacebookPageRetrieveResponse as FacebookPageRetrieveResponse,
    type FacebookPageSetDefaultResponse as FacebookPageSetDefaultResponse,
    type FacebookPageSetDefaultParams as FacebookPageSetDefaultParams,
  };
}
