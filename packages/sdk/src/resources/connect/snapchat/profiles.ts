// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import { APIPromise } from '../../../core/api-promise';
import { RequestOptions } from '../../../internal/request-options';

export class Profiles extends APIResource {
  /**
   * List Snapchat Public Profiles after OAuth
   */
  list(options?: RequestOptions): APIPromise<ProfileListResponse> {
    return this._client.get('/v1/connect/snapchat/profiles', options);
  }

  /**
   * Select Snapchat Public Profile
   */
  select(body: ProfileSelectParams, options?: RequestOptions): APIPromise<ProfileSelectResponse> {
    return this._client.post('/v1/connect/snapchat/profiles', { body, ...options });
  }
}

export interface ProfileListResponse {
  profiles: Array<ProfileListResponse.Profile>;
}

export namespace ProfileListResponse {
  export interface Profile {
    /**
     * Snapchat profile ID
     */
    id: string;

    /**
     * Display name
     */
    display_name: string;

    /**
     * Snapchat username
     */
    username: string;

    /**
     * Profile image URL
     */
    profile_image_url?: string | null;

    /**
     * Number of subscribers
     */
    subscriber_count?: number;
  }
}

export interface ProfileSelectResponse {
  account: ProfileSelectResponse.Account;
}

export namespace ProfileSelectResponse {
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

export interface ProfileSelectParams {
  /**
   * Token from pending data or OAuth flow
   */
  connect_token: string;

  /**
   * Selected Snapchat profile ID
   */
  profile_id: string;
}

export declare namespace Profiles {
  export {
    type ProfileListResponse as ProfileListResponse,
    type ProfileSelectResponse as ProfileSelectResponse,
    type ProfileSelectParams as ProfileSelectParams,
  };
}
