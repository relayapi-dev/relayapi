// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource';
import { APIPromise } from '../../core/api-promise';
import { RequestOptions } from '../../internal/request-options';
import { path } from '../../internal/utils/path';

export class GmbLocations extends APIResource {
  /**
   * Fetch Google My Business locations
   */
  retrieve(id: string, options?: RequestOptions): APIPromise<GmbLocationRetrieveResponse> {
    return this._client.get(path`/v1/accounts/${id}/gmb-locations`, options);
  }

  /**
   * Set default GMB location
   */
  setDefault(
    id: string,
    body: GmbLocationSetDefaultParams,
    options?: RequestOptions,
  ): APIPromise<GmbLocationSetDefaultResponse> {
    return this._client.put(path`/v1/accounts/${id}/gmb-locations`, { body, ...options });
  }
}

export interface GmbLocationRetrieveResponse {
  data: Array<GmbLocationRetrieveResponse.Data>;
}

export namespace GmbLocationRetrieveResponse {
  export interface Data {
    id: string;

    address: string | null;

    name: string;
  }
}

export interface GmbLocationSetDefaultResponse {
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

export interface GmbLocationSetDefaultParams {
  /**
   * Google My Business location ID to set as default
   */
  location_id: string;
}

export declare namespace GmbLocations {
  export {
    type GmbLocationRetrieveResponse as GmbLocationRetrieveResponse,
    type GmbLocationSetDefaultResponse as GmbLocationSetDefaultResponse,
    type GmbLocationSetDefaultParams as GmbLocationSetDefaultParams,
  };
}
