// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import { APIPromise } from '../../../core/api-promise';
import { RequestOptions } from '../../../internal/request-options';

export class Pages extends APIResource {
  /**
   * List Facebook Pages after OAuth
   */
  list(options?: RequestOptions): APIPromise<PageListResponse> {
    return this._client.get('/v1/connect/facebook/pages', options);
  }

  /**
   * Select Facebook Page to connect
   */
  select(body: PageSelectParams, options?: RequestOptions): APIPromise<PageSelectResponse> {
    return this._client.post('/v1/connect/facebook/pages', { body, ...options });
  }
}

export interface PageListResponse {
  pages: Array<PageListResponse.Page>;
}

export namespace PageListResponse {
  export interface Page {
    /**
     * Facebook page ID
     */
    id: string;

    /**
     * Page name
     */
    name: string;

    /**
     * Page category
     */
    category?: string | null;

    /**
     * Page profile picture URL
     */
    picture_url?: string | null;
  }
}

export interface PageSelectResponse {
  account: PageSelectResponse.Account;
}

export namespace PageSelectResponse {
  export interface Account {
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
}

export interface PageSelectParams {
  /**
   * Token from pending data or OAuth flow
   */
  connect_token: string;

  /**
   * Selected Facebook page ID
   */
  page_id: string;
}

export declare namespace Pages {
  export {
    type PageListResponse as PageListResponse,
    type PageSelectResponse as PageSelectResponse,
    type PageSelectParams as PageSelectParams,
  };
}
