// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class PinterestBoards extends APIResource {
  /**
   * Fetch Pinterest boards for an account
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<PinterestBoardRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/pinterest-boards`, options);
  }

  /**
   * Set default Pinterest board
   */
  setDefault(
    id: string,
    body: PinterestBoardSetDefaultParams,
    options?: RequestOptions,
  ): APIPromise<PinterestBoardSetDefaultResponse> {
    return this._client.put(path`/v1/accounts/${id}/pinterest-boards`, { body, ...options });
  }
}

export interface PinterestBoardRetrieveResponse {
  data: Array<PinterestBoardRetrieveResponse.Data>;
}

export namespace PinterestBoardRetrieveResponse {
  export interface Data {
    id: string;

    name: string;

    url: string | null;
  }
}

export interface PinterestBoardSetDefaultResponse {
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

export interface PinterestBoardSetDefaultParams {
  /**
   * Pinterest board ID to set as default
   */
  board_id: string;
}

export declare namespace PinterestBoards {
  export {
    type PinterestBoardRetrieveResponse as PinterestBoardRetrieveResponse,
    type PinterestBoardSetDefaultResponse as PinterestBoardSetDefaultResponse,
    type PinterestBoardSetDefaultParams as PinterestBoardSetDefaultParams,
  };
}
