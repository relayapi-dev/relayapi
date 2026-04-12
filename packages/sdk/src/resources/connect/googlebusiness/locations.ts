// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import { APIPromise } from '../../../core/api-promise';
import { RequestOptions } from '../../../internal/request-options';

export class Locations extends APIResource {
  /**
   * List Google Business locations after OAuth
   */
  list(options?: RequestOptions): APIPromise<LocationListResponse> {
    return this._client.get('/v1/connect/googlebusiness/locations', options);
  }

  /**
   * Select Google Business location
   */
  select(body: LocationSelectParams, options?: RequestOptions): APIPromise<LocationSelectResponse> {
    return this._client.post('/v1/connect/googlebusiness/locations', { body, ...options });
  }
}

export interface LocationListResponse {
  locations: Array<LocationListResponse.Location>;
}

export namespace LocationListResponse {
  export interface Location {
    /**
     * Google Business location ID
     */
    id: string;

    /**
     * Business name
     */
    name: string;

    /**
     * Business address
     */
    address?: string | null;

    /**
     * Business phone number
     */
    phone?: string | null;
  }
}

export interface LocationSelectResponse {
  account: LocationSelectResponse.Account;
}

export namespace LocationSelectResponse {
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

export interface LocationSelectParams {
  /**
   * Token from pending data or OAuth flow
   */
  connect_token: string;

  /**
   * Selected Google Business location ID
   */
  location_id: string;
}

export declare namespace Locations {
  export {
    type LocationListResponse as LocationListResponse,
    type LocationSelectResponse as LocationSelectResponse,
    type LocationSelectParams as LocationSelectParams,
  };
}
