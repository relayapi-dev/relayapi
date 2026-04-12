// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../../core/resource';
import { APIPromise } from '../../../core/api-promise';
import { RequestOptions } from '../../../internal/request-options';

export class Organizations extends APIResource {
  /**
   * List LinkedIn organizations after OAuth
   */
  list(options?: RequestOptions): APIPromise<OrganizationListResponse> {
    return this._client.get('/v1/connect/linkedin/organizations', options);
  }

  /**
   * Select LinkedIn organization
   */
  select(body: OrganizationSelectParams, options?: RequestOptions): APIPromise<OrganizationSelectResponse> {
    return this._client.post('/v1/connect/linkedin/organizations', { body, ...options });
  }
}

export interface OrganizationListResponse {
  organizations: Array<OrganizationListResponse.Organization>;

  /**
   * User's personal LinkedIn profile
   */
  personal_profile?: OrganizationListResponse.PersonalProfile;
}

export namespace OrganizationListResponse {
  export interface Organization {
    /**
     * Organization name
     */
    name: string;

    /**
     * LinkedIn organization URN
     */
    urn: string;

    /**
     * Organization logo URL
     */
    logo_url?: string | null;

    /**
     * Organization vanity name
     */
    vanity_name?: string | null;
  }

  /**
   * User's personal LinkedIn profile
   */
  export interface PersonalProfile {
    name: string;

    urn: string;
  }
}

export interface OrganizationSelectResponse {
  account: OrganizationSelectResponse.Account;
}

export namespace OrganizationSelectResponse {
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

export interface OrganizationSelectParams {
  /**
   * Whether to connect as a personal profile or organization
   */
  account_type: 'personal' | 'organization';

  /**
   * Token from pending data or OAuth flow
   */
  connect_token: string;

  /**
   * LinkedIn organization URN (required if account_type is organization)
   */
  organization_urn?: string;
}

export declare namespace Organizations {
  export {
    type OrganizationListResponse as OrganizationListResponse,
    type OrganizationSelectResponse as OrganizationSelectResponse,
    type OrganizationSelectParams as OrganizationSelectParams,
  };
}
